import assert from "node:assert/strict";
import { test } from "node:test";
import { accuracyMetrics, measurementQuality, proportion } from "./measurement-quality.ts";
import type { SerpQuery } from "./types.ts";

test("coverage denominator includes failures and unknown freshness stays unknown", () => {
  const q = (status: SerpQuery["status"]) => ({ status }) as SerpQuery;
  const quality = measurementQuality([q("ok"), q("no-results"), q("blocked"), q("error")]);
  assert.equal(quality.coverage, 0.5);
  assert.equal(quality.probability, null);
  assert.equal(quality.oldestEvidenceAgeMs, null);
  assert.equal(measurementQuality([]).coverage, null);
  const dated = measurementQuality(
    [],
    ["2026-10-26T12:00:00Z", "bad"],
    Date.parse("2026-10-27T12:00:00Z"),
  );
  assert.equal(dated.oldestEvidenceAgeMs, 86400000);
  assert.equal(dated.invalidEvidenceTimestamps, 1);
});

test("metrics include abstentions in recall and refuse a fabricated loss metric", () => {
  const metrics = accuracyMetrics([
    { expected: "present", observed: "confirmed" },
    { expected: "present", observed: "error" },
    { expected: "absent", observed: "confirmed" },
    { expected: "unavailable", observed: "not_found" },
  ]);
  assert.equal(metrics.precision.estimate, 0.5);
  assert.equal(metrics.recall.estimate, 0.5);
  assert.equal(metrics.falseAbsenceRate.estimate, 1);
  assert.equal(metrics.falseLossRate, null);
  assert.equal(proportion(0, 0).estimate, null);
  assert.ok(proportion(100, 100).interval95![0]! < 0.99);
  assert.throws(() => proportion(2, 1));
  assert.throws(() => proportion(NaN, 1));
});

test("source agreement retains exact cohorts, failed attempts and engine disagreements", async () => {
  const { sourceAgreement } = await import("./measurement-quality.ts");
  const query = (engine: string, targetPosition: number | null, rest: object = {}) =>
    ({
      keyword: "case-sensitive query",
      market: "us",
      device: "desktop",
      depth: 20,
      engine,
      targetPosition,
      status: "ok",
      ...rest,
    }) as SerpQuery;
  const report = sourceAgreement([
    query("bing", 2),
    query("google", 5),
    query("bing", 2),
    query("brave", 1, { status: "blocked" }),
    query("bing", 2, { market: "de" }),
    query("google", 2, { depth: 10 }),
    query("bing", null, { device: "mobile", status: "no-results" }),
  ]);
  const scope = report.cohorts.find(
    (c) => c.market === "us" && c.depth === 20 && c.device === "desktop",
  )!;
  assert.equal(report.comparedCohorts, 1);
  assert.equal(report.disagreeingCohorts, 1);
  assert.equal(scope.measuredSources, 2);
  assert.equal(scope.positionSpread, 3);
  assert.equal(scope.sources.find((s) => s.cohort.engine === "bing")!.attempts, 2);
  assert.equal(scope.sources.find((s) => s.cohort.engine === "brave")!.repeatability, "unmeasured");
  assert.equal(
    measurementQuality([query("bing", 2), query("google", 5)]).sourceAgreement.disagreeingCohorts,
    1,
  );
  assert.equal(sourceAgreement([query("bing", 2), query("bing", 5)]).comparedCohorts, 0);
});

test("verifier quality separates HTML absence, missing resources, failures and invalid evidence", async () => {
  const { extractionQuality } = await import("./measurement-quality.ts");
  const base = {
    response_hash: "a".repeat(64),
    extraction_version: "test-v1",
    identity_policy: "test-exact",
    reason: null,
    http_status: 200,
    absence_scope: null,
    evidence_kind: null,
  };
  const observations = [
    { ...base, status: "confirmed", evidence_kind: "html_anchor" },
    { ...base, status: "not_found", absence_scope: "fetched_html" },
    { ...base, status: "not_found", absence_scope: "http_resource", http_status: 404 },
    { ...base, status: "error", http_status: 403, reason: "Source returned HTTP 403." },
    { ...base, status: "error", reason: "Verification time budget exhausted." },
    { ...base, status: "error", reason: "Source did not return HTML." },
    { ...base, status: "error", reason: "Source HTML exceeds the verification size limit." },
    { ...base, status: "confirmed", evidence_kind: "html_anchor", response_hash: null },
  ] as Parameters<typeof extractionQuality>[0];
  const quality = extractionQuality(observations);
  assert.deepEqual(quality.outcomes, {
    confirmed: 1,
    absentFromHtml: 1,
    absentHttpResource: 1,
    errors: 4,
    inconsistent: 1,
  });
  assert.equal(quality.failures.blocked, 1);
  assert.equal(quality.failures.timeout, 1);
  assert.equal(quality.failures.nonHtml, 1);
  assert.equal(quality.failures.incompleteOrOversized, 1);
  assert.equal(quality.missingResponseHashes, 1);
  assert.equal(quality.usableHtmlShare, 0.25);
  assert.equal(extractionQuality([]).usableHtmlShare, null);
});

test("actual SERP snapshot retains comparable engine disagreements", async () => {
  const { snapshotFromQueries } = await import("./serp.server.ts");
  const base = {
    keyword: "example",
    market: "us" as const,
    device: "desktop" as const,
    depth: 20,
    status: "ok" as const,
    features: [],
    results: [],
    related: [],
    questions: [],
    difficulty: 0,
    ms: 1,
  };
  const snapshot = snapshotFromQueries([
    { ...base, engine: "bing", targetPosition: 2 },
    { ...base, engine: "google", targetPosition: 5 },
  ]);
  assert.equal(snapshot.measurementQuality.sourceAgreement.disagreeingCohorts, 1);
  assert.equal(snapshot.measurementQuality.sourceAgreement.cohorts[0]!.sources.length, 2);
  assert.equal(snapshot.visibility, 90);
});
