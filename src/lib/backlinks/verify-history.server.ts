/**
 * Local monitoring for `rankproof verify --history <dir>`: every run is stored
 * as a JSON document, the next run is compared with the latest one, fetched
 * HTML is kept as evidence, and `rankproof history <dir>` summarises each pair
 * over time. No database or scheduler is required — run it from cron.
 *
 *   <dir>/runs/2026-11-12T09-00-00-000Z.json   one document per run
 *   <dir>/evidence/<sha256>.html (+ .json)      captured representations
 */
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { guardUrl } from "./ssrf.ts";
import {
  CHANGE_LABELS,
  VERDICT_LABELS,
  pairKey,
  previousObservations,
  type ChangeKind,
  type ContractVerdict,
  type ObservationLike,
} from "./observe.ts";
import type { VerifyRun } from "./verify-run.server.ts";

export const DEFAULT_KEEP_RUNS = 200;

export const historyPaths = (dir: string) => ({
  runs: join(dir, "runs"),
  evidence: join(dir, "evidence"),
});

function runFileName(generatedAt: string): string {
  return `${generatedAt.replace(/[:.]/g, "-")}.json`;
}

async function listRunFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(historyPaths(dir).runs))
      .filter((name) => /^\d{4}-\d{2}-\d{2}T.*\.json$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

/** The most recent stored run, or null for a new history directory. */
export async function loadLatestRun(
  dir: string,
): Promise<{ file: string; results: ObservationLike[] } | null> {
  const files = await listRunFiles(dir);
  const last = files.at(-1);
  if (!last) return null;
  const json = JSON.parse(await readFile(join(historyPaths(dir).runs, last), "utf8"));
  return { file: last, results: previousObservations(json) };
}

/** Stores a run and prunes the oldest documents beyond `keep` (evidence is kept). */
export async function saveRun(
  dir: string,
  run: VerifyRun,
  keep = DEFAULT_KEEP_RUNS,
): Promise<string> {
  const { runs } = historyPaths(dir);
  await mkdir(runs, { recursive: true });
  const name = runFileName(run.generated_at);
  await writeFile(join(runs, name), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  const files = await listRunFiles(dir);
  for (const old of files.slice(0, Math.max(0, files.length - keep))) {
    await unlink(join(runs, old)).catch(() => {});
  }
  return join(runs, name);
}

/* ------------------------------------------------------------------ */
/* Per-pair timeline                                                   */
/* ------------------------------------------------------------------ */

export type PairHistory = {
  source_url: string;
  target_url: string;
  runs: number;
  first_checked: string;
  last_checked: string;
  last_status: ObservationLike["status"];
  last_verdict: ContractVerdict | null;
  /** Share of runs (excluding errors) in which the link was confirmed. */
  confirmed_share: number | null;
  errors: number;
  /** When the link was last confirmed, if ever. */
  last_confirmed: string | null;
  /** Consecutive most-recent runs with the same status. */
  streak: number;
  changes: { at: string; kind: ChangeKind; detail: string }[];
};

export type HistoryReport = {
  ok: true;
  kind: "rankproof.verify-history";
  generated_at: string;
  runs: number;
  first_run: string | null;
  last_run: string | null;
  pairs: PairHistory[];
};

type StoredRow = ObservationLike & {
  contract?: { verdict?: ContractVerdict };
  change?: { kind: ChangeKind; detail: string } | null;
};

export async function buildHistory(dir: string): Promise<HistoryReport> {
  const files = await listRunFiles(dir);
  const pairs = new Map<string, PairHistory & { confirmedRuns: number; observedRuns: number }>();
  let firstRun: string | null = null;
  let lastRun: string | null = null;
  for (const file of files) {
    let json: { generated_at?: string; results?: StoredRow[] };
    try {
      json = JSON.parse(await readFile(join(historyPaths(dir).runs, file), "utf8"));
    } catch {
      continue;
    }
    const at = json.generated_at ?? file;
    firstRun ??= at;
    lastRun = at;
    for (const row of (json.results ?? []) as StoredRow[]) {
      if (!row || typeof row.source_url !== "string") continue;
      const key = pairKey(row.source_url, row.target_url);
      const entry =
        pairs.get(key) ??
        ({
          source_url: row.source_url,
          target_url: row.target_url,
          runs: 0,
          first_checked: row.checked_at,
          last_checked: row.checked_at,
          last_status: row.status,
          last_verdict: null,
          confirmed_share: null,
          errors: 0,
          last_confirmed: null,
          streak: 0,
          changes: [],
          confirmedRuns: 0,
          observedRuns: 0,
        } as PairHistory & { confirmedRuns: number; observedRuns: number });
      entry.runs += 1;
      entry.streak = entry.runs > 1 && entry.last_status === row.status ? entry.streak + 1 : 1;
      entry.last_checked = row.checked_at;
      entry.last_status = row.status;
      entry.last_verdict = row.contract?.verdict ?? null;
      if (row.status === "error") entry.errors += 1;
      else entry.observedRuns += 1;
      if (row.status === "confirmed") {
        entry.confirmedRuns += 1;
        entry.last_confirmed = row.checked_at;
      }
      const kind = row.change?.kind;
      if (kind && kind !== "first" && kind !== "unchanged" && kind !== "still_unverified") {
        entry.changes.push({ at: row.checked_at, kind, detail: row.change!.detail });
      }
      pairs.set(key, entry);
    }
  }
  return {
    ok: true,
    kind: "rankproof.verify-history",
    generated_at: new Date().toISOString(),
    runs: files.length,
    first_run: firstRun,
    last_run: lastRun,
    pairs: [...pairs.values()].map(({ confirmedRuns, observedRuns, ...rest }) => ({
      ...rest,
      confirmed_share:
        observedRuns > 0 ? Math.round((confirmedRuns / observedRuns) * 100) / 100 : null,
      changes: rest.changes.slice(-20),
    })),
  };
}

export function historyText(report: HistoryReport): string {
  if (report.runs === 0)
    return "No runs stored yet. Run `rankproof verify links.csv --history <dir>` first.";
  const lines = [
    `RankProof history · ${report.runs} run(s) · ${report.first_run} → ${report.last_run}`,
    "",
  ];
  for (const pair of report.pairs) {
    const verdict = pair.last_verdict ? VERDICT_LABELS[pair.last_verdict] : pair.last_status;
    const share =
      pair.confirmed_share === null
        ? "never observed"
        : `confirmed in ${Math.round(pair.confirmed_share * 100)}% of observed runs`;
    lines.push(`${verdict.padEnd(15)} ${pair.source_url} → ${pair.target_url}`);
    lines.push(
      `    ${pair.runs} run(s), ${share}${pair.errors ? `, ${pair.errors} failed run(s)` : ""}; same status for the last ${pair.streak}.`,
    );
    if (pair.last_status !== "confirmed" && pair.last_confirmed) {
      lines.push(`    Last confirmed ${pair.last_confirmed}.`);
    }
    for (const change of pair.changes.slice(-3)) {
      lines.push(`    ${change.at}  ${CHANGE_LABELS[change.kind]}: ${change.detail}`);
    }
  }
  return lines.join("\n");
}

export function historyCsv(report: HistoryReport): string {
  const head = [
    "source_url",
    "target_url",
    "runs",
    "last_status",
    "last_verdict",
    "confirmed_share",
    "failed_runs",
    "last_confirmed",
    "streak",
    "last_change",
    "last_change_at",
  ];
  const cell = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [
    head.join(","),
    ...report.pairs.map((pair) =>
      [
        pair.source_url,
        pair.target_url,
        pair.runs,
        pair.last_status,
        pair.last_verdict ?? "",
        pair.confirmed_share ?? "",
        pair.errors,
        pair.last_confirmed ?? "",
        pair.streak,
        pair.changes.at(-1)?.kind ?? "",
        pair.changes.at(-1)?.at ?? "",
      ]
        .map(cell)
        .join(","),
    ),
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Webhook notification                                                */
/* ------------------------------------------------------------------ */

export type WebhookPayload = {
  kind: "rankproof.verify-changes";
  generated_at: string;
  /** Plain-text summary; Slack, Mattermost and Discord-style hooks display it as is. */
  text: string;
  content: string;
  summary: VerifyRun["summary"];
  changes: {
    source_url: string;
    target_url: string;
    change: ChangeKind;
    detail: string;
    verdict: ContractVerdict;
  }[];
};

export function webhookPayload(run: VerifyRun): WebhookPayload | null {
  const changes = run.results
    .filter((row) => {
      const kind = row.change?.kind;
      return kind && kind !== "first" && kind !== "unchanged" && kind !== "still_unverified";
    })
    .map((row) => ({
      source_url: row.source_url,
      target_url: row.target_url,
      change: row.change!.kind,
      detail: row.change!.detail,
      verdict: row.contract.verdict,
    }));
  if (changes.length === 0) return null;
  const s = run.summary;
  const head = `RankProof: ${changes.length} link change(s) — ${s.meets} meet, ${s.deviates} deviate, ${s.missing} not in HTML, ${s.unverified} unverified.`;
  const body = changes
    .slice(0, 15)
    .map((c) => `• ${CHANGE_LABELS[c.change]}: ${c.source_url} → ${c.target_url}`)
    .join("\n");
  const text = `${head}\n${body}${changes.length > 15 ? `\n… and ${changes.length - 15} more` : ""}`;
  return {
    kind: "rankproof.verify-changes",
    generated_at: run.generated_at,
    text,
    content: text.slice(0, 1900),
    summary: run.summary,
    changes,
  };
}

/**
 * The webhook URL comes from the operator's command line, but it is still an
 * outbound request: private and metadata addresses need an explicit opt-in.
 */
export function assertWebhookUrl(raw: string): void {
  if (process.env.RANKPROOF_WEBHOOK_ALLOW_PRIVATE === "1") {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error("Webhook must be http(s).");
    return;
  }
  const verdict = guardUrl(raw);
  if (!verdict.allowed) {
    throw new Error(
      `Webhook URL refused: ${verdict.reason} Set RANKPROOF_WEBHOOK_ALLOW_PRIVATE=1 for an internal endpoint.`,
    );
  }
}

export async function sendWebhook(
  url: string,
  payload: WebhookPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  assertWebhookUrl(url);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10_000);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "RankProof/webhook" },
      body: JSON.stringify(payload),
      signal: abort.signal,
      redirect: "error",
    });
    if (!res.ok) throw new Error(`Webhook returned HTTP ${res.status}.`);
    return res.status;
  } finally {
    clearTimeout(timer);
  }
}
