import assert from "node:assert/strict";
import { test } from "node:test";
import { runBenchmark } from "./benchmark.ts";
import { BENCHMARK_CASES } from "./fixtures/verify-benchmark.ts";

test("the extractor passes every labelled benchmark case", () => {
  const report = runBenchmark();
  const failures = report.results.filter((r) => !r.pass && !r.limitation);
  assert.deepEqual(
    failures.map((f) => `${f.id}: ${f.mismatches.join("; ")}`),
    [],
  );
  assert.equal(report.false_absence, 0);
  assert.ok(report.scored >= 35, "the corpus must not shrink silently");
  assert.equal(
    new Set(BENCHMARK_CASES.map((c) => c.id)).size,
    BENCHMARK_CASES.length,
    "unique ids",
  );
});

test("the benchmark actually detects a wrong verdict", () => {
  const broken = BENCHMARK_CASES.slice(0, 2).map((c) => ({
    ...c,
    expected: { ...c.expected, status: "not_found" as const },
  }));
  const report = runBenchmark(broken);
  assert.equal(report.passed, 0);
  assert.equal(report.confirmed_precision, 0);
});
