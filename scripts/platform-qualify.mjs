#!/usr/bin/env node
/** Controlled end-to-end qualification; no external source or paid provider is contacted. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { platformWorker } from "./platform-worker.mjs";

const source = existsSync(new URL("../src/lib/backlinks/scan-queue.server.ts", import.meta.url));
const load = (name) =>
  import(
    new URL(source ? `../src/lib/backlinks/${name}.ts` : `../dist/${name}.js`, import.meta.url)
  );
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_STORAGE = 20 * 1024 * 1024;
const scopeInput = {
  subject: "qualification",
  tenantId: "qualification",
  projectIds: ["controlled"],
  role: "operator",
};
const directoryBytes = (path) =>
  readdirSync(path, { withFileTypes: true }).reduce(
    (sum, entry) =>
      sum +
      (entry.isDirectory()
        ? directoryBytes(join(path, entry.name))
        : statSync(join(path, entry.name)).size),
    0,
  );
const percentile = (values, fraction) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null;

async function worker([database, origin, runId, workerId]) {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d{1,5}$/);
  assert.ok(Number(new URL(origin).port) <= 65535);
  process.env.RANKPROOF_PIN_DNS = "0";
  process.env.RANKPROOF_SERVICE_REVISION = "controlled-platform-qualification-v1";
  const { ScanQueue } = await load("scan-queue.server");
  const { createTenantScope } = await load("tenant-scope");
  const { setHostResolverForTests } = await load("net.server");
  setHostResolverForTests(async (host) => {
    assert.equal(host, "publisher.example", "Qualification DNS refuses external hosts");
    return ["93.184.216.34"];
  });
  const directFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "publisher.example", "Qualification refuses external HTTP");
    assert.match(url.pathname, /^(?:\/robots\.txt|\/job\/\d+)$/);
    assert.equal(url.search, "");
    const response = await directFetch(origin + url.pathname, {
      ...init,
      headers: {
        ...init?.headers,
        "x-qualification-worker": workerId,
        "x-qualification-run": runId,
      },
    });
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: response.headers,
    });
  };
  const scope = createTenantScope(
    { ...scopeInput, subject: workerId, role: "worker" },
    "controlled",
  );
  const queue = new ScanQueue(database);
  const began = process.cpuUsage();
  let idleClaims = 0;
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        process.off("message", onMessage);
        reject(new Error("Worker start barrier timed out"));
      }, 5000);
      const onMessage = (message) => {
        if (message?.kind !== "start") return;
        clearTimeout(timeout);
        process.off("message", onMessage);
        resolve();
      };
      process.on("message", onMessage);
      process.send?.({ kind: "ready" });
    });
    while (true) {
      const jobs = queue.listJobs(scope, runId);
      if (jobs.every((job) => job.status === "done" || job.status === "failed")) break;
      const result = await platformWorker([
        database,
        scope.tenantId,
        scope.projectId,
        runId,
        workerId,
      ]);
      if (result)
        process.send?.({
          kind: "completed",
          jobId: result.jobId,
          status: result.observation.status,
          artifactId: result.artifactId,
        });
      else {
        idleClaims++;
        await delay(3);
      }
    }
    process.send?.({
      kind: "summary",
      workerId,
      pid: process.pid,
      idleClaims,
      cpu: process.cpuUsage(began),
      observedRssBytes: process.memoryUsage().rss,
    });
  } finally {
    queue.close();
  }
}

export async function runPlatformQualification({ jobs = 200, outDir } = {}) {
  assert.ok(
    Number.isSafeInteger(jobs) && jobs >= 24 && jobs <= 500,
    "jobs must be24..500; formal qualification uses100..500",
  );
  outDir ??= mkdtempSync(join(tmpdir(), "rankproof-platform-qualification-"));
  if (existsSync(outDir))
    assert.equal(readdirSync(outDir).length, 0, "Qualification output directory must be empty");
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const { ScanQueue } = await load("scan-queue.server");
  const { createTenantScope } = await load("tenant-scope");
  const { grantQueuedVerification } = await load("scan-queue-worker.server");
  const { PlatformTelemetry } = await load("telemetry.server");
  const database = join(outDir, "qualification.sqlite");
  const scope = createTenantScope(scopeInput, "controlled");
  let queue = new ScanQueue(database);
  let peakStorageBytes = directoryBytes(outDir);
  const children = [];
  const phases = new Map();
  const sampleStorage = () => {
    peakStorageBytes = Math.max(peakStorageBytes, directoryBytes(outDir));
    assert.ok(peakStorageBytes <= MAX_STORAGE, "Qualification exceeded20MiB storage cap");
  };
  const server = createServer((req, res) => {
    const phase = phases.get(req.headers["x-qualification-run"]);
    if (!phase || !/^\/(?:robots\.txt|job\/\d+)$/.test(req.url ?? "")) {
      res.writeHead(400);
      res.end();
      return;
    }
    phase.requests++;
    phase.active++;
    phase.maxConcurrent = Math.max(phase.maxConcurrent, phase.active);
    let answered = false;
    res.once("close", () => {
      phase.active--;
      if (!answered) phase.unanswered++;
    });
    const robots = req.url === "/robots.txt";
    const index = Number(req.url.split("/").at(-1));
    if (phase.crash && !robots && index === 0 && !phase.killed) {
      phase.killed = true;
      const victim = phase.workers.find(
        (record) => record.id === req.headers["x-qualification-worker"],
      );
      if (!victim) {
        phase.failure = new Error("Crash victim must be a known qualification child");
        res.writeHead(500);
        res.end();
        return;
      }
      phase.victim = victim;
      victim.expectedKill = true;
      victim.child.kill("SIGKILL");
      victim.exited.then(() => {
        phase.victimExitedAt = performance.now();
        startWorker(phase, "replacement");
      });
      return;
    }
    const blocked = phase.crash && !robots && index % 25 === 24;
    const absent = phase.crash && !robots && index % 40 === 39;
    const body = robots
      ? "User-agent: *\nAllow: /\n"
      : blocked
        ? "<title>Access denied</title><p>Controlled blocked source.</p>"
        : `<html><title>Controlled publisher</title><body><p>Local HTML Żółć 日本語.</p>${absent ? "<p>Known absent anchor.</p>" : '<a href="https://brand.example/offer">Offer</a>'}</body></html>`;
    const send = () => {
      if (res.destroyed) return;
      answered = true;
      phase.responseBodyBytes += Buffer.byteLength(body);
      res.writeHead(blocked ? 403 : 200, {
        "content-type": robots ? "text/plain" : "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
    };
    if (robots) send();
    else if (phase.crash && !phase.httpBarrierReleased) {
      // Hold real responses until two source requests overlap. Process startup
      // speed must not decide whether the concurrency assertion is exercised.
      phase.httpBarrier.push(send);
      if (phase.httpBarrier.length === 1)
        phase.httpBarrierTimer = setTimeout(() => {
          phase.failure = new Error("Two-request HTTP concurrency barrier timed out");
        }, 5000);
      if (phase.httpBarrier.length === 2) {
        clearTimeout(phase.httpBarrierTimer);
        phase.httpBarrierReleased = true;
        for (const release of phase.httpBarrier) release();
      }
    } else setTimeout(send, 8);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  function startWorker(phase, suffix) {
    const id = `${phase.id}-${suffix}`;
    const env = Object.fromEntries(
      ["PATH", "TMPDIR", "LANG"]
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]]),
    );
    const child = fork(
      fileURLToPath(import.meta.url),
      ["--worker", database, origin, phase.id, id],
      { execArgv: ["--experimental-strip-types"], env, silent: true },
    );
    const record = {
      id,
      child,
      stderr: "",
      summary: null,
      expectedKill: false,
      terminal: null,
      readyAt: null,
    };
    record.exited = new Promise((resolve) =>
      child.once("exit", (code, signal) => {
        record.terminal = { code, signal };
        resolve(record.terminal);
      }),
    );
    children.push(record);
    phase.workers.push(record);
    child.stderr.on("data", (chunk) => {
      if (record.stderr.length < 2000) record.stderr += chunk;
    });
    child.once("error", (error) => {
      phase.failure = error;
    });
    child.on("message", (message) => {
      if (message.kind === "ready") {
        record.readyAt = performance.now();
        if (phase.startReleased) child.send({ kind: "start" });
        else if (
          phase.workers.length === 3 &&
          phase.workers.every((entry) => entry.readyAt !== null)
        ) {
          phase.startReleased = true;
          for (const entry of phase.workers) entry.child.send({ kind: "start" });
        }
      }
      if (message.kind === "summary") record.summary = message;
      if (message.kind === "completed") {
        if (phase.completed.has(message.jobId)) {
          phase.failure = new Error("A durable job completed twice");
          return;
        }
        phase.completed.set(message.jobId, {
          ...message,
          workerId: id,
          observedAt: performance.now(),
        });
      }
    });
    return record;
  }
  async function phase(id, count, policy, crash = false) {
    const state = {
      id,
      count,
      crash,
      killed: false,
      requests: 0,
      responseBodyBytes: 0,
      active: 0,
      maxConcurrent: 0,
      unanswered: 0,
      workers: [],
      completed: new Map(),
      enqueuedAt: new Map(),
      failure: null,
      startReleased: false,
      httpBarrier: [],
      httpBarrierReleased: false,
      httpBarrierTimer: null,
    };
    phases.set(id, state);
    queue.createRun(scope, id, policy);
    for (let index = 0; index < count; index++) {
      const sourceUrl = `https://publisher.example/job/${index}`;
      const grantArtifactId = grantQueuedVerification(queue, scope, {
        id: `${id}-${index}`,
        runId: id,
        sourceUrl,
        targetUrl: "https://brand.example/offer",
        expiresAt: Date.now() + 60000,
      });
      const input = {
        runId: id,
        dedupeKey: `job-${index}`,
        url: sourceUrl,
        payload: { kind: "verify_backlinks.v1", grantArtifactId },
      };
      const job = queue.enqueue(scope, input);
      assert.equal(queue.enqueue(scope, input).id, job.id);
      state.enqueuedAt.set(job.id, performance.now());
    }
    state.started = performance.now();
    for (let index = 0; index < 3; index++) startWorker(state, `worker-${index}`);
    const deadline = performance.now() + 30000;
    while (true) {
      if (state.failure) throw state.failure;
      for (const record of state.workers)
        if (record.terminal && !record.expectedKill && record.terminal.code !== 0)
          throw new Error(`Qualification worker failed: ${record.stderr}`);
      sampleStorage();
      if (state.workers.every((record) => record.terminal)) break;
      assert.ok(
        performance.now() < deadline,
        "Qualification timed out; workers are not silently restarted",
      );
      await delay(20);
    }
    if (state.victim) {
      assert.deepEqual(state.victim.terminal, { code: null, signal: "SIGKILL" });
      assert.ok(state.victimExitedAt);
    }
    const storedJobs = queue.listJobs(scope, id);
    assert.equal(storedJobs.length, count);
    assert.ok(storedJobs.every((job) => job.status === "done"));
    assert.equal(state.completed.size, count);
    assert.ok(
      state.maxConcurrent <= policy.maxConcurrentPerHost,
      "Shared host admission exceeded configured concurrency",
    );
    const observations = storedJobs.map((job) => {
      const stored = queue.getArtifact(scope, job.result.artifactId);
      assert.ok(stored, "Completed verification artifact missing");
      const observation = stored.value.observation;
      const completion = state.completed.get(job.id);
      assert.equal(completion.artifactId, job.result.artifactId);
      assert.equal(completion.status, observation.status);
      assert.equal(observation.source_url, job.url);
      assert.equal(observation.target_url, "https://brand.example/offer");
      if (crash) {
        const index = Number(new URL(job.url).pathname.split("/").at(-1));
        const expected =
          index % 25 === 24 ? "error" : index % 40 === 39 ? "not_found" : "confirmed";
        assert.equal(
          observation.status,
          expected,
          "Actual verifier disagreed with controlled HTML",
        );
      } else {
        assert.ok(
          observation.status === "confirmed" || observation.status === "error",
          "Budget exhaustion cannot become false link absence",
        );
      }
      return stored;
    });
    const telemetry = new PlatformTelemetry(queue).report(scope, id, {
      expectedMeasurements: count,
      minCompleteRatio: 1,
      maxP95Ms: 10000,
      maxKnownCostUsd: 0,
      requireKnownCosts: true,
    });
    assert.equal(telemetry.usage.requests, state.requests);
    assert.ok(state.requests <= policy.maxRequests && state.requests <= policy.maxRequestsPerHost);
    assert.equal(telemetry.costUsd.unknownSamples, count);
    assert.equal(
      telemetry.qualityGate.pass,
      false,
      "Unpriced source work cannot be a cost-qualified pass",
    );
    const latencies = [...state.completed].map(
      ([jobId, value]) => value.observedAt - state.enqueuedAt.get(jobId),
    );
    return {
      state,
      storedJobs,
      observations,
      telemetry,
      latencies,
      elapsedMs: performance.now() - state.started,
    };
  }
  const controllerCpu = process.cpuUsage();
  try {
    const policy = {
      maxRequests: jobs + 30,
      maxRequestsPerHost: jobs + 30,
      maxConcurrentPerHost: 2,
      minHostIntervalMs: 0,
      maxAttempts: 2,
      retryBaseMs: 5,
      leaseMs: 1000,
    };
    const main = await phase("main", jobs - 16, policy, true);
    assert.equal(main.state.httpBarrierReleased, true);
    assert.equal(main.state.maxConcurrent, 2, "Workload must exercise concurrent HTTP admission");
    assert.ok(
      new Set([...main.state.completed.values()].map((entry) => entry.workerId)).size >= 2,
      "Workload must execute committed jobs in multiple processes",
    );
    const retried = main.storedJobs.filter((job) => job.attempt > 1);
    assert.equal(retried.length, 1);
    assert.equal(retried[0].url, "https://publisher.example/job/0");
    assert.equal(retried[0].attempt, 2);
    assert.ok(main.state.completed.get(retried[0].id).observedAt > main.state.victimExitedAt);
    assert.ok(
      main.state.workers
        .filter((w) => w.summary)
        .reduce((sum, w) => sum + w.summary.idleClaims, 0) > 0,
    );
    const crashReservations = main.state.requests - main.telemetry.requests.knownTotal;
    assert.ok(
      crashReservations >= 1 && crashReservations <= 2,
      "Crashed page and possible initial robots reservations remain charged outside committed telemetry",
    );
    assert.ok(main.telemetry.bytes.knownTotal <= main.state.responseBodyBytes);
    assert.equal(main.state.unanswered, 1);
    const globalLimit = await phase("global-limit", 8, {
      ...policy,
      maxRequests: 2,
      maxRequestsPerHost: 4,
    });
    const hostLimit = await phase("host-limit", 8, {
      ...policy,
      maxRequests: 4,
      maxRequestsPerHost: 2,
    });
    for (const controlled of [globalLimit, hostLimit]) {
      assert.equal(controlled.state.requests, 2);
      assert.ok(controlled.telemetry.measurement.complete < 8);
      assert.ok(controlled.telemetry.execution.blocked > 0);
      assert.equal(controlled.telemetry.requests.knownTotal, controlled.state.requests);
    }
    const beforeRestart = queue.getArtifact(scope, main.storedJobs[0].result.artifactId);
    assert.throws(
      () => queue.putArtifact(scope, main.storedJobs[0].result.artifactId, { forged: true }),
      /live verification worker lease/,
    );
    queue.putArtifact(scope, "qualification.immutable", { original: true });
    assert.throws(
      () => queue.putArtifact(scope, "qualification.immutable", { changed: true }),
      /immutable|conflict/i,
    );
    queue.close();
    queue = new ScanQueue(database);
    assert.deepEqual(queue.getArtifact(scope, main.storedJobs[0].result.artifactId), beforeRestart);
    assert.equal(queue.listJobs(scope, "main").length, jobs - 16);
    const foreign = createTenantScope({ ...scopeInput, tenantId: "foreign" }, "controlled");
    assert.equal(queue.getArtifact(foreign, main.storedJobs[0].result.artifactId), null);
    const currentCpu = process.cpuUsage(controllerCpu);
    const describe = ({ state, telemetry, latencies, elapsedMs }) => ({
      runId: state.id,
      jobs: state.count,
      elapsedMs,
      endToEndLatencyMs: {
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        method: "nearest_rank",
        scope: "enqueue-through-observed-committed-completion",
      },
      actualHttp: {
        requests: state.requests,
        responseBodyBytes: state.responseBodyBytes,
        unanswered: state.unanswered,
        maxConcurrent: state.maxConcurrent,
        concurrencyBarrierReleased: state.crash ? state.httpBarrierReleased : null,
      },
      observations: Object.fromEntries(
        ["confirmed", "not_found", "error"].map((status) => [
          status,
          [...state.completed.values()].filter((entry) => entry.status === status).length,
        ]),
      ),
      telemetry,
      workerProcesses: state.workers.map((record) => ({
        workerId: record.id,
        pid: record.child.pid,
        terminal: record.terminal,
        ready: record.readyAt !== null,
        summary: record.summary,
      })),
      latencyScope: "worker duration excludes queue waiting; end-to-end includes it",
    });
    const report = {
      schema: "platform-qualification.v1",
      observedAt: new Date().toISOString(),
      node: process.versions.node,
      environment: {
        transport: "test-only-bounded-loopback-relay",
        worker: "actual-platformWorker-default-runNextQueuedVerification",
        verifier: "actual-verifyBacklinks",
        externalRequests: 0,
        workerConcurrency: 3,
        hostConcurrency: 2,
        synchronization: "three-worker-ready-start-ipc-and-two-source-request-http-barriers",
      },
      workload: {
        totalJobs: jobs,
        qualificationSized: jobs >= 100,
        mainJobs: jobs - 16,
        budgetControlJobs: 16,
        killedProcesses: 1,
        recoveredLeaseAttempts: 2,
      },
      operationalAssertionsPassed: true,
      pricedQualityQualified: false,
      runs: [main, globalLimit, hostLimit].map(describe),
      controllerCpuMs: { user: currentCpu.user / 1000, system: currentCpu.system / 1000 },
      storage: {
        peakObservedBytes: peakStorageBytes,
        capBytes: MAX_STORAGE,
        durableRestartPassed: true,
        artifactImmutabilityPassed: true,
        tenantIsolationPassed: true,
      },
      unit: {
        committedAttemptCpuMsPerMainJob:
          (main.telemetry.cpuUserMs.knownTotal + main.telemetry.cpuSystemMs.knownTotal) /
          main.state.count,
        sourceRequestsPerMainJob: main.state.requests / main.state.count,
        sourceCostUsd: null,
        hostingCostUsd: null,
        monetaryCostUsdPerJob: null,
      },
      crashAccounting: {
        reservedRequestsWithoutCommittedTelemetry:
          main.state.requests - main.telemetry.requests.knownTotal,
        cpuUsageOfKilledProcess: null,
        receivedBytesOfKilledAttempt: null,
        reason:
          "SIGKILL destroys in-process samples; reserved HTTP attempts remain in durable queue usage, never refunded or treated as zero",
      },
      limitations: [
        "One-machine SQLite qualification, not multi-machine/cloud/provider scale or real-world extraction accuracy.",
        "Loopback relay and approved test DNS hooks bypass real-network DNS/SSRF qualification; all other outbound hosts are refused.",
        "Worker CLI is reused per job inside persistent child scheduler processes; CPU samples cover final committed attempts, not killed-process CPU or complete machine cost.",
        "RSS is an observed process snapshot, not isolated per-job peak memory. Server response-body bytes are not wire bytes.",
        "Crash recovery exercises lease reclaim/retry, not automatic retries of completed HTTP-error observations. Existing deterministic tests separately cover backoff/fencing.",
        "Unknown monetary prices deliberately fail the quality/cost gate. Operational assertions do not establish unit economics or an SLO commitment.",
      ],
    };
    sampleStorage();
    report.storage.peakObservedBytes = peakStorageBytes;
    const output = join(outDir, "platform-qualification.json");
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    sampleStorage();
    report.storage.peakObservedBytes = peakStorageBytes;
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return { outDir, report };
  } finally {
    for (const state of phases.values()) clearTimeout(state.httpBarrierTimer);
    for (const record of children) if (!record.terminal) record.child.kill("SIGKILL");
    await Promise.all(children.map((record) => record.exited));
    queue.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] === "--worker")
    worker(args.slice(1)).catch((error) => {
      process.stderr.write(error.stack + "\n");
      process.exitCode = 1;
    });
  else {
    const [count, output, extra] = args;
    if (
      extra ||
      (count !== undefined &&
        (!Number.isSafeInteger(Number(count)) || Number(count) < 100 || Number(count) > 500))
    )
      throw new Error("Usage: platform-qualify [100..500 jobs] [private-output-directory]");
    runPlatformQualification({ jobs: count === undefined ? 200 : Number(count), outDir: output })
      .then(({ outDir, report }) =>
        process.stdout.write(
          JSON.stringify({
            outDir,
            jobs: report.workload.totalJobs,
            operationalAssertionsPassed: report.operationalAssertionsPassed,
            pricedQualityQualified: report.pricedQualityQualified,
            storage: report.storage,
          }) + "\n",
        ),
      )
      .catch((error) => {
        process.stderr.write(error.stack + "\n");
        process.exitCode = 1;
      });
  }
}
