/** Versioned measurement facts, separate from provider assertions and heuristic scores. */
import { createHash } from "node:crypto";
import { DOMAIN_POLICY, URL_IDENTITY_POLICY } from "./parse.ts";
import type { Backlink, DiscoverySource, SerpQuery } from "./types.ts";
import type { DomainEdge } from "./graph.ts";

export const EXTRACTION_VERSION = "html-anchor-v5";
export const SCORE_VERSION = "local-graph-heuristic-v1";
export const sourceRevision = () => process.env.RANKPROOF_SERVICE_REVISION?.trim() || null;
export const responseHash = (text: string) => createHash("sha256").update(text).digest("hex");

export function linkEvidence(
  kind: "provider_report" | "html_anchor" | "archive_anchor",
  requestedSourceUrl: string,
  resolvedSourceUrl: string,
  resolvedHref: string,
  rawHref: string | null = null,
  body: string | null = null,
): NonNullable<Backlink["evidence"]> {
  return {
    kind,
    method:
      kind === "provider_report"
        ? "provider_api"
        : kind === "html_anchor"
          ? "fetched_html"
          : "archive_html",
    observedAt: new Date().toISOString(),
    sourceRevision: sourceRevision(),
    extractionVersion: EXTRACTION_VERSION,
    identityPolicy: URL_IDENTITY_POLICY,
    requestedSourceUrl,
    resolvedSourceUrl: kind === "provider_report" ? null : resolvedSourceUrl,
    rawHref,
    resolvedHref,
    responseHash: body === null ? null : responseHash(body),
    absenceScope: null,
  };
}

export type SourceFunnel = {
  returnedCandidates: number;
  duplicate: number;
  excluded: number;
  domainCap: number;
  limit: number;
  admitted: number;
  timeSkipped: number;
  skippedWave: number;
  attempted: number;
  fetched: number;
  validHtml: number;
  errors: number;
  confirmedPairs: number;
  confirmedDomains: string[];
  displayedPairs: number;
};
export type Coverage = Record<string, SourceFunnel>;
export function funnel(coverage: Coverage, source: string): SourceFunnel {
  return (coverage[source] ??= {
    returnedCandidates: 0,
    duplicate: 0,
    excluded: 0,
    domainCap: 0,
    limit: 0,
    admitted: 0,
    timeSkipped: 0,
    skippedWave: 0,
    attempted: 0,
    fetched: 0,
    validHtml: 0,
    errors: 0,
    confirmedPairs: 0,
    confirmedDomains: [],
    displayedPairs: 0,
  });
}

export { measurementComparability } from "./measurement-comparison.ts";

export type RunManifest = ReturnType<typeof buildRunManifest>;
export function buildRunManifest(input: {
  startedAt: string;
  mode: string;
  budgetMs: number;
  maxVerify: number;
  maxBacklinks: number;
  sources: { id: string; status: string }[];
  coverage: Coverage;
  edges: DomainEdge[];
  observed: Backlink[];
  displayed: Backlink[];
  queries: SerpQuery[];
  visibilityCohort?: Pick<SerpQuery, "keyword" | "engine" | "market" | "device" | "depth">[];
}) {
  const { observed, displayed, queries } = input;
  const graph = input.edges
    .map(({ from, to, weight }) => JSON.stringify([from, to, weight]))
    .sort();
  const successful = queries.filter((q) => q.status === "ok" || q.status === "no-results");
  const queryKey = (q: Pick<SerpQuery, "keyword" | "engine" | "market" | "device" | "depth">) =>
    JSON.stringify([q.keyword, q.engine, q.market, q.device, q.depth]);
  const requested = (input.visibilityCohort ?? queries).map(queryKey).sort();
  // Evidence timestamps change on recheck; every other row field can affect selection or analytics.
  const scoreInputs = (rows: Backlink[]) =>
    rows.map(
      ({
        evidence: _evidence,
        firstObserved: _firstObserved,
        lastConfirmed: _lastConfirmed,
        lastAttempted: _lastAttempted,
        ...signals
      }) => signals,
    );
  const scoredInputs = scoreInputs(observed)
    .map((row) => JSON.stringify(row))
    .sort();
  const displayedInputs = scoreInputs(displayed);
  const domains = new Set(observed.filter((b) => b.state === "live").map((b) => b.sourceDomain));
  const displayedIds = new Set(displayed.map((b) => b.id));
  const coverage: Coverage = structuredClone(input.coverage);
  for (const b of observed) {
    if (!displayedIds.has(b.id)) continue;
    for (const source of b.discoverySources ?? [b.discoveredVia])
      funnel(coverage, source).displayedPairs++;
  }
  const policy = {
    mode: input.mode,
    budgetMs: input.budgetMs,
    maxVerify: input.maxVerify,
    maxBacklinks: input.maxBacklinks,
  };
  return {
    version: "measurement-v2",
    cohort: {
      key: responseHash(
        JSON.stringify([policy, input.sources.map((source) => source.id).sort(), requested]),
      ),
      sources: input.sources.map((source) => source.id).sort(),
      visibility: requested,
      limitation:
        "Discovery is an incomplete sample; missing rows require an explicit comparable recheck before a loss claim.",
    },
    sourceRevision: sourceRevision(),
    extractionVersion: EXTRACTION_VERSION,
    identityPolicy: URL_IDENTITY_POLICY,
    domainPolicy: DOMAIN_POLICY,
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    policy,
    sourceStatus: input.sources,
    coverageScope: "live_candidate_verification_only",
    coverage,
    observed: {
      pairs: observed.length,
      archivePairs: observed.filter((b) => b.state === "lost").length,
      livePairs: observed.filter((b) => b.state === "live").length,
      referringDomains: domains.size,
    },
    displayed: { pairs: displayed.length, omittedPairs: observed.length - displayed.length },
    graph: {
      nodes: new Set(input.edges.flatMap((e) => [e.from, e.to])).size,
      edges: graph.length,
      signature: responseHash(JSON.stringify(graph)),
    },
    scores: {
      version: SCORE_VERSION,
      kind: "uncalibrated_run_relative_heuristic",
      components: [
        "domain_tld_name_archive_age_page_count",
        "anchor_placement_risk_rules",
        "run_relative_pagerank",
        "follow_content_weights",
      ],
      missingArchiveDomains: new Set(
        observed.filter((b) => !b.domainFirstArchivedAt).map((b) => b.sourceDomain),
      ).size,
      comparisonKey: responseHash(
        JSON.stringify([policy, input.sources, graph, scoredInputs, displayedInputs]),
      ),
      comparableAcrossProviders: false,
      limitation:
        "Coverage and graph composition change these scores. A score delta is not authority, Google value or backlink progress.",
    },
    visibility: {
      method: "best-successful-engine-per-keyword-v2",
      requested,
      successful: successful.map(queryKey).sort(),
      failed: Math.max(0, requested.length - successful.length),
      measured: successful.length > 0,
      comparisonKey: responseHash(JSON.stringify([requested, successful.map(queryKey).sort()])),
      limitation:
        "Only identical successful keyword/engine/market/device/depth cohorts are comparable; visibility cannot establish backlink causation.",
    },
    rendering: {
      enabled: false,
      reason:
        "Automatic scans use fetched HTML only. The optional isolated renderer requires explicit qualified runtime configuration; HTML absence does not establish rendered-page absence.",
    },
  };
}

export function candidateSources(candidate: {
  via: DiscoverySource;
  sources?: DiscoverySource[];
}): DiscoverySource[] {
  return [...new Set([candidate.via, ...(candidate.sources ?? [])])];
}
