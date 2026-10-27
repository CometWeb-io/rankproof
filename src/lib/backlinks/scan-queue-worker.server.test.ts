import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScanQueue } from "./scan-queue.server.ts";
import { createTenantScope } from "./tenant-scope.ts";
import { grantQueuedVerification, runNextQueuedVerification } from "./scan-queue-worker.server.ts";
import { clearNetCache, setHostResolverForTests } from "./net.server.ts";
import { clearRobotsCache } from "./robots.server.ts";

const scope = createTenantScope(
  { subject: "op", tenantId: "a", projectIds: ["p"], role: "operator" },
  "p",
);
const worker = createTenantScope(
  { subject: "worker", tenantId: "a", projectIds: ["p"], role: "worker" },
  "p",
);
const policy = {
  maxRequests: 1,
  maxRequestsPerHost: 1,
  maxConcurrentPerHost: 1,
  minHostIntervalMs: 0,
  maxAttempts: 1,
  retryBaseMs: 1,
  leaseMs: 10000,
};

test("default actual verifier worker, local HTTP, remediation and telemetry smoke", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rankproof-worker-smoke-"));
  try {
    const { runPlatformSmoke } = await import(
      new URL("../../../scripts/platform-smoke.mjs", import.meta.url).href
    );
    const { report } = await runPlatformSmoke({ outDir: dir });
    assert.equal(report.environment.worker, "default-runNextQueuedVerification");
    assert.equal(report.remediation.verified.status, "verified");
    assert.equal(report.remediation.blocked.status, "inconclusive");
    assert.equal(report.telemetry.execution.blocked, 1);
    assert.equal(report.telemetry.usage.requests, 4);
    assert.equal(report.telemetry.measurement.complete, 2);
    assert.equal(report.telemetry.qualityGate.pass, false);
    assert.match(readFileSync(join(dir, "platform-dashboard.html"), "utf8"), /Quality gate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default transport budgets every real attempt, before I/O; a budget block is never absence", async () => {
  const queue = new ScanQueue(":memory:");
  const originalFetch = globalThis.fetch;
  const pin = process.env.RANKPROOF_PIN_DNS;
  let requests = 0;
  process.env.RANKPROOF_PIN_DNS = "0";
  setHostResolverForTests(async () => ["93.184.216.34"]);
  clearNetCache();
  clearRobotsCache();
  globalThis.fetch = async () => {
    requests++;
    return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
  };
  try {
    queue.createRun(scope, "run", policy);
    const grantArtifactId = grantQueuedVerification(queue, scope, {
      id: "g",
      runId: "run",
      sourceUrl: "https://source.example/post",
      targetUrl: "https://target.example/",
      expiresAt: Date.now() + 60000,
    });
    queue.enqueue(scope, {
      runId: "run",
      dedupeKey: "verify",
      url: "https://source.example/post",
      payload: { kind: "verify_backlinks.v1", grantArtifactId },
    });
    const result = await runNextQueuedVerification(queue, worker, "run", "worker");
    assert.equal(requests, 1); // robots only; page is refused before the second HTTP attempt
    assert.equal(queue.usage(scope, "run").requests, 1);
    assert.equal(result!.observation.status, "error");
    assert.match(result!.observation.reason!, /budget exhausted/);
    assert.equal(queue.getJob(scope, result!.jobId)!.status, "done");
    assert.equal(await runNextQueuedVerification(queue, worker, "run", "worker"), null);
  } finally {
    globalThis.fetch = originalFetch;
    if (pin === undefined) delete process.env.RANKPROOF_PIN_DNS;
    else process.env.RANKPROOF_PIN_DNS = pin;
    setHostResolverForTests(null);
    clearNetCache();
    clearRobotsCache();
    queue.close();
  }
});

test("missing/expired operator grant or mismatched source stops worker before any I/O", async () => {
  const queue = new ScanQueue(":memory:");
  try {
    queue.createRun(scope, "run", policy);
    queue.enqueue(scope, {
      runId: "run",
      dedupeKey: "missing",
      url: "https://source.example/post",
      payload: { kind: "verify_backlinks.v1", grantArtifactId: "scan-grant.absent" },
    });
    await assert.rejects(() => runNextQueuedVerification(queue, worker, "run", "worker"), /grant/);
    assert.equal(queue.listJobs(scope, "run")[0]!.status, "failed");
    assert.equal(queue.usage(scope, "run").requests, 0);
    assert.throws(
      () =>
        grantQueuedVerification(queue, worker, {
          id: "g",
          runId: "run",
          sourceUrl: "https://source.example/",
          targetUrl: "https://target.example/",
          expiresAt: Date.now() + 1000,
        }),
      /denied/,
    );
    assert.throws(
      () =>
        grantQueuedVerification(queue, scope, {
          id: "g",
          runId: "run",
          sourceUrl: "https://source.example/",
          targetUrl: "https://target.example/",
          expiresAt: Date.now() - 1,
        }),
      /expiry/,
    );
  } finally {
    queue.close();
  }
});
