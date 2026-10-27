import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { ScanQueue, type ScanQueuePolicy } from "./scan-queue.server.ts";
import { createTenantScope, type TenantPrincipal } from "./tenant-scope.ts";
import { assertScanQueueRuntime } from "./scan-queue-runtime.ts";

const principal: TenantPrincipal = {
  subject: "operator",
  tenantId: "tenant-a",
  projectIds: ["project"],
  role: "operator",
};
const scope = createTenantScope(principal, "project");
const policy: ScanQueuePolicy = {
  maxRequests: 3,
  maxRequestsPerHost: 2,
  maxConcurrentPerHost: 1,
  minHostIntervalMs: 10,
  maxAttempts: 2,
  retryBaseMs: 50,
  leaseMs: 100,
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rankproof-queue-"));
  const path = join(dir, "queue.sqlite");
  let now = 1000;
  const queue = new ScanQueue(path, () => now);
  queue.createRun(scope, "run", policy);
  return {
    queue,
    path,
    dir,
    advance: (ms: number) => {
      now += ms;
    },
    dispose: () => {
      queue.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("feature runtime guard leaves base Node requirement independent", () => {
  for (const v of ["22.0.0", "22.12.9", "23.3.0", "20.19.0", "bad"])
    assert.throws(() => assertScanQueueRuntime(v), /requires Node/);
  for (const v of ["22.13.0", "22.23.1", "23.4.0", "24.0.0"])
    assert.doesNotThrow(() => assertScanQueueRuntime(v));
});

test("dedupe, due schedule, retry backoff, expiry fencing and persisted budget", () => {
  const f = fixture();
  try {
    const a = f.queue.enqueue(scope, {
      runId: "run",
      dedupeKey: "a",
      url: "https://example.org/a",
      availableAt: 1010,
    });
    assert.equal(f.queue.enqueue(scope, { runId: "run", dedupeKey: "a", url: a.url }).id, a.id);
    assert.throws(
      () =>
        f.queue.enqueue(scope, { runId: "run", dedupeKey: "a", url: "https://example.org/other" }),
      /conflicts/,
    );
    assert.equal(f.queue.claim(scope, "run", "worker"), null);
    f.advance(10);
    const lease = f.queue.claim(scope, "run", "worker")!;
    assert.equal(lease.attempt, 1);
    assert.equal(f.queue.reserveRequest(scope, lease, a.url).requests, 1);
    assert.throws(() => f.queue.reserveRequest(scope, lease, a.url), /cooldown/);
    assert.throws(() => f.queue.reserveRequest(scope, lease, "https://other.org/"), /host differs/);
    f.queue.fail(scope, lease, "temporary network error");
    assert.equal(f.queue.claim(scope, "run", "next"), null);
    f.advance(50);
    const retry = f.queue.claim(scope, "run", "next")!;
    assert.equal(retry.attempt, 2);
    assert.notEqual(retry.token, lease.token);
    for (const operation of [
      () => f.queue.complete(scope, lease, {}),
      () => f.queue.heartbeat(scope, lease),
      () => f.queue.reserveRequest(scope, lease, a.url),
      () => f.queue.fail(scope, lease, "stale"),
    ])
      assert.throws(operation, /stale/);
    assert.equal(f.queue.reserveRequest(scope, retry, a.url).hostRequests, 2);
    f.advance(10);
    assert.throws(() => f.queue.reserveRequest(scope, retry, a.url), /budget exhausted/);
    f.queue.complete(scope, retry, { checked: true });
    assert.equal(f.queue.getJob(scope, a.id)!.status, "done");
    const reopened = new ScanQueue(f.path, () => 2000);
    try {
      assert.equal(reopened.usage(scope, "run").requests, 2);
      assert.deepEqual(reopened.getJob(scope, a.id)!.result, { checked: true });
    } finally {
      reopened.close();
    }
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
  } finally {
    f.dispose();
  }
});

test("per-host concurrency, exhausted crash attempts and total budget fail closed", () => {
  const f = fixture();
  try {
    const a = f.queue.enqueue(scope, { runId: "run", dedupeKey: "a", url: "https://a.example/a" });
    f.queue.enqueue(scope, {
      runId: "run",
      dedupeKey: "b",
      url: "https://a.example/b",
      availableAt: 1001,
    });
    const first = f.queue.claim(scope, "run", "one")!;
    assert.equal(f.queue.claim(scope, "run", "two"), null);
    f.advance(100);
    const recovered = f.queue.claim(scope, "run", "two")!;
    assert.equal(recovered.id, a.id);
    assert.throws(() => f.queue.complete(scope, first, {}), /stale/);
    f.advance(100);
    const other = f.queue.claim(scope, "run", "three")!;
    assert.notEqual(other.id, a.id);
    assert.equal(f.queue.getJob(scope, a.id)!.status, "failed");
    f.queue.reserveRequest(scope, other, other.url);
    f.advance(10);
    f.queue.reserveRequest(scope, other, other.url);
    f.queue.complete(scope, other, {});
    f.queue.enqueue(scope, { runId: "run", dedupeKey: "c", url: "https://b.example/c" });
    const c = f.queue.claim(scope, "run", "three")!;
    f.queue.reserveRequest(scope, c, c.url);
    f.advance(10);
    assert.throws(() => f.queue.reserveRequest(scope, c, c.url), /budget exhausted/);
    f.queue.fail(scope, c, "stop", false);
    assert.equal(f.queue.getJob(scope, c.id)!.status, "failed");
  } finally {
    f.dispose();
  }
});

test("tenant/project/role isolation applies to jobs, grants and artifacts", () => {
  const f = fixture();
  try {
    const foreign = createTenantScope({ ...principal, tenantId: "tenant-b" }, "project");
    const project = createTenantScope({ ...principal, projectIds: ["other"] }, "other");
    const reader = createTenantScope({ ...principal, role: "reader" }, "project");
    const worker = createTenantScope({ ...principal, role: "worker" }, "project");
    const a = f.queue.enqueue(scope, { runId: "run", dedupeKey: "a", url: "https://example.org/" });
    f.queue.putArtifact(scope, "artifact", { secret: "a" });
    for (const outsider of [foreign, project]) {
      assert.equal(f.queue.getJob(outsider, a.id), null);
      assert.equal(f.queue.getArtifact(outsider, "artifact"), null);
      assert.equal(f.queue.listArtifacts(outsider, "artifact").total, 0);
      assert.throws(() => f.queue.claim(outsider, "run", "worker"), /unavailable/);
      assert.throws(() => f.queue.usage(outsider, "run"), /unavailable/);
    }
    f.queue.createRun(foreign, "run", policy);
    f.queue.putArtifact(foreign, "artifact", { secret: "b" });
    assert.deepEqual(f.queue.getArtifact(scope, "artifact")!.value, { secret: "a" });
    assert.deepEqual(f.queue.getArtifact(foreign, "artifact")!.value, { secret: "b" });
    assert.throws(() => f.queue.putArtifact(scope, "artifact", { secret: "changed" }), /immutable/);
    assert.throws(() => f.queue.putArtifact(worker, "scan-grant.fake", {}), /denied/);
    assert.throws(() => f.queue.putArtifact(worker, "remediation.fake", {}), /denied/);
    assert.throws(() => f.queue.putArtifact(scope, "verification.fake", {}), /live verification/);
    assert.throws(() => f.queue.claim(reader, "run", "reader"), /denied/);
    assert.throws(() => f.queue.putArtifact(reader, "x", {}), /denied/);
    assert.throws(() => f.queue.getArtifact({ ...scope }, "artifact"), /denied/);
    assert.throws(() => createTenantScope(null, "project"), /denied/);
    assert.throws(() => createTenantScope(principal, "not-a-member"), /denied/);
    assert.throws(() => f.queue.getArtifact(scope, "../../etc/passwd"), /Invalid platform id/);
  } finally {
    f.dispose();
  }
});

test(
  "two processes atomically claim once; SIGKILL, restart and fencing recover without budget refund",
  { timeout: 15000 },
  async () => {
    const f = fixture();
    const children: ReturnType<typeof fork>[] = [];
    try {
      const a = f.queue.enqueue(scope, {
        runId: "run",
        dedupeKey: "a",
        url: "https://example.org/",
      });
      const code = `
      import {ScanQueue} from ${JSON.stringify(new URL("./scan-queue.server.ts", import.meta.url).href)};
      import {createTenantScope} from ${JSON.stringify(new URL("./tenant-scope.ts", import.meta.url).href)};
      const q = new ScanQueue(process.argv[1], () => 1000);
      const s = createTenantScope(${JSON.stringify(principal)}, 'project');
      const lease = q.claim(s, 'run', process.argv[2]);
      if (lease) q.reserveRequest(s, lease, lease.url);
      process.send(lease);
      process.on('message', () => {});
    `;
      const start = (id: string) => {
        const child = fork(f.path, [id], {
          execArgv: ["--experimental-strip-types", "--input-type=module", "--eval", code],
          silent: true,
        });
        children.push(child);
        return new Promise<{ child: typeof child; lease: ReturnType<ScanQueue["claim"]> }>(
          (resolve, reject) => {
            let stderr = "";
            child.stderr?.on("data", (chunk) => {
              stderr += chunk;
            });
            child.once("error", reject);
            child.once("message", (lease) =>
              resolve({ child, lease: lease as ReturnType<ScanQueue["claim"]> }),
            );
            child.once("exit", (exit) => {
              if (exit) reject(new Error(`child exit ${exit}: ${stderr}`));
            });
          },
        );
      };
      const claims = await Promise.all([start("one"), start("two")]);
      assert.equal(claims.filter((claim) => claim.lease).length, 1);
      const winner = claims.find((claim) => claim.lease)!;
      const exited = once(winner.child, "exit");
      winner.child.kill("SIGKILL");
      await exited;
      f.advance(100);
      const recovered = f.queue.claim(scope, "run", "restarted")!;
      assert.equal(recovered.id, a.id);
      assert.equal(recovered.attempt, 2);
      assert.notEqual(recovered.token, winner.lease!.token);
      assert.throws(() => f.queue.complete(scope, winner.lease!, {}), /stale/);
      assert.equal(f.queue.usage(scope, "run").requests, 1);
      f.queue.complete(scope, recovered, { recovered: true });
      assert.equal(f.queue.getJob(scope, a.id)!.status, "done");
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      f.dispose();
    }
  },
);
