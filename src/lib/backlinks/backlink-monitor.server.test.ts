import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BacklinkMonitor } from "./backlink-monitor.server.ts";
import { ScanQueue } from "./scan-queue.server.ts";
import { createTenantScope } from "./tenant-scope.ts";
import { clearNetCache, setHostResolverForTests } from "./net.server.ts";
import { clearRobotsCache } from "./robots.server.ts";

const scope = createTenantScope(
  { subject: "operator", tenantId: "local", projectIds: ["site"], role: "operator" },
  "site",
);
const pair = {
  source_url: "https://publisher.example/article",
  target_url: "https://brand.example/offer",
};
const hour = 3_600_000;
const present =
  '<html><body><article><a href="https://brand.example/offer">Original</a></article></body></html>';
const absent =
  "<html><body><article>The complete article now has no target link.</article></body></html>";

function fixture(t: import("node:test").TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "rankproof-monitor-"));
  const path = join(dir, "monitor.sqlite");
  const originalFetch = globalThis.fetch,
    originalPin = process.env.RANKPROOF_PIN_DNS;
  let html = present,
    status = 200,
    requests = 0;
  const base = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: base });
  process.env.RANKPROOF_PIN_DNS = "0";
  setHostResolverForTests(async () => ["93.184.216.34"]);
  globalThis.fetch = async (input) => {
    requests++;
    return String(input).endsWith("/robots.txt")
      ? new Response("", { status: 404 })
      : new Response(html, { status, headers: { "content-type": "text/html" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalPin === undefined) delete process.env.RANKPROOF_PIN_DNS;
    else process.env.RANKPROOF_PIN_DNS = originalPin;
    setHostResolverForTests(null);
    clearNetCache();
    clearRobotsCache();
    t.mock.timers.reset();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    path,
    base,
    set: (text: string, code = 200) => {
      html = text;
      status = code;
      clearNetCache();
      clearRobotsCache();
    },
    requests: () => requests,
  };
}

test("fixed exact cohort recurs across restart; fresh HTML absence alerts once with retained confirmation", async (t) => {
  const f = fixture(t);
  let monitor = new BacklinkMonitor(f.path, scope);
  const plan = monitor.create({
    id: "daily",
    pairs: [pair],
    firstAt: f.base,
    intervalMs: hour,
    occurrences: 4,
  });
  assert.equal(plan.endsAt, f.base + 3 * hour + plan.windowMs);
  const first = await monitor.tick("daily", "worker");
  assert.equal(first.receipt!.pairs[0]!.outcome, "present");
  assert.equal(first.receipt!.alerts.length, 0);
  monitor.close();
  t.mock.timers.setTime(f.base + hour);
  f.set(absent);
  monitor = new BacklinkMonitor(f.path, scope);
  const second = await monitor.tick("daily", "worker");
  assert.equal(second.receipt!.alerts[0]!.kind, "html_link_absent");
  assert.equal(second.receipt!.alerts[0]!.scope, "fetched_html");
  assert.ok(second.receipt!.alerts[0]!.beforeArtifactId);
  assert.ok(second.receipt!.alerts[0]!.afterArtifactId);
  assert.equal(second.receipt!.pairs[0]!.comparison!.lastConfirmed, new Date(f.base).toISOString());
  t.mock.timers.setTime(f.base + 2 * hour);
  const third = await monitor.tick("daily", "worker");
  assert.equal(third.receipt!.alerts.length, 0);
  t.mock.timers.setTime(f.base + 3 * hour);
  f.set(present);
  const fourth = await monitor.tick("daily", "worker");
  assert.equal(fourth.receipt!.alerts[0]!.kind, "link_reconfirmed");
  const exported = monitor.export("daily");
  assert.equal(exported.receipts.length, 4);
  assert.equal(exported.scheduleComplete, true);
  assert.equal(exported.receipts[1]!.previousDigest, exported.receipts[0]!.digest);
  monitor.close();
});

test("403/challenges/network failure are unknown and never link-loss alerts; original confirmation survives", async (t) => {
  const f = fixture(t);
  const monitor = new BacklinkMonitor(f.path, scope);
  monitor.create({
    id: "blocked",
    pairs: [pair],
    firstAt: f.base,
    intervalMs: hour,
    occurrences: 4,
  });
  await monitor.tick("blocked", "worker");
  for (let i = 1; i < 4; i++) {
    t.mock.timers.setTime(f.base + i * hour);
    if (i === 1) f.set("<html><title>Access denied</title></html>", 403);
    if (i === 2) f.set("<html><title>Just a moment</title></html>");
    if (i === 3)
      globalThis.fetch = async () => {
        throw new Error("Fixture connection failed");
      };
    const result = await monitor.tick("blocked", "worker");
    assert.equal(result.receipt!.alerts.length, 0);
    assert.equal(result.receipt!.pairs[0]!.outcome, "unavailable");
    assert.equal(
      result.receipt!.pairs[0]!.comparison!.lastConfirmed,
      new Date(f.base).toISOString(),
    );
  }
  monitor.close();
});

test("missed windows are visible, consume no request, and do not renew old grants", async (t) => {
  const f = fixture(t);
  const monitor = new BacklinkMonitor(f.path, scope);
  monitor.create({
    id: "expired",
    pairs: [pair],
    firstAt: f.base,
    intervalMs: hour,
    occurrences: 2,
  });
  t.mock.timers.setTime(f.base + hour + 20 * 60_000);
  const result = await monitor.tick("expired", "worker");
  assert.equal(result.state, "finished");
  assert.equal(f.requests(), 0);
  const exported = monitor.export("expired");
  assert.equal(exported.receipts.length, 2);
  for (const receipt of exported.receipts) {
    assert.equal(receipt.missedWindow, true);
    assert.equal(receipt.pairs[0]!.outcome, "unmeasured");
    assert.equal(receipt.alerts.length, 0);
  }
  monitor.close();
});

test("404 and changed final source URLs never fabricate comparable HTML loss", async (t) => {
  const f = fixture(t);
  const monitor = new BacklinkMonitor(f.path, scope);
  monitor.create({
    id: "redirect",
    pairs: [pair],
    firstAt: f.base,
    intervalMs: hour,
    occurrences: 3,
  });
  await monitor.tick("redirect", "worker");
  t.mock.timers.setTime(f.base + hour);
  f.set("Not found", 404);
  const gone = await monitor.tick("redirect", "worker");
  assert.equal(gone.receipt!.pairs[0]!.outcome, "source_unavailable");
  assert.equal(gone.receipt!.alerts.length, 0);
  t.mock.timers.setTime(f.base + 2 * hour);
  globalThis.fetch = async (input) =>
    String(input).endsWith("/robots.txt")
      ? new Response("", { status: 404 })
      : String(input) === pair.source_url
        ? new Response(null, { status: 302, headers: { location: "/login" } })
        : new Response(absent, { headers: { "content-type": "text/html" } });
  clearNetCache();
  clearRobotsCache();
  const moved = await monitor.tick("redirect", "worker");
  assert.equal(moved.receipt!.pairs[0]!.outcome, "incomparable_absence");
  assert.equal(moved.receipt!.alerts.length, 0);
  monitor.close();
});

test("bounded schedule validates before creating any run, and workers cannot invent plans or evidence", async (t) => {
  const f = fixture(t);
  const monitor = new BacklinkMonitor(f.path, scope);
  for (const change of [
    { intervalMs: 1 },
    { occurrences: 31 },
    { pairs: Array(11).fill(pair) },
    { pairs: [pair, pair] },
    { windowMs: hour + 1 },
    { firstAt: f.base - 120_000 },
  ])
    assert.throws(() =>
      monitor.create({
        id: "bad",
        pairs: [pair],
        firstAt: f.base,
        intervalMs: hour,
        occurrences: 2,
        ...change,
      }),
    );
  const workerScope = createTenantScope(
    { subject: "worker", tenantId: "local", projectIds: ["site"], role: "worker" },
    "site",
  );
  const worker = new BacklinkMonitor(f.path, workerScope);
  assert.throws(
    () =>
      worker.create({
        id: "forged",
        pairs: [pair],
        firstAt: f.base,
        intervalMs: hour,
        occurrences: 1,
      }),
    /denied/,
  );
  worker.close();
  assert.equal(f.requests(), 0);
  monitor.close();
});

test("a crashed leased job rechecks after lease expiry and produces one committed receipt", async (t) => {
  const f = fixture(t);
  let monitor = new BacklinkMonitor(f.path, scope);
  const plan = monitor.create({
    id: "crash",
    pairs: [pair],
    firstAt: f.base,
    intervalMs: hour,
    occurrences: 1,
  });
  monitor.close();
  const queue = new ScanQueue(f.path);
  const lease = queue.claim(scope, plan.cycles[0]!.runId, "crashed");
  assert.ok(lease);
  queue.close();
  t.mock.timers.setTime(f.base + 120_001);
  monitor = new BacklinkMonitor(f.path, scope);
  const result = await monitor.tick("crash", "restarted");
  assert.equal(result.receipt!.pairs[0]!.outcome, "present");
  assert.equal(monitor.export("crash").receipts.length, 1);
  monitor.close();
});

test("private-path admission rejects public permissions and exported receipts reject tampering", async (t) => {
  const f = fixture(t);
  let monitor = new BacklinkMonitor(f.path, scope);
  monitor.create({
    id: "integrity",
    pairs: [pair],
    firstAt: f.base,
    intervalMs: hour,
    occurrences: 1,
  });
  await monitor.tick("integrity", "worker");
  monitor.close();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(f.path);
  db.exec("UPDATE platform_artifacts SET body='{}' WHERE id LIKE 'monitor.receipt.%'");
  db.close();
  monitor = new BacklinkMonitor(f.path, scope);
  assert.throws(() => monitor.export("integrity"), /integrity/);
  monitor.close();
  chmodSync(f.path, 0o644);
  assert.throws(() => new BacklinkMonitor(f.path, scope), /private/);
});

test("opted-in actual worker retains versioned first-match attributes/context and emits observed changes only", async (t) => {
  const f = fixture(t);
  const monitor = new BacklinkMonitor(f.path, scope);
  const plan = monitor.create({
    id: "attributes",
    pairs: [pair],
    firstAt: f.base,
    intervalMs: hour,
    occurrences: 2,
  });
  assert.equal(plan.retainRelationshipContext, true);
  const first = await monitor.tick("attributes", "worker");
  const queue = new ScanQueue(f.path);
  const grant = queue.getArtifact(scope, plan.cycles[0]!.jobs[0]!.grantArtifactId)!.value as {
    retainRelationshipContext: boolean;
  };
  assert.equal(grant.retainRelationshipContext, true);
  const stored = queue.getArtifact(scope, first.receipt!.pairs[0]!.observationArtifactId!)!
    .value as { observation: import("./verify-api.server.ts").BacklinkObservation };
  assert.equal(
    stored.observation.relationship_context!.primary_match,
    "first_matching_html_anchor",
  );
  assert.equal(stored.observation.relationship_context!.placement_is_heuristic, true);
  assert.ok((stored.observation.relationship_context!.excerpt?.length ?? 0) <= 400);
  queue.close();
  t.mock.timers.setTime(f.base + hour);
  f.set(
    '<html><body><footer>Changed context<a rel="nofollow" href="https://brand.example/offer"><img src="/image.png" alt="Changed" /></a></footer></body></html>',
  );
  const changed = await monitor.tick("attributes", "worker");
  assert.equal(changed.receipt!.alerts[0]!.kind, "link_attributes_changed");
  assert.equal(changed.receipt!.pairs[0]!.comparison!.currentEvidence!.linkKind, "image");
  assert.equal(changed.receipt!.pairs[0]!.comparison!.previousEvidence!.linkKind, "text");
  assert.notEqual(
    changed.receipt!.pairs[0]!.comparison!.currentEvidence!.contextHash,
    changed.receipt!.pairs[0]!.comparison!.previousEvidence!.contextHash,
  );
  monitor.close();
});

test("generic artifacts and forged completed jobs cannot become trusted monitoring observations", async (t) => {
  const f = fixture(t);
  const monitor = new BacklinkMonitor(f.path, scope);
  const plan = monitor.create({
    id: "forgery",
    pairs: [pair],
    firstAt: f.base,
    intervalMs: hour,
    occurrences: 1,
  });
  const queue = new ScanQueue(f.path),
    cycle = plan.cycles[0]!,
    lease = queue.claim(scope, cycle.runId, "forged-worker")!;
  const grant = queue.getArtifact(scope, cycle.jobs[0]!.grantArtifactId)!;
  queue.putArtifact(scope, "generic-evidence", {
    schema: "queue-verification.v1",
    jobId: lease.id,
    attempt: lease.attempt,
    grantDigest: grant.digest,
    observation: { status: "confirmed" },
  });
  queue.complete(scope, lease, { artifactId: "generic-evidence", grantDigest: grant.digest });
  queue.close();
  await assert.rejects(() => monitor.tick("forgery", "worker"), /Untrusted/);
  assert.equal(f.requests(), 0);
  monitor.close();
});

test("rehashing a forged alert still fails proof reconstruction, and plans cannot absorb extra jobs", async (t) => {
  const f = fixture(t);
  let monitor = new BacklinkMonitor(f.path, scope);
  monitor.create({
    id: "false-alert",
    pairs: [pair],
    firstAt: f.base,
    intervalMs: hour,
    occurrences: 1,
  });
  await monitor.tick("false-alert", "worker");
  monitor.close();
  const { DatabaseSync } = await import("node:sqlite"),
    { createHash } = await import("node:crypto");
  const db = new DatabaseSync(f.path);
  const stored = db
    .prepare("SELECT id,body FROM platform_artifacts WHERE id LIKE 'monitor.receipt.%'")
    .get()!;
  const value = JSON.parse(String(stored.body));
  value.alerts = [{ kind: "html_link_absent", pairIndex: 0 }];
  const body = JSON.stringify(value);
  db.prepare("UPDATE platform_artifacts SET body=?,digest=? WHERE id=?").run(
    body,
    createHash("sha256").update(body).digest("hex"),
    stored.id,
  );
  db.close();
  monitor = new BacklinkMonitor(f.path, scope);
  assert.throws(() => monitor.export("false-alert"), /integrity\/provenance/);
  monitor.close();
  monitor = new BacklinkMonitor(f.path, scope);
  const plan = monitor.create({
    id: "extra-job",
    pairs: [pair],
    firstAt: f.base,
    intervalMs: hour,
    occurrences: 1,
  });
  const queue = new ScanQueue(f.path);
  queue.enqueue(scope, {
    runId: plan.cycles[0]!.runId,
    dedupeKey: "extra",
    url: "https://other.example/",
  });
  queue.close();
  await assert.rejects(() => monitor.tick("extra-job", "worker"), /outside its exact cohort/);
  monitor.close();
});

test("preclaim runtime failure reaches the caller without polling or hiding a queued job", async (t) => {
  const f = fixture(t);
  const monitor = new BacklinkMonitor(f.path, scope);
  const plan = monitor.create({
    id: "preclaim",
    pairs: [pair],
    firstAt: f.base,
    intervalMs: hour,
    occurrences: 1,
  });
  const failure = t.mock.method(ScanQueue.prototype, "claim", () => {
    throw new Error("Fixture preclaim failure");
  });
  await assert.rejects(() => monitor.tick("preclaim", "worker"), /Fixture preclaim failure/);
  assert.equal(f.requests(), 0);
  failure.mock.restore();
  const queue = new ScanQueue(f.path);
  assert.equal(queue.getJob(scope, plan.cycles[0]!.jobs[0]!.id)!.status, "queued");
  assert.equal(queue.usage(scope, plan.cycles[0]!.runId).requests, 0);
  queue.close();
  const result = await monitor.tick("preclaim", "worker");
  assert.equal(result.receipt!.pairs[0]!.outcome, "present");
  monitor.close();
});

test("confirmation on a different resolved source is present but cannot recover prior HTML absence", async (t) => {
  const f = fixture(t);
  const monitor = new BacklinkMonitor(f.path, scope);
  t.after(() => monitor.close());
  monitor.create({
    id: "recovery-resource",
    pairs: [pair],
    firstAt: f.base,
    intervalMs: hour,
    occurrences: 3,
  });
  await monitor.tick("recovery-resource", "worker");
  t.mock.timers.setTime(f.base + hour);
  f.set(absent);
  const missing = await monitor.tick("recovery-resource", "worker");
  assert.equal(missing.receipt!.pairs[0]!.outcome, "html_absent");
  assert.deepEqual(
    missing.receipt!.alerts.map(({ kind }) => kind),
    ["html_link_absent"],
  );
  t.mock.timers.setTime(f.base + 2 * hour);
  globalThis.fetch = async (input) =>
    String(input).endsWith("/robots.txt")
      ? new Response("", { status: 404 })
      : String(input) === pair.source_url
        ? new Response(null, { status: 302, headers: { location: "/different-article" } })
        : new Response(present, { headers: { "content-type": "text/html" } });
  clearNetCache();
  clearRobotsCache();
  const moved = await monitor.tick("recovery-resource", "worker");
  assert.equal(moved.receipt!.pairs[0]!.outcome, "present");
  assert.equal(
    moved.receipt!.pairs[0]!.attempt!.finalUrl,
    "https://publisher.example/different-article",
  );
  assert.equal(moved.receipt!.alerts.length, 0);
  assert.deepEqual(
    monitor.export("recovery-resource").alerts.map(({ kind }) => kind),
    ["html_link_absent"],
  );
});
