/**
 * `rankproof verify` and `rankproof replay` — the end-to-end workflow for a list
 * of known backlinks: CSV → verify → evidence → report of changes.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isResponseHash, responseHash } from "./measurement.server.ts";
import {
  CONTRACT_POLICY,
  compareObservations,
  evaluateContract,
  indexByPair,
  pairKey,
  previousObservations,
  verifiedRowsMarkdown,
  parsePairTable,
  summarize,
  verifiedRowsCsv,
  verifiedRowsHtml,
  CHANGE_LABELS,
  VERDICT_LABELS,
  type ObservationLike,
  type PairRow,
  type VerifiedRow,
  type VerifySummary,
} from "./observe.ts";
import {
  MAX_VERIFY_ITEMS,
  observeRepresentation,
  verifyBacklinks,
  type BacklinkObservation,
  type CapturedRepresentation,
  type RenderMode,
} from "./verify-api.server.ts";

export const VERIFY_RUN_KIND = "rankproof.verify-run" as const;

export type VerifyRun = {
  ok: true;
  kind: typeof VERIFY_RUN_KIND;
  schema_version: "1";
  contract_policy: typeof CONTRACT_POLICY;
  generated_at: string;
  summary: VerifySummary;
  input: {
    rows: number;
    skipped: { line: number; message: string }[];
    duplicates: number;
    /** Pairs taken from --checkpoint instead of being fetched again. */
    resumed?: number;
  };
  results: (BacklinkObservation & { change: VerifiedRow["change"] })[];
};

export { previousObservations };

export async function runVerifyFile(input: {
  table: string;
  previous?: ObservationLike[];
  captureDir?: string | null;
  log?: (message: string) => void;
  /** Re-check pages in headless Chromium: absent/JS-only ("fallback") or all ("always"). */
  render?: RenderMode;
  /**
   * JSONL file appended after every batch. Pairs already in it are not fetched
   * again (unless their stored status is "error"), so an interrupted run
   * resumes where it stopped.
   */
  checkpoint?: string | null;
}): Promise<VerifyRun> {
  const log = input.log ?? (() => {});
  const table = parsePairTable(input.table);
  if (table.rows.length === 0) {
    const first = table.errors[0];
    throw new Error(
      first
        ? `No valid pairs. Line ${first.line}: ${first.message}`
        : "No pairs found. Expected rows of: source_url, target_url[, expected_anchor, expected_rel].",
    );
  }
  for (const error of table.errors) log(`Skipped line ${error.line}: ${error.message}`);
  if (table.duplicates > 0) log(`Ignored ${table.duplicates} duplicate pair(s).`);

  const done = input.checkpoint ? await readCheckpoint(input.checkpoint) : new Map();
  const todo = table.rows.filter((row) => !done.has(pairKey(row.source_url, row.target_url)));
  const resumed = table.rows.length - todo.length;
  if (resumed > 0) log(`Resuming: ${resumed} pair(s) already in ${input.checkpoint}.`);
  if (input.captureDir) await mkdir(input.captureDir, { recursive: true });
  let capturedCount = 0;
  // Hosts are spread across batches: a list with 300 links on one site would
  // otherwise put 50 of them in one batch, queue them behind the per-host
  // limit and time out as errors. Results keep table order below.
  const batches = chunk(interleaveByHost(todo), MAX_VERIFY_ITEMS);
  const started = Date.now();
  let processed = 0;
  let confirmed = 0;
  for (const [index, batch] of batches.entries()) {
    log(
      `Verifying ${batch.length} pair(s)${batches.length > 1 ? ` — batch ${index + 1}/${batches.length}` : ""}…`,
    );
    const captures: CapturedRepresentation[] = [];
    const response = await verifyBacklinks(
      { items: batch.map(toItem) },
      {
        ...(input.captureDir ? { capture: (item) => captures.push(item) } : {}),
        render: input.render ?? "off",
      },
    );
    // Evidence and progress are written per batch: an interruption loses at
    // most one batch, and memory stays bounded on large lists.
    if (input.captureDir) capturedCount += await writeCaptures(input.captureDir, captures);
    if (input.checkpoint) {
      await appendFile(
        input.checkpoint,
        response.results.map((result) => JSON.stringify(result)).join("\n") + "\n",
        "utf8",
      );
    }
    for (const result of response.results) {
      done.set(pairKey(result.source_url, result.target_url), result);
      if (result.status === "confirmed") confirmed += 1;
    }
    processed += batch.length;
    if (batches.length > 1)
      log(progressLine(processed, todo.length, confirmed, Date.now() - started));
  }
  if (input.captureDir && capturedCount > 0) {
    log(`Captured ${capturedCount} HTML representation(s) in ${input.captureDir}`);
  }
  // Table order; a resumed observation is re-judged against the current table's expectations.
  const results: BacklinkObservation[] = table.rows.map((row) => {
    const stored = done.get(pairKey(row.source_url, row.target_url))!;
    const merged = {
      ...stored,
      expected_anchor: row.expected_anchor,
      expected_rel: row.expected_rel,
      expected_placement: row.expected_placement,
    };
    return { ...merged, contract: evaluateContract(merged, merged) };
  });

  const before = indexByPair(input.previous ?? []);
  const rows = results.map((result) => ({
    ...result,
    change: input.previous
      ? compareObservations(before.get(pairKey(result.source_url, result.target_url)), result)
      : null,
  }));
  return {
    ok: true,
    kind: VERIFY_RUN_KIND,
    schema_version: "1",
    contract_policy: CONTRACT_POLICY,
    generated_at: new Date().toISOString(),
    summary: summarize(rows),
    input: {
      rows: table.rows.length,
      skipped: table.errors,
      duplicates: table.duplicates,
      resumed,
    },
    results: rows,
  };
}

