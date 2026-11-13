/**
 * Real-world benchmark corpora. `rankproof corpus run.json --capture-dir ev`
 * turns a captured run into labelling material: each case carries the exact
 * HTML that was verified and RankProof's verdict as a *suggestion*. A person
 * opens the page (or the snapshot), corrects `expected` where needed and sets
 * `reviewed: true`. Only reviewed cases are scored by
 * `npm run benchmark -- --corpus cases.json`, so the tool never grades itself.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { previousObservations } from "./observe.ts";
import { isResponseHash, responseHash } from "./measurement.server.ts";
import type { BenchmarkCase } from "./fixtures/verify-benchmark.ts";

export type CorpusCase = BenchmarkCase & {
  reviewed: boolean;
  /** RankProof's verdict when the corpus was built — what the labeller checks. */
  suggested: BenchmarkCase["expected"];
  response_hash: string;
  captured_at: string | null;
  note?: string;
};

export type Corpus = {
  kind: "rankproof.corpus";
  version: 1;
  instructions: string;
  cases: CorpusCase[];
};

const INSTRUCTIONS =
  "For each case, open the snapshot (or the source page at captured_at) and decide whether an <a> element with the exact target URL is present in the HTML. Set expected.status to confirmed, not_found or error (error only when the page could not be read), correct anchor/rel if needed, add a note for anything unusual, and set reviewed to true. Do not copy `suggested` without looking: unreviewed cases are not scored.";

export async function buildCorpus(runJson: unknown, captureDir: string): Promise<Corpus> {
  const cases: CorpusCase[] = [];
  const seen = new Set<string>();
  for (const item of previousObservations(runJson) as (ReturnType<
    typeof previousObservations
  >[number] & {
    final_url?: string | null;
    http_status?: number | null;
  })[]) {
    // The hash names files in captureDir: anything but a SHA-256 hex digest is skipped.
    if (!isResponseHash(item.response_hash)) continue;
    // The whole target URL is hashed: a prefix of it collides for long shared prefixes.
    const targetId = createHash("sha256").update(item.target_url).digest("hex").slice(0, 16);
    const id = `${item.response_hash.slice(0, 12)}-${targetId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let html: string;
    let meta: {
      final_url?: string;
      http_status?: number;
      content_type?: string;
      captured_at?: string;
    };
    try {
      html = await readFile(join(captureDir, `${item.response_hash}.html`), "utf8");
      meta = JSON.parse(await readFile(join(captureDir, `${item.response_hash}.json`), "utf8"));
    } catch {
      continue;
    }
    // A snapshot edited after capture is not labelling material.
    if (responseHash(html) !== item.response_hash) continue;
    const suggested: BenchmarkCase["expected"] = {
      status: item.status,
      ...(item.status === "confirmed" ? { anchor: item.anchor ?? "", rel: item.rel ?? "" } : {}),
    };
    cases.push({
      id,
      category: "identity",
      description: `${item.source_url} → ${item.target_url}`,
      source_url: item.source_url,
      target_url: item.target_url,
      final_url: meta.final_url ?? item.final_url ?? item.source_url,
      status: meta.http_status ?? item.http_status ?? 200,
      content_type: meta.content_type ?? "text/html",
      html,
      expected: { status: item.status },
      suggested,
      reviewed: false,
      response_hash: item.response_hash,
      captured_at: meta.captured_at ?? item.checked_at ?? null,
    });
  }
  return { kind: "rankproof.corpus", version: 1, instructions: INSTRUCTIONS, cases };
}

export function loadCorpus(json: unknown): { scored: BenchmarkCase[]; unreviewed: number } {
  const corpus = json as Partial<Corpus>;
  if (corpus?.kind !== "rankproof.corpus" || !Array.isArray(corpus.cases)) {
    throw new Error("Not a RankProof corpus file (kind: rankproof.corpus).");
  }
  const scored = corpus.cases.filter((c) => c && c.reviewed === true);
  for (const c of scored) {
    if (!["confirmed", "not_found", "error"].includes(c.expected?.status)) {
      throw new Error(`Case ${c.id}: expected.status must be confirmed, not_found or error.`);
    }
  }
  return { scored, unreviewed: corpus.cases.length - scored.length };
}
