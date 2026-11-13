/**
 * Saved link lists ("monitors") and their runs, per user, in Postgres.
 *
 * Every function takes the caller's verified user id and scopes every query by
 * it; a monitor id from another user behaves exactly like a missing one. The
 * SQL handle is passed in so the module runs against Neon, PGLite or a test
 * database alike.
 */
import {
  compareObservations,
  evaluateContract,
  pairKey,
  parsePairTable,
  summarize,
  type ObservationLike,
  type VerifiedRow,
  type VerifySummary,
} from "./observe.ts";
import { guardUrl } from "./ssrf.ts";
import type { BacklinkObservation } from "./verify-api.server.ts";

export const SCHEDULES = ["off", "daily", "weekly"] as const;
export type Schedule = (typeof SCHEDULES)[number];
const INTERVAL_MS: Record<Exclude<Schedule, "off">, number> = {
  daily: 24 * 3600_000,
  weekly: 7 * 24 * 3600_000,
};

/** When a list on `schedule` should run next, counted from `from`. */
export function nextRunAt(schedule: Schedule, from: Date): Date | null {
  return schedule === "off" ? null : new Date(from.getTime() + INTERVAL_MS[schedule]);
}

export type MonitorSql = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T[]>;

/** Pairs per monitor: one server request verifies them all, in batches of 50. */
export const MAX_MONITOR_PAIRS = 200;
export const MAX_MONITORS_PER_USER = 50;
/** Runs kept per monitor; older ones are pruned after each run. */
export const MAX_MONITOR_RUNS = 30;
const MAX_NAME = 80;
const MAX_TABLE_CHARS = 200_000;

export type MonitorListItem = {
  id: number;
  name: string;
  pairs: number;
  schedule: Schedule;
  /** Host of the webhook only; the full URL can hold a secret token. */
  webhook_host: string | null;
  next_run_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  last_run: { id: number; ran_at: string; summary: VerifySummary } | null;
};

export type MonitorRun = {
  id: number;
  ran_at: string;
  summary: VerifySummary;
  results: VerifiedRow[];
};

export class MonitorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonitorInputError";
  }
}

/** Validates a name and a pair table; returns the cleaned values. */
export function validateMonitor(input: {
  name?: unknown;
  pairs?: unknown;
  schedule?: unknown;
  webhook_url?: unknown;
}): {
  name: string;
  pairs: string;
  count: number;
  schedule: Schedule;
  webhook_url: string | null;
} {
  const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
  if (!name) throw new MonitorInputError("Give the list a name.");
  if (name.length > MAX_NAME)
    throw new MonitorInputError(`Names are at most ${MAX_NAME} characters.`);
  const pairs = typeof input.pairs === "string" ? input.pairs : "";
  if (pairs.length > MAX_TABLE_CHARS) {
    throw new MonitorInputError("The table is too large to save. Use the CLI for big lists.");
  }
  const table = parsePairTable(pairs);
  if (table.rows.length === 0) {
    const first = table.errors[0];
    throw new MonitorInputError(
      first
        ? `Line ${first.line}: ${first.message}`
        : "Add at least one row: source URL, target URL.",
    );
  }
  if (table.rows.length > MAX_MONITOR_PAIRS) {
    throw new MonitorInputError(
      `${table.rows.length} pairs is more than a saved list holds (${MAX_MONITOR_PAIRS}). Split it, or use rankproof verify --history.`,
    );
  }
  const schedule = (input.schedule ?? "off") as Schedule;
  if (!SCHEDULES.includes(schedule)) throw new MonitorInputError("Unknown schedule.");
  const rawHook = typeof input.webhook_url === "string" ? input.webhook_url.trim() : "";
  let webhook_url: string | null = null;
  if (rawHook) {
    let url: URL;
    try {
      url = new URL(rawHook);
    } catch {
      throw new MonitorInputError("The webhook must be a full https:// URL.");
    }
    if (url.protocol !== "https:") throw new MonitorInputError("The webhook must use https://.");
    if (rawHook.length > 1000) throw new MonitorInputError("The webhook URL is too long.");
    const verdict = guardUrl(url.href);
    if (!verdict.allowed) throw new MonitorInputError(`Webhook refused: ${verdict.reason}`);
    webhook_url = url.href;
  }
  return { name, pairs: pairs.trim(), count: table.rows.length, schedule, webhook_url };
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function json<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

export async function listMonitors(sql: MonitorSql, userId: string): Promise<MonitorListItem[]> {
  const rows = await sql<{
    id: number;
    name: string;
    pairs: string;
    schedule: Schedule;
    webhook_url: string | null;
    next_run_at: unknown;
    last_error: string | null;
    created_at: unknown;
    updated_at: unknown;
    run_id: number | null;
    ran_at: unknown;
    summary: unknown;
  }>`
    select m.id, m.name, m.pairs, m.schedule, m.webhook_url, m.next_run_at, m.last_error,
           m.created_at, m.updated_at,
           r.id as run_id, r.ran_at, r.summary
    from link_monitors m
    left join lateral (
      select id, ran_at, summary from link_monitor_runs
      where monitor_id = m.id and user_id = ${userId}
      order by ran_at desc, id desc limit 1
    ) r on true
    where m.user_id = ${userId}
    order by m.updated_at desc, m.id desc
  `;
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    pairs: parsePairTable(row.pairs).rows.length,
    schedule: row.schedule,
    webhook_host: hostOf(row.webhook_url),
    next_run_at: row.next_run_at ? iso(row.next_run_at) : null,
    last_error: row.last_error,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    last_run:
      row.run_id === null
        ? null
        : { id: Number(row.run_id), ran_at: iso(row.ran_at), summary: json(row.summary) },
  }));
}

