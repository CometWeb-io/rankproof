#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

/** Measures local durable queue operations only, with zero network work. */
export async function runPlatformLoad(jobs = 200) {
  assert.ok(Number.isSafeInteger(jobs) && jobs > 0 && jobs <= 10000, "jobs must be 1..10000");
  const source = existsSync(new URL("../src/lib/backlinks/scan-queue.server.ts", import.meta.url));
  const moduleUrl = (name) =>
    new URL(source ? `../src/lib/backlinks/${name}.ts` : `../dist/${name}.js`, import.meta.url);
  const { ScanQueue } = await import(moduleUrl("scan-queue.server"));
  const { createTenantScope } = await import(moduleUrl("tenant-scope"));
  const dir = mkdtempSync(join(tmpdir(), "rankproof-platform-load-"));
  const database = join(dir, "load.sqlite");
  const scope = createTenantScope(
    { subject: "operator", tenantId: "load", projectIds: ["controlled"], role: "operator" },
    "controlled",
  );
  let queue = new ScanQueue(database);
  const policy = {
    maxRequests: 1,
    maxRequestsPerHost: 1,
    maxConcurrentPerHost: 1,
    minHostIntervalMs: 0,
    maxAttempts: 2,
    retryBaseMs: 1,
    leaseMs: 10000,
  };
  const cpu = process.cpuUsage();
  const started = performance.now();
  const latency = [];
  try {
    queue.createRun(scope, "run", policy);
    for (let i = 0; i < jobs; i++) {
      const at = performance.now();
      const input = { runId: "run", dedupeKey: `job-${i}`, url: `https://load.example/${i}` };
      const job = queue.enqueue(scope, input);
      assert.equal(queue.enqueue(scope, input).id, job.id);
      const lease = queue.claim(scope, "run", "worker");
      assert.equal(lease.id, job.id);
      queue.complete(scope, lease, { queueOperationOnly: true });
      latency.push(performance.now() - at);
      if (i === Math.floor(jobs / 2)) {
        queue.close();
        queue = new ScanQueue(database);
      }
    }
    assert.equal(queue.usage(scope, "run").requests, 0);
    const elapsedMs = performance.now() - started;
    const usedCpu = process.cpuUsage(cpu);
    queue.close();
    queue = null;
    const storageBytes = statSync(database).size;
    latency.sort((a, b) => a - b);
    return {
      schema: "platform-load.v1",
      observedAt: new Date().toISOString(),
      node: process.versions.node,
      workload:
        "enqueue + dedupe + lease + complete, same-machine SQLite FULL synchronous; one worker, one restart",
      jobs,
      elapsedMs,
      jobsPerSecond: jobs / (elapsedMs / 1000),
      latencyMs: {
        p50: latency[Math.ceil(jobs * 0.5) - 1],
        p95: latency[Math.ceil(jobs * 0.95) - 1],
        method: "nearest_rank",
      },
      cpuMs: { user: usedCpu.user / 1000, system: usedCpu.system / 1000 },
      unit: {
        cpuMsPerJob: (usedCpu.user + usedCpu.system) / 1000 / jobs,
        storageBytesPerJob: storageBytes / jobs,
        sourceRequestsPerJob: 0,
        monetaryCostUsd: null,
      },
      storageBytes,
      limitations: [
        "Local queue operations only; not a crawler throughput or accuracy benchmark",
        "No provider/hosting/support monetary price configured",
        "No distributed or network filesystem qualification",
      ],
    };
  } finally {
    queue?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [count, output] = process.argv.slice(2);
  if (process.argv.length > 4) throw new Error("Usage: platform-load [job-count] [output-json]");
  runPlatformLoad(count === undefined ? 200 : Number(count))
    .then((report) => {
      const text = `${JSON.stringify(report, null, 2)}\n`;
      if (output) writeFileSync(output, text, { mode: 0o600 });
      process.stdout.write(text);
    })
    .catch((error) => {
      process.stderr.write(`${error.stack}\n`);
      process.exitCode = 1;
    });
}
