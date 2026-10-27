/** Coverage and evidence age are observations; neither is a calibrated probability. */
import { isMeasuredSerp } from "./serp-intel.ts";
import type { SerpQuery } from "./types.ts";

export function measurementQuality(
  queries: SerpQuery[],
  evidenceTimes: string[] = [],
  now = Date.now(),
) {
  const successful = queries.filter(isMeasuredSerp).length;
  const parsedTimes = evidenceTimes.map(Date.parse).filter(Number.isFinite);
  const oldest = parsedTimes.length ? Math.min(...parsedTimes) : null;
  const newest = parsedTimes.length ? Math.max(...parsedTimes) : null;
  const statuses: Record<string, number> = {};
  for (const query of queries) statuses[query.status] = (statuses[query.status] ?? 0) + 1;
  return {
    kind: "coverage_and_freshness" as const,
    attempted: queries.length,
    successful,
    unavailable: queries.length - successful,
    coverage: queries.length ? successful / queries.length : null,
    statuses,
    sourceAgreement: sourceAgreement(queries),
    evidenceTimestamps: parsedTimes.length,
    invalidEvidenceTimestamps: evidenceTimes.length - parsedTimes.length,
    oldestEvidenceAgeMs: oldest === null ? null : Math.max(0, now - oldest),
    newestEvidenceAgeMs: newest === null ? null : Math.max(0, now - newest),
    calibration: "not_calibrated" as const,
    probability: null,
    limitation:
      "Coverage is limited to submitted attempts, not the search index. CTR and opportunity scores are uncalibrated models; no probability of ranking improvement is established.",
  };
}

/** Wilson 95% binomial interval; null means the denominator is absent. */
export function proportion(successes: number, trials: number) {
  if (
    !Number.isSafeInteger(successes) ||
    !Number.isSafeInteger(trials) ||
    successes < 0 ||
    trials < successes
  )
    throw new Error("Counts must be nonnegative integers, with successes <= trials.");
  if (!trials)
    return { numerator: successes, denominator: trials, estimate: null, interval95: null };
  const z = 1.959963984540054;
  const p = successes / trials;
  const d = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / d;
  return {
    numerator: successes,
    denominator: trials,
    estimate: p,
    interval95: [Math.max(0, center - half), Math.min(1, center + half)],
  };
}

export type AccuracyLabel = "present" | "absent" | "unavailable";
export type AccuracyObservation = {
  expected: AccuracyLabel;
  observed: "confirmed" | "not_found" | "error";
};
export function accuracyMetrics(rows: AccuracyObservation[]) {
  const truePositive = rows.filter(
    (r) => r.expected === "present" && r.observed === "confirmed",
  ).length;
  const confirmations = rows.filter((r) => r.observed === "confirmed").length;
  const present = rows.filter((r) => r.expected === "present").length;
  const absences = rows.filter((r) => r.observed === "not_found").length;
  const falseAbsences = rows.filter(
    (r) => r.observed === "not_found" && r.expected !== "absent",
  ).length;
  return {
    cases: rows.length,
    precision: proportion(truePositive, confirmations),
    recall: proportion(truePositive, present),
    falseAbsenceRate: proportion(falseAbsences, absences),
    abstentionRate: proportion(rows.filter((r) => r.observed === "error").length, rows.length),
    exactStatus: proportion(
      rows.filter(
        (r) =>
          r.observed ===
          ({ present: "confirmed", absent: "not_found", unavailable: "error" } as const)[
            r.expected
          ],
      ).length,
      rows.length,
    ),
    falseLossRate: null,
    limitation:
      "False absence is not false link loss. Loss requires prior confirmed and later comparable observations. Binomial intervals describe these cases and do not establish external validity or independent sample size.",
  };
}

/** Cross-engine ranks are different measurements, not independent votes for one true rank. */
export function sourceAgreement(queries: readonly SerpQuery[]) {
  const scopes = new Map<
    string,
    {
      scope: { keyword: string; market: string; device: string; depth: number };
      engines: Map<string, SerpQuery[]>;
    }
  >();
  let invalidCohorts = 0;
  for (const query of queries) {
    if (
      typeof query.keyword !== "string" ||
      !query.keyword.trim() ||
      typeof query.engine !== "string" ||
      !query.engine ||
      typeof query.market !== "string" ||
      typeof query.device !== "string" ||
      !Number.isInteger(query.depth) ||
      query.depth < 0
    ) {
      invalidCohorts++;
      continue;
    }
    const scope = {
      keyword: query.keyword,
      market: query.market,
      device: query.device,
      depth: query.depth,
    };
    const key = JSON.stringify([scope.keyword, scope.market, scope.device, scope.depth]);
    const group = scopes.get(key) ?? { scope, engines: new Map<string, SerpQuery[]>() };
    const attempts = group.engines.get(query.engine) ?? [];
    attempts.push(query);
    group.engines.set(query.engine, attempts);
    scopes.set(key, group);
  }
  const cohorts = [...scopes]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, { scope, engines }]) => {
      const sources = [...engines]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([engine, attempts]) => {
          const successful = attempts.filter(
            (q) =>
              isMeasuredSerp(q) &&
              (q.targetPosition === null ||
                (Number.isInteger(q.targetPosition) &&
                  q.targetPosition >= 1 &&
                  q.targetPosition <= q.depth)),
          );
          const positions = [...new Set(successful.map((q) => q.targetPosition))].sort((a, b) =>
            a === null ? 1 : b === null ? -1 : a - b,
          );
          return {
            cohort: { ...scope, engine },
            attempts: attempts.length,
            successful: successful.length,
            unavailable: attempts.length - successful.length,
            positions,
            repeatability:
              positions.length > 1
                ? "disagreement"
                : positions.length === 1
                  ? "agreement"
                  : "unmeasured",
          };
        });
      const measured = sources.filter((source) => source.successful > 0);
      const outcomes = new Set(measured.flatMap((source) => source.positions));
      return {
        ...scope,
        sources,
        measuredSources: measured.length,
        agreement:
          measured.length < 2
            ? "insufficient_sources"
            : outcomes.size === 1
              ? "agreement"
              : "disagreement",
        positionSpread:
          measured.flatMap((source) => source.positions).every((p) => p !== null) &&
          measured.length > 1
            ? Math.max(...measured.flatMap((source) => source.positions as number[])) -
              Math.min(...measured.flatMap((source) => source.positions as number[]))
            : null,
      };
    });
  return {
    kind: "descriptive_source_agreement" as const,
    cohorts,
    invalidCohorts,
    comparedCohorts: cohorts.filter((c) => c.measuredSources >= 2).length,
    disagreeingCohorts: cohorts.filter((c) => c.agreement === "disagreement").length,
    limitation:
      "Engine is retained in every source cohort. Only identical keyword/market/device/depth scopes are compared across engines. Engine ranks can legitimately differ; agreement is not calibrated confidence or a vote for one true rank. Repeated attempts from one engine do not create additional sources.",
  };
}

