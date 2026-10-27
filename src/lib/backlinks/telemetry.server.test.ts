import assert from "node:assert/strict";
import { test } from "node:test";
import {
  summarizePlatformTelemetry,
  PlatformTelemetry,
  type PlatformSample,
} from "./telemetry.server.ts";
import { ScanQueue } from "./scan-queue.server.ts";
import { createTenantScope } from "./tenant-scope.ts";
const gate = {
  expectedMeasurements: 2,
  minCompleteRatio: 1,
  maxP95Ms: 500,
  maxKnownCostUsd: 0.5,
  requireKnownCosts: true,
};
const sample = (id: string, changes: Partial<PlatformSample> = {}): PlatformSample => ({
  measurementId: id,
  observedAt: 1,
  source: "verifier",
  durationMs: 100,
  bytes: 50,
  requests: 1,
  outcome: "success",
  measurement: "complete",
  costUsd: 0.1,
  cpuUserMs: 1,
  cpuSystemMs: 1,
  rssBytes: 1000,
  ...changes,
});

test("p50/p95, known versus unknown cost and service success versus measurement quality", () => {
  const report = summarizePlatformTelemetry(
    [
      sample("a"),
      sample("b", { durationMs: 300, bytes: null, costUsd: null, measurement: "unknown" }),
    ],
    gate,
  );
  assert.deepEqual(report.latencyMs, { p50: 100, p95: 300, method: "nearest_rank" });
  assert.equal(report.execution.successful, 2);
  assert.equal(report.measurement.completeRatio, 0.5);
  assert.deepEqual(report.costUsd, { knownTotal: 0.1, unknownSamples: 1 });
  assert.deepEqual(report.bytes, { knownTotal: 50, unknownSamples: 1 });
  assert.equal(report.qualityGate.pass, false);
  assert.equal(report.budgetAction, "require_cost_configuration");
  const expensive = summarizePlatformTelemetry([sample("a", { costUsd: 1 }), sample("b")], gate);
  assert.equal(expensive.budgetAction, "stop_new_work");
});

test("retry attempts do not inflate coverage and unknown/blocked runs do not pass", () => {
  const report = summarizePlatformTelemetry(
    [sample("a"), sample("a", { observedAt: 2, measurement: "blocked", outcome: "blocked" })],
    gate,
  );
  assert.equal(report.measurement.complete, 0);
  assert.equal(report.execution.blocked, 1);
  assert.equal(report.qualityGate.pass, false);
  assert.equal(summarizePlatformTelemetry([], gate).latencyMs.p95, null);
  assert.throws(() => summarizePlatformTelemetry([sample("a", { bytes: -1 })], gate), /Invalid/);
  assert.throws(
    () => summarizePlatformTelemetry([sample("a", { outcome: "error" })], gate),
    /cannot/,
  );
  assert.throws(
    () => summarizePlatformTelemetry([], { ...gate, expectedMeasurements: 0 }),
    /Invalid/,
  );
});

test("telemetry persists and cannot cross project/tenant/run prefix boundaries", () => {
  const queue = new ScanQueue(":memory:");
  const scope = createTenantScope(
    { subject: "op", tenantId: "a", projectIds: ["p"], role: "operator" },
    "p",
  );
  const telemetry = new PlatformTelemetry(queue);
  try {
    const policy = {
      maxRequests: 10,
      maxRequestsPerHost: 10,
      maxConcurrentPerHost: 1,
      minHostIntervalMs: 0,
      maxAttempts: 1,
      retryBaseMs: 1,
      leaseMs: 1000,
    };
    queue.createRun(scope, "run", policy);
    queue.createRun(scope, "run.child", policy);
    telemetry.record(scope, "run", sample("a"));
    telemetry.record(scope, "run.child", sample("b"));
    assert.equal(telemetry.report(scope, "run", { ...gate, expectedMeasurements: 1 }).samples, 1);
    const other = createTenantScope(
      { subject: "op", tenantId: "b", projectIds: ["p"], role: "operator" },
      "p",
    );
    assert.throws(() => telemetry.report(other, "run", gate), /unavailable/);
  } finally {
    queue.close();
  }
});