export async function getMonitor(
  sql: MonitorSql,
  userId: string,
  id: number,
): Promise<MonitorRecord | null> {
  const [row] = await sql<MonitorRecord>`
    select id, name, pairs, schedule, webhook_url from link_monitors
    where id = ${id} and user_id = ${userId}
  `;
  return row ? { ...row, id: Number(row.id) } : null;
}

export type MonitorRecord = {
  id: number;
  name: string;
  pairs: string;
  schedule: Schedule;
  webhook_url: string | null;
};

/** Creates a monitor, or updates one the user owns when `id` is given. */
export async function saveMonitor(
  sql: MonitorSql,
  userId: string,
  input: {
    id?: number | null;
    name?: unknown;
    pairs?: unknown;
    schedule?: unknown;
    webhook_url?: unknown;
  },
  now: Date = new Date(),
): Promise<{ id: number }> {
  const clean = validateMonitor(input);
  const next = nextRunAt(clean.schedule, now)?.toISOString() ?? null;
  if (input.id) {
    // A changed schedule restarts its clock; an unchanged one keeps its slot.
    const rows = await sql<{ id: number }>`
      update link_monitors set
        name = ${clean.name}, pairs = ${clean.pairs}, webhook_url = ${clean.webhook_url},
        next_run_at = case when schedule = ${clean.schedule} and next_run_at is not null
                           then next_run_at else ${next}::timestamptz end,
        schedule = ${clean.schedule}, last_error = null, updated_at = now()
      where id = ${input.id} and user_id = ${userId}
      returning id
    `;
    if (!rows[0]) throw new MonitorInputError("That list does not exist.");
    return { id: Number(rows[0].id) };
  }
  const [count] = await sql<{ n: number }>`
    select count(*)::int as n from link_monitors where user_id = ${userId}
  `;
  if (Number(count?.n ?? 0) >= MAX_MONITORS_PER_USER) {
    throw new MonitorInputError(`You can keep up to ${MAX_MONITORS_PER_USER} lists.`);
  }
  const [row] = await sql<{ id: number }>`
    insert into link_monitors (user_id, name, pairs, schedule, webhook_url, next_run_at)
    values (${userId}, ${clean.name}, ${clean.pairs}, ${clean.schedule}, ${clean.webhook_url},
            ${next}::timestamptz)
    returning id
  `;
  return { id: Number(row!.id) };
}

export async function deleteMonitor(sql: MonitorSql, userId: string, id: number): Promise<boolean> {
  const rows = await sql<{ id: number }>`
    delete from link_monitors where id = ${id} and user_id = ${userId} returning id
  `;
  return rows.length > 0;
}

export async function monitorRuns(
  sql: MonitorSql,
  userId: string,
  id: number,
  limit = MAX_MONITOR_RUNS,
): Promise<MonitorRun[]> {
  const rows = await sql<{ id: number; ran_at: unknown; summary: unknown; results: unknown }>`
    select id, ran_at, summary, results from link_monitor_runs
    where monitor_id = ${id} and user_id = ${userId}
    order by ran_at desc, id desc
    limit ${Math.max(1, Math.min(limit, MAX_MONITOR_RUNS))}
  `;
  return rows.map((row) => ({
    id: Number(row.id),
    ran_at: iso(row.ran_at),
    summary: json(row.summary),
    results: json(row.results),
  }));
}