type ExtractionObservation = Pick<
  import("./verify-api.server.ts").BacklinkObservation,
  | "status"
  | "reason"
  | "http_status"
  | "absence_scope"
  | "evidence_kind"
  | "response_hash"
  | "extraction_version"
  | "identity_policy"
>;

/** Counts actual verifier outcomes; an error or missing evidence is never an absence. */
export function extractionQuality(observations: readonly ExtractionObservation[]) {
  const outcomes = {
    confirmed: 0,
    absentFromHtml: 0,
    absentHttpResource: 0,
    errors: 0,
    inconsistent: 0,
  };
  const failures = {
    blocked: 0,
    timeout: 0,
    networkOrDns: 0,
    nonHtml: 0,
    incompleteOrOversized: 0,
    renderingRequired: 0,
    other: 0,
  };
  let missingResponseHashes = 0;
  let missingExtractorMetadata = 0;
  const extractorVersions = new Map<string, number>();
  for (const observation of observations) {
    const validHash =
      typeof observation.response_hash === "string" &&
      /^[a-f0-9]{64}$/i.test(observation.response_hash);
    if (!validHash) missingResponseHashes++;
    if (!observation.extraction_version || !observation.identity_policy) missingExtractorMetadata++;
    if (observation.extraction_version)
      extractorVersions.set(
        observation.extraction_version,
        (extractorVersions.get(observation.extraction_version) ?? 0) + 1,
      );
    const validHtmlEvidence =
      validHash &&
      !!observation.extraction_version &&
      !!observation.identity_policy &&
      observation.http_status !== null &&
      observation.http_status >= 200 &&
      observation.http_status < 300;
    if (
      observation.status === "confirmed" &&
      observation.evidence_kind === "html_anchor" &&
      observation.absence_scope === null &&
      validHtmlEvidence
    )
      outcomes.confirmed++;
    else if (
      observation.status === "not_found" &&
      observation.absence_scope === "fetched_html" &&
      validHtmlEvidence
    )
      outcomes.absentFromHtml++;
    else if (
      observation.status === "not_found" &&
      observation.absence_scope === "http_resource" &&
      (observation.http_status === 404 || observation.http_status === 410)
    )
      outcomes.absentHttpResource++;
    else if (observation.status === "error") {
      outcomes.errors++;
      const reason = observation.reason ?? "";
      if (/challenge|blocked|robots|HTTP (?:401|403|429)|human|rate.limit/i.test(reason))
        failures.blocked++;
      else if (/timeout|timed out|deadline|time budget|abort/i.test(reason)) failures.timeout++;
      else if (/DNS|ENOTFOUND|EAI_AGAIN|ECONN|network|fetch failed/i.test(reason))
        failures.networkOrDns++;
      else if (/not return HTML|non.HTML|content.type/i.test(reason)) failures.nonHtml++;
      else if (/incomplete|truncat|exceeds|size limit|parser limits/i.test(reason))
        failures.incompleteOrOversized++;
      else if (/requires JavaScript|rendering|readable HTML/i.test(reason))
        failures.renderingRequired++;
      else failures.other++;
    } else outcomes.inconsistent++;
  }
  return {
    kind: "verifier_extraction_quality" as const,
    attempted: observations.length,
    outcomes,
    failures,
    missingResponseHashes,
    missingExtractorMetadata,
    extractorVersions: Object.fromEntries(extractorVersions),
    usableHtmlObservations: outcomes.confirmed + outcomes.absentFromHtml,
    usableHtmlShare: observations.length
      ? (outcomes.confirmed + outcomes.absentFromHtml) / observations.length
      : null,
    calibration: "not_calibrated" as const,
    limitation:
      "Counts describe returned verifier attempts, not extraction accuracy. Error categories summarize verifier reasons and do not prove causality. HTTP resource absence is separate from HTML absence; neither alone proves link loss.",
  };
}
