import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("offline benchmark has valid structured output without remote services", () => {
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/benchmark-local.mjs"],
    { cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  const output = JSON.parse(run.stdout);
  assert.equal(output.benchmark, "rankproof-local-v1");
  assert.equal(output.results.length, 4);
  for (const result of output.results) {
    assert.ok(result.operations > 0);
    assert.ok(Number.isFinite(result.p50Ms));
    assert.ok(Number.isFinite(result.p95Ms));
    assert.ok(result.p50Ms >= 0);
    assert.ok(result.p95Ms >= result.p50Ms);
    assert.ok(result.checksum > 0);
  }
});