/** What a stored run keeps per pair: enough to compare and to show a receipt. */
function slim(row: BacklinkObservation & { contract?: VerifiedRow["contract"] }): VerifiedRow {
  return {
    source_url: row.source_url,
    target_url: row.target_url,
    status: row.status,
    checked_at: row.checked_at,
    anchor: row.anchor,
    rel: row.rel,
    reason: row.reason,
    absence_scope: row.absence_scope,
    resolved_href: row.resolved_href,
    response_hash: row.response_hash,
    placement: row.placement,
    context: row.context,
    mentions: row.mentions?.slice(0, 5),
    near_matches: row.near_matches?.slice(0, 5),
    rendered: row.rendered ?? null,
    http_status: row.http_status,
    final_url: row.final_url,
    expected_anchor: row.expected_anchor,
    expected_rel: row.expected_rel,
    expected_placement: row.expected_placement,
    contract: row.contract ?? evaluateContract(row, row),
  } as VerifiedRow;
}

/**
 * Verifies a monitor's pairs now, compares with its previous run, stores the
 * run and prunes old ones. `verify` is injected (tests run offline).
 */
export async function runMonitor(
  sql: MonitorSql,
  userId: string,
  id: number,
  verify: (items: Record<string, unknown>[]) => Promise<BacklinkObservation[]>,
): Promise<MonitorRun & { compared_with: string | null }> {
  const monitor = await getMonitor(sql, userId, id);
  if (!monitor) throw new MonitorInputError("That list does not exist.");
  const table = parsePairTable(monitor.pairs);
  const rows = table.rows.slice(0, MAX_MONITOR_PAIRS);
  const results: BacklinkObservation[] = [];
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50).map((row) => ({
      source_url: row.source_url,
      target_url: row.target_url,
      ...(row.expected_anchor ? { expected_anchor: row.expected_anchor } : {}),
      ...(row.expected_rel ? { expected_rel: row.expected_rel } : {}),
      ...(row.expected_placement ? { expected_placement: row.expected_placement } : {}),
    }));
    results.push(...(await verify(batch)));
  }
  const [previous] = await monitorRuns(sql, userId, id, 1);
  const before = new Map<string, ObservationLike>(
    (previous?.results ?? []).map((row) => [pairKey(row.source_url, row.target_url), row]),
  );
  const verified: VerifiedRow[] = results.map((result) => {
    const row = slim(result);
    return {
      ...row,
      change: previous
        ? compareObservations(before.get(pairKey(row.source_url, row.target_url)), row)
        : null,
    };
  });
  const summary = summarize(verified);
  const [stored] = await sql<{ id: number; ran_at: unknown }>`
    insert into link_monitor_runs (monitor_id, user_id, summary, results)
    values (${id}, ${userId}, ${JSON.stringify(summary)}::jsonb, ${JSON.stringify(verified)}::jsonb)
    returning id, ran_at
  `;
  await sql`
    delete from link_monitor_runs
    where monitor_id = ${id} and user_id = ${userId} and id not in (
      select id from link_monitor_runs where monitor_id = ${id} and user_id = ${userId}
      order by ran_at desc, id desc limit ${MAX_MONITOR_RUNS}
    )
  `;
  await sql`update link_monitors set updated_at = now() where id = ${id} and user_id = ${userId}`;
  return {
    id: Number(stored!.id),
    ran_at: iso(stored!.ran_at),
    summary,
    results: verified,
    compared_with: previous?.ran_at ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Scheduled runs                                                      */
/* ------------------------------------------------------------------ */

export type ScheduledReport = {
  ran: { id: number; changed: number; notified: boolean | null; error: string | null }[];
  /** Lists still due when the time or count limit was reached. */
  remaining: number;
};

const breakBroadcast = (value: string) => value.replace(/@(everyone|here|channel)/gi, "@\u200b$1");
/** Slack mrkdwn: `&`, `<`, `>` escaped, so `<!channel>`, `<@U…>` and `<url|label>` stay text. */
export function slackSafe(value: string): string {
  return breakBroadcast(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/** Discord markdown: `<@id>`, `<#id>` and masked `[label](url)` links stay text. */
export function discordSafe(value: string): string {
  return breakBroadcast(value).replace(/[\\<>[\]]/g, "\\$&");
}

/**
 * Summary for Slack/Discord-style webhooks; null when nothing changed. Change
 * details quote publisher-controlled text (anchor, rel), so `text` (Slack) and
 * `content` (Discord) are escaped for their markup and Discord mentions are off.
 */
export function monitorWebhookPayload(
  name: string,
  run: MonitorRun & { compared_with: string | null },
  link: string | null,
) {
  if (!run.compared_with) return null;
  const changes = run.results.filter((row) => {
    const kind = row.change?.kind;
    return kind && kind !== "first" && kind !== "unchanged" && kind !== "still_unverified";
  });
  if (changes.length === 0) return null;
  const s = run.summary;
  const head = `RankProof · ${name}: ${changes.length} link change(s) — ${s.meets} meet, ${s.deviates} deviate, ${s.missing} not in HTML, ${s.unverified} unverified.`;
  const lines = changes
    .slice(0, 15)
    .map((row) => `• ${row.change!.detail} ${row.source_url} → ${row.target_url}`);
  const more = changes.length > 15 ? [`… and ${changes.length - 15} more`] : [];
  const render = (escape: (value: string) => string) =>
    [...[head, ...lines, ...more].map(escape), ...(link ? [link] : [])].join("\n");
  return {
    kind: "rankproof.monitor-changes",
    monitor: name,
    generated_at: run.ran_at,
    text: render(slackSafe),
    content: render(discordSafe).slice(0, 1900),
    allowed_mentions: { parse: [] as string[] },
    summary: s,
    changes: changes.map((row) => ({
      source_url: row.source_url,
      target_url: row.target_url,
      change: row.change!.kind,
      detail: row.change!.detail,
      verdict: row.contract.verdict,
    })),
  };
}

/**
 * Runs lists whose next_run_at has passed. Each list is claimed first (its
 * next_run_at moved forward only if it still holds the value we read), so two
 * overlapping cron calls never run the same list twice. A failure is stored in
 * last_error and never stops the other lists.
 */
export async function runDueMonitors(
  sql: MonitorSql,
  options: {
    verify: (items: Record<string, unknown>[]) => Promise<BacklinkObservation[]>;
    notify?: (
      url: string,
      payload: NonNullable<ReturnType<typeof monitorWebhookPayload>>,
    ) => Promise<void>;
    now?: () => Date;
    maxLists?: number;
    budgetMs?: number;
    link?: string | null;
  },
): Promise<ScheduledReport> {
  const now = options.now ?? (() => new Date());
  const started = now().getTime();
  const maxLists = options.maxLists ?? 5;
  const budget = options.budgetMs ?? 240_000;
  const report: ScheduledReport = { ran: [], remaining: 0 };
  const due = await sql<{
    id: number;
    user_id: string;
    name: string;
    schedule: Schedule;
    webhook_url: string | null;
    next_run_at: unknown;
  }>`
    select id, user_id, name, schedule, webhook_url, next_run_at from link_monitors
    where schedule <> 'off' and next_run_at is not null and next_run_at <= ${now().toISOString()}::timestamptz
    order by next_run_at, id
    limit ${maxLists + 50}
  `;
  for (const [index, row] of due.entries()) {
    if (report.ran.length >= maxLists || now().getTime() - started > budget) {
      report.remaining = due.length - index;
      break;
    }
    const next = nextRunAt(row.schedule, now());
    const claimed = await sql<{ id: number }>`
      update link_monitors set next_run_at = ${next!.toISOString()}::timestamptz
      where id = ${row.id} and next_run_at = ${iso(row.next_run_at)}::timestamptz
      returning id
    `;
    if (claimed.length === 0) continue; // another invocation took it
    const id = Number(row.id);
    try {
      const run = await runMonitor(sql, row.user_id, id, options.verify);
      let notified: boolean | null = null;
      let error: string | null = null;
      const payload = monitorWebhookPayload(row.name, run, options.link ?? null);
      if (payload && row.webhook_url && options.notify) {
        try {
          await options.notify(row.webhook_url, payload);
          notified = true;
        } catch (err) {
          notified = false;
          error = `Webhook failed: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            300,
          );
        }
      }
      await sql`update link_monitors set last_error = ${error} where id = ${id}`;
      report.ran.push({ id, changed: run.summary.changed, notified, error });
    } catch (err) {
      const error =
        `Scheduled run failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
      await sql`update link_monitors set last_error = ${error} where id = ${id}`;
      report.ran.push({ id, changed: 0, notified: null, error });
    }
  }
  return report;
}
