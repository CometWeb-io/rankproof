import assert from "node:assert/strict";
import { test } from "node:test";
import { accuracyCorpus } from "./fixtures/accuracy-v1/corpus.ts";

test("synthetic accuracy corpus declares all 1152 uniquely identified cases", () => {
  const cases = accuracyCorpus();
  assert.equal(cases.length, 1152);
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  assert.equal(new Set(cases.map((item) => item.scenario)).size, 24);
  assert.equal(new Set(cases.map((item) => item.language)).size, 6);
  assert.deepEqual(
    new Set(cases.map((item) => item.expected)),
    new Set(["present", "absent", "unavailable"]),
  );
});

test("actual verifier agrees with the synthetic corpus without claiming real-world accuracy", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const run = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("../../../scripts/benchmark-accuracy.mjs", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout);
  assert.equal(report.metrics.cases, 1152);
  assert.deepEqual(report.failures, []);
  assert.equal(report.realWorldAccuracyQualified, false);
  assert.equal(report.corpus.independentRealWorldAnnotations, 0);
});