async function readCheckpoint(path: string): Promise<Map<string, BacklinkObservation>> {
  const map = new Map<string, BacklinkObservation>();
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    return map;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line) as BacklinkObservation;
      if (typeof item.source_url === "string" && typeof item.target_url === "string") {
        const key = pairKey(item.source_url, item.target_url);
        // A failed observation is not progress: the pair is verified again.
        // The last line for a pair wins, so a later error also undoes a success.
        if (item.status === "error") map.delete(key);
        else map.set(key, item);
      }
    } catch {
      // A line cut off by the interruption: that pair is simply verified again.
    }
  }
  return map;
}

async function writeCaptures(dir: string, captures: CapturedRepresentation[]): Promise<number> {
  const unique = new Map(captures.map((item) => [item.response_hash, item]));
  for (const item of unique.values()) {
    const { body, ...meta } = item;
    await writeFile(join(dir, `${item.response_hash}.html`), body, "utf8");
    await writeFile(
      join(dir, `${item.response_hash}.json`),
      `${JSON.stringify({ ...meta, captured_at: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  }
  return unique.size;
}

function toItem(row: PairRow) {
  return {
    source_url: row.source_url,
    target_url: row.target_url,
    expected_anchor: row.expected_anchor,
    expected_rel: row.expected_rel,
    expected_placement: row.expected_placement,
  };
}

/**
 * Round-robin by source host, keeping each host's rows in their original
 * order: a, a, a, b, c → a, b, c, a, a. Pure; exported for tests.
 */
export function interleaveByHost<T extends { source_url: string }>(rows: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    let host = "";
    try {
      host = new URL(row.source_url).hostname.replace(/^www\./, "");
    } catch {
      host = row.source_url;
    }
    const group = groups.get(host);
    if (group) group.push(row);
    else groups.set(host, [row]);
  }
  const queues = [...groups.values()];
  const out: T[] = [];
  for (let round = 0; out.length < rows.length; round++) {
    for (const queue of queues) if (round < queue.length) out.push(queue[round]!);
  }
  return out;
}

/** "120/300 pairs (40%) · 95 confirmed · about 2 min left" */
export function progressLine(done: number, total: number, confirmed: number, elapsedMs: number) {
  const share = total > 0 ? Math.round((done / total) * 100) : 100;
  const left = done > 0 && done < total ? ((total - done) * elapsedMs) / done : 0;
  const eta =
    left <= 0
      ? ""
      : left < 60_000
        ? ` · about ${Math.max(1, Math.round(left / 1000))} s left`
        : ` · about ${Math.round(left / 60_000)} min left`;
  return `${done}/${total} pairs (${share}%) · ${confirmed} confirmed${eta}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function formatVerifyRun(run: VerifyRun, format: string): string {
  if (format === "json") return JSON.stringify(run, null, 2);
  if (format === "markdown") return verifyRunMarkdown(run);
  if (format === "csv") return verifiedRowsCsv(run.results);
  if (format === "html") return verifiedRowsHtml(run.results, { generatedAt: run.generated_at });
  return verifyRunText(run);
}

export function verifyRunText(run: VerifyRun): string {
  const s = run.summary;
  const lines = [
    `RankProof · ${s.total} pair(s) · ${run.generated_at}`,
    `  ${s.meets} meet the contract · ${s.deviates} deviate · ${s.missing} not in HTML · ${s.unverified} unverified${
      run.results.some((r) => r.change) ? ` · ${s.changed} changed` : ""
    }`,
    "",
  ];
  for (const row of run.results) {
    const mark =
      row.contract.verdict === "meets"
        ? "✓"
        : row.contract.verdict === "deviates"
          ? "≠"
          : row.contract.verdict === "missing"
            ? "✗"
            : "?";
    lines.push(`${mark} ${VERDICT_LABELS[row.contract.verdict].padEnd(15)} ${row.source_url}`);
    lines.push(`    → ${row.target_url}`);
    if (row.status === "confirmed") {
      lines.push(
        `    anchor "${row.anchor ?? ""}" · rel ${row.rel || "(none)"}${row.placement && row.placement !== "unknown" ? ` · in ${row.placement}` : ""}`,
      );
    } else if (row.reason) {
      lines.push(`    ${row.reason}`);
    }
    for (const note of row.contract.notes.slice(0, 2)) lines.push(`    · ${note}`);
    if (row.change && row.change.kind !== "first" && row.change.kind !== "unchanged") {
      lines.push(`    Δ ${CHANGE_LABELS[row.change.kind]}: ${row.change.detail}`);
    }
  }
  return lines.join("\n");
}

export function verifyRunMarkdown(run: VerifyRun): string {
  return verifiedRowsMarkdown(run.results);
}

/** Exit code for `--strict`: 0 only when every pair meets its contract. */
export function strictExitCode(run: VerifyRun): number {
  return run.summary.meets === run.summary.total ? 0 : 3;
}

/**
 * `verify --strict` combined with an exit code already set (4: the webhook
 * failed). A contract failure (3) is the result the caller asked to gate on, so
 * it wins; a passing --strict never clears an earlier failure.
 */
export function combineStrictExitCode(current: number | undefined, run: VerifyRun): number {
  const strict = strictExitCode(run);
  return strict !== 0 ? strict : (current ?? 0);
}

/* ------------------------------------------------------------------ */
/* Replay: re-run extraction on captured HTML, offline                 */
/* ------------------------------------------------------------------ */

export type ReplayRow = {
  source_url: string;
  target_url: string;
  response_hash: string | null;
  outcome: "reproduced" | "differs" | "no_snapshot" | "integrity_failed";
  recorded: { status: string; anchor: string | null; rel: string | null };
  replayed: { status: string; anchor: string | null; rel: string | null } | null;
  detail: string;
};

export async function replayRun(
  json: unknown,
  captureDir: string,
  options: { render?: boolean } = {},
): Promise<{
  ok: true;
  kind: "rankproof.replay";
  generated_at: string;
  summary: Record<ReplayRow["outcome"], number>;
  results: ReplayRow[];
}> {
  const recorded = previousObservations(json) as BacklinkObservation[];
  const results: ReplayRow[] = [];
  for (const item of recorded) {
    const base = {
      source_url: item.source_url,
      target_url: item.target_url,
      response_hash: item.response_hash ?? null,
      recorded: { status: item.status, anchor: item.anchor, rel: item.rel },
    };
    if (!item.response_hash) {
      results.push({
        ...base,
        outcome: "no_snapshot",
        replayed: null,
        detail: "No response body was recorded for this observation (e.g. a network error).",
      });
      continue;
    }
    if (!isResponseHash(item.response_hash)) {
      results.push({
        ...base,
        outcome: "integrity_failed",
        replayed: null,
        detail: "The recorded response_hash is not a SHA-256 hex digest.",
      });
      continue;
    }
    let body: string;
    let meta: { final_url: string; http_status: number; content_type: string };
    try {
      body = await readFile(join(captureDir, `${item.response_hash}.html`), "utf8");
      meta = JSON.parse(await readFile(join(captureDir, `${item.response_hash}.json`), "utf8"));
    } catch {
      results.push({
        ...base,
        outcome: "no_snapshot",
        replayed: null,
        detail: "Snapshot not found in the capture directory.",
      });
      continue;
    }
    if (responseHash(body) !== item.response_hash) {
      results.push({
        ...base,
        outcome: "integrity_failed",
        replayed: null,
        detail: "The snapshot's SHA-256 no longer matches the recorded response_hash.",
      });
      continue;
    }
    // Snapshots are content-addressed, so two responses with identical bytes
    // (an empty 403 and an empty 404, say) share one file and one metadata
    // record. The observation's own status and final URL are authoritative.
    const replayed = observeRepresentation(item, {
      text: body,
      finalUrl: item.final_url ?? meta.final_url,
      status: item.http_status ?? meta.http_status,
      contentType: meta.content_type,
      checkedAt: item.checked_at,
    });
    let renderNote = "";
    let renderDiffers = false;
    if (options.render && item.rendered) {
      const { renderObserve } = await import("./render.server.ts");
      const [again] = await renderObserve([
        {
          source_url: item.source_url,
          target_url: item.target_url,
          snapshot: {
            html: body,
            status: item.http_status ?? meta.http_status,
            final_url: item.final_url ?? meta.final_url,
          },
        },
      ]);
      renderDiffers =
        again!.status !== item.rendered.status ||
        (again!.visible ?? null) !== (item.rendered.visible ?? null);
      renderNote = ` Offline render of the stored HTML (inline scripts only): ${again!.status}${
        again!.visible === false ? ", hidden" : ""
      } vs recorded ${item.rendered.status}.`;
    }
    const same =
      !renderDiffers &&
      replayed.status === item.status &&
      (replayed.anchor ?? null) === (item.anchor ?? null) &&
      (replayed.rel ?? null) === (item.rel ?? null);
    results.push({
      ...base,
      outcome: same ? "reproduced" : "differs",
      replayed: { status: replayed.status, anchor: replayed.anchor, rel: replayed.rel },
      detail:
        (same
          ? `Same verdict from the stored representation (extractor ${replayed.extraction_version}).`
          : `Current extractor (${replayed.extraction_version}) reads the stored HTML differently: ${replayed.status} vs recorded ${item.status}.`) +
        renderNote,
    });
  }
  const summary = { reproduced: 0, differs: 0, no_snapshot: 0, integrity_failed: 0 };
  for (const row of results) summary[row.outcome] += 1;
  return {
    ok: true,
    kind: "rankproof.replay",
    generated_at: new Date().toISOString(),
    summary,
    results,
  };
}

export function replayText(run: Awaited<ReturnType<typeof replayRun>>): string {
  const s = run.summary;
  const lines = [
    `RankProof replay · ${run.results.length} observation(s)`,
    `  ${s.reproduced} reproduced · ${s.differs} differ · ${s.no_snapshot} without snapshot · ${s.integrity_failed} integrity failures`,
    "",
  ];
  for (const row of run.results) {
    lines.push(`${row.outcome.padEnd(16)} ${row.source_url} → ${row.target_url}`);
    lines.push(`    ${row.detail}`);
  }
  return lines.join("\n");
}
