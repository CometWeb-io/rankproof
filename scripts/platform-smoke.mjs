#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Real local HTTP + actual verifier/default worker. No external website or paid provider is contacted. */
export async function runPlatformSmoke({ outDir } = {}) {
  outDir ??= mkdtempSync(join(tmpdir(), "rankproof-platform-smoke-"));
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const source = existsSync(new URL("../src/lib/backlinks/scan-queue.server.ts", import.meta.url));
  const moduleUrl = (name) =>
    new URL(source ? `../src/lib/backlinks/${name}.ts` : `../dist/${name}.js`, import.meta.url);
  const { ScanQueue } = await import(moduleUrl("scan-queue.server"));
  const { createTenantScope } = await import(moduleUrl("tenant-scope"));
  const { RemediationStore } = await import(moduleUrl("remediation.server"));
  const { PlatformTelemetry } = await import(moduleUrl("telemetry.server"));
  const { grantQueuedVerification, runNextQueuedVerification } = await import(
    moduleUrl("scan-queue-worker.server")
  );
  const net = await import(moduleUrl("net.server"));
  const { clearRobotsCache } = await import(moduleUrl("robots.server"));
  const beforeHtml =
    '<html><title>Controlled publisher</title><body><p>Local test article</p><a href="https://brand.example/offer">Offer</a></body></html>';
  const afterHtml =
    "<html><title>Controlled publisher</title><body><p>Local test article with the approved link removal.</p></body></html>";
  const patchDigest = createHash("sha256").update(afterHtml).digest("hex");
  let stage = "before";
  let httpRequests = 0;
  let httpBytes = 0;
  const server = createServer((req, res) => {
    httpRequests += 1;
    const robots = req.url === "/robots.txt";
    const body = robots
      ? "User-agent: *\nAllow: /\n"
      : stage === "before"
        ? beforeHtml
        : stage === "after"
          ? afterHtml
          : "<title>Access denied</title><p>Controlled challenge</p>";
    httpBytes += Buffer.byteLength(body);
    res.writeHead(!robots && stage === "blocked" ? 403 : 200, {
      "content-type": robots ? "text/plain" : "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const previousFetch = globalThis.fetch;
  const previousPin = process.env.RANKPROOF_PIN_DNS;
  const previousRevision = process.env.RANKPROOF_SERVICE_REVISION;
  process.env.RANKPROOF_PIN_DNS = "0";
  process.env.RANKPROOF_SERVICE_REVISION = "controlled-local-platform-smoke-v1";
  net.setHostResolverForTests(async () => ["93.184.216.34"]);
  net.clearNetCache();
  clearRobotsCache();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "publisher.example", "Smoke refuses any unexpected outbound host");
    const response = await previousFetch(`${origin}${url.pathname}${url.search}`, init);
    // This test-only relay preserves the logical source URL; the verifier/queue hooks are unmodified.
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: response.headers,
    });
  };
  const queue = new ScanQueue(join(outDir, "platform.sqlite"));
  const scope = createTenantScope(
    { subject: "operator", tenantId: "smoke", projectIds: ["controlled"], role: "operator" },
    "controlled",
  );
  const worker = createTenantScope(
    { subject: "worker", tenantId: "smoke", projectIds: ["controlled"], role: "worker" },
    "controlled",
  );
  const runId = `smoke-${Date.now()}`;
  try {
    queue.createRun(scope, runId, {
      maxRequests: 8,
      maxRequestsPerHost: 8,
      maxConcurrentPerHost: 1,
      minHostIntervalMs: 0,
      maxAttempts: 2,
      retryBaseMs: 10,
      leaseMs: 30000,
    });
    async function verify(id, costUsd) {
      const grantArtifactId = grantQueuedVerification(queue, scope, {
        id: `${runId}-${id}`,
        runId,
        sourceUrl: "https://publisher.example/post",
        targetUrl: "https://brand.example/offer",
        expiresAt: Date.now() + 60000,
        retainRelationshipContext: true,
      });
      queue.enqueue(scope, {
        runId,
        dedupeKey: id,
        url: "https://publisher.example/post",
        payload: { kind: "verify_backlinks.v1", grantArtifactId },
      });
      return runNextQueuedVerification(queue, worker, runId, "worker", { costUsd });
    }
    const before = await verify("before", 0);
    assert.equal(before.observation.status, "confirmed");
    assert.equal(before.observation.relationship_context?.version, "html-relationship-context-v1");
    assert.match(before.observation.relationship_context.excerpt, /Local test article Offer/);
    const repairs = new RemediationStore(queue);
    repairs.create(scope, "remove-link", "controlled-unwanted-link", before.artifactId);
    repairs.createTask(scope, "remove-link", {
      title: "Remove the controlled HTML link",
      reference: "local-task:remove-link",
      patchDigest,
    });
    repairs.approve(scope, "remove-link", patchDigest, Date.now() + 60000);
    stage = "after";
    repairs.recordDeployment(scope, "remove-link", "local-http:controlled-after-html", patchDigest);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const after = await verify("after", null);
    assert.equal(after.observation.status, "not_found");
    assert.equal(
      repairs.recordRemeasurement(scope, "remove-link", after.artifactId).status,
      "verified",
    );
    repairs.create(scope, "blocked-case", "controlled-unwanted-link", before.artifactId);
    repairs.createTask(scope, "blocked-case", {
      title: "Check blocked remeasurement",
      reference: "local-task:blocked",
      patchDigest,
    });
    repairs.approve(scope, "blocked-case", patchDigest, Date.now() + 60000);
    repairs.recordDeployment(scope, "blocked-case", "local-http:controlled-challenge", patchDigest);
    stage = "blocked";
    await new Promise((resolve) => setTimeout(resolve, 2));
    const blocked = await verify("blocked", null);
    assert.equal(blocked.observation.status, "error");
    assert.equal(
      repairs.recordRemeasurement(scope, "blocked-case", blocked.artifactId).status,
      "inconclusive",
    );
    const telemetry = new PlatformTelemetry(queue).report(scope, runId, {
      expectedMeasurements: 3,
      minCompleteRatio: 1,
      maxP95Ms: 10000,
      maxKnownCostUsd: 0.01,
      requireKnownCosts: true,
    });
    assert.equal(telemetry.usage.requests, httpRequests);
    assert.equal(telemetry.requests.knownTotal, httpRequests);
    assert.equal(telemetry.bytes.knownTotal, httpBytes);
    assert.equal(telemetry.qualityGate.pass, false);
    const foreign = createTenantScope(
      { subject: "operator", tenantId: "other", projectIds: ["controlled"], role: "operator" },
      "controlled",
    );
    assert.equal(queue.getArtifact(foreign, before.artifactId), null);
    const report = {
      schema: "platform-smoke.v1",
      observedAt: new Date().toISOString(),
      runId,
      environment: {
        node: process.versions.node,
        transport: "test-only-loopback-relay",
        engine: "actual-verifyBacklinks",
        worker: "default-runNextQueuedVerification",
        externalRequests: 0,
      },
      localHttp: { requests: httpRequests, decodedBytes: httpBytes },
      remediation: {
        verified: repairs.get(scope, "remove-link"),
        blocked: repairs.get(scope, "blocked-case"),
      },
      tenantIsolation: "pass",
      telemetry,
      limitations: [
        "Controlled loopback smoke, not live-host or accuracy qualification",
        "No source API charge for local fixture; hosting/support cost not measured",
        "No SaaS, publication, billing, SSO or paid pilots",
      ],
    };
    writeFileSync(join(outDir, "platform-smoke.json"), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    const escaped = JSON.stringify(report, null, 2)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;");
    writeFileSync(
      join(outDir, "platform-dashboard.html"),
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RankProof local platform smoke</title><style>body{font:16px system-ui;max-width:1000px;margin:40px auto;padding:0 20px;color:#17243b;background:#f8fafc}main,pre{border:1px solid #dce2e9;border-radius:8px;padding:20px;background:white}pre{overflow:auto;font-size:13px}h1{font-size:26px}dt{font-weight:600}dd{margin:0 0 14px}</style><h1>RankProof local platform smoke</h1><p>Controlled local HTTP execution. No external host qualification.</p><main><dl><dt>Latency p50 / p95</dt><dd>${telemetry.latencyMs.p50.toFixed(2)} / ${telemetry.latencyMs.p95.toFixed(2)} ms</dd><dt>Requests / decoded bytes</dt><dd>${httpRequests} / ${httpBytes}</dd><dt>Complete measurements</dt><dd>${telemetry.measurement.complete} / 3</dd><dt>Known source cost / unknown cost samples</dt><dd>$${telemetry.costUsd.knownTotal} / ${telemetry.costUsd.unknownSamples}</dd><dt>Quality gate</dt><dd>FAIL: ${telemetry.qualityGate.reasons.join(", ")}</dd></dl></main><h2>Execution evidence</h2><pre>${escaped}</pre></html>`,
      { mode: 0o600 },
    );
    return { outDir, report };
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPin === undefined) delete process.env.RANKPROOF_PIN_DNS;
    else process.env.RANKPROOF_PIN_DNS = previousPin;
    if (previousRevision === undefined) delete process.env.RANKPROOF_SERVICE_REVISION;
    else process.env.RANKPROOF_SERVICE_REVISION = previousRevision;
    net.setHostResolverForTests(null);
    net.clearNetCache();
    clearRobotsCache();
    queue.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--output"))
    throw new Error("Usage: platform-smoke [--output private-directory]");
  runPlatformSmoke({ outDir: args[1] })
    .then(({ outDir, report }) =>
      process.stdout.write(`${JSON.stringify({ outDir, telemetry: report.telemetry })}\n`),
    )
    .catch((error) => {
      process.stderr.write(`${error.stack}\n`);
      process.exitCode = 1;
    });
}
