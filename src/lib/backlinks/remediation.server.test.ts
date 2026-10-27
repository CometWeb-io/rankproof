import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { ScanQueue } from "./scan-queue.server.ts";
import { RemediationStore, type RemediationRecord } from "./remediation.server.ts";
import { createTenantScope } from "./tenant-scope.ts";
import type { BacklinkObservation } from "./verify-api.server.ts";

const scope = createTenantScope(
  { subject: "operator", tenantId: "tenant", projectIds: ["project"], role: "operator" },
  "project",
);
const worker = createTenantScope(
  { subject: "worker", tenantId: "tenant", projectIds: ["project"], role: "worker" },
  "project",
);
const patch = "f".repeat(64);

function fixture() {
  let now = Date.now();
  let tickMs = 0;
  let seq = 0;
  const clock = () => (now += tickMs);
  const queue = new ScanQueue(":memory:", clock);
  const store = new RemediationStore(queue, clock);
  queue.createRun(scope, "run", {
    maxRequests: 20,
    maxRequestsPerHost: 20,
    maxConcurrentPerHost: 1,
    minHostIntervalMs: 0,
    maxAttempts: 3,
    retryBaseMs: 1,
    leaseMs: 10000,
  });
  function evidence(changes: Partial<BacklinkObservation> = {}, complete = true) {
    const key = `e-${seq++}`;
    const observation: BacklinkObservation = {
      source_url: "https://source.example/post",
      target_url: "https://target.example/offer",
      status: "confirmed",
      checked_at: new Date(now).toISOString(),
      final_url: "https://source.example/post",
      http_status: 200,
      anchor: "Offer",
      rel: "",
      reason: null,
      evidence_kind: "html_anchor",
      observation_method: "fetched_html",
      absence_scope: null,
      extraction_version: "extractor-test-v1",
      identity_policy: "exact-test-v1",
      source_revision: "unit-test-revision",
      response_hash: "a".repeat(64),
      raw_href: "https://target.example/offer",
      resolved_href: "https://target.example/offer",
      matching_anchors: [
        {
          raw_href: "https://target.example/offer",
          resolved_href: "https://target.example/offer",
          anchor: "Offer",
          rel: "",
        },
      ],
      ...changes,
    };
    const grantId = `scan-grant.${key}`;
    const grantDigest = queue.putArtifact(scope, grantId, {
      kind: "scan-verification-grant.v1",
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      runId: "run",
      expiresAt: now + 100000,
      pair: { source_url: observation.source_url, target_url: observation.target_url },
    });
    queue.enqueue(scope, {
      runId: "run",
      dedupeKey: key,
      url: observation.source_url,
      payload: { kind: "verify_backlinks.v1", grantArtifactId: grantId },
    });
    const lease = queue.claim(worker, "run", "worker")!;
    const artifactId = queue.recordVerification(worker, lease, observation);
    if (complete) queue.complete(worker, lease, { artifactId, grantDigest });
    return { artifactId, lease, observation };
  }
  function deployed() {
    store.create(scope, "repair", "unwanted-link", evidence().artifactId);
    store.createTask(scope, "repair", {
      title: "Remove the controlled link",
      reference: "local-task:remove-link",
      patchDigest: patch,
    });
    store.approve(scope, "repair", patch, now + 1000);
    now += 10;
    store.recordDeployment(scope, "repair", "local-deployment:fixture-v2", patch);
    now += 10;
  }
  return {
    queue,
    store,
    evidence,
    deployed,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    tickEachRead: () => {
      tickMs = 1;
    },
  };
}

for (const transition of ["approval", "deployment"] as const) {
  test(`${transition} is one persisted event when the clock advances on every read`, () => {
    const f = fixture();
    try {
      f.store.create(scope, "repair", "unwanted-link", f.evidence().artifactId);
      f.store.createTask(scope, "repair", {
        title: "Remove link",
        reference: "local:x",
        patchDigest: patch,
      });
      const expiresAt = f.now() + 1000;
      if (transition === "deployment") f.store.approve(scope, "repair", patch, expiresAt);
      f.tickEachRead();
      const record =
        transition === "approval"
          ? f.store.approve(scope, "repair", patch, expiresAt)
          : f.store.recordDeployment(scope, "repair", "local:deployed", patch);
      const eventAt =
        transition === "approval" ? record.grant!.grantedAt : record.deployment!.deployedAt;
      assert.equal(eventAt, record.recordedAt);
      assert.deepEqual(f.store.get(scope, "repair"), record);
      assert.equal(record.grant!.expiresAt, expiresAt);
      f.advance(1000);
      assert.throws(
        () => f.store.recordDeployment(scope, "repair", "local:expired", patch),
        /expired/,
      );
      assert.equal(
        f.store.get(scope, "repair")!.version,
        record.version,
        "rejected expiry must not append an event",
      );
    } finally {
      f.queue.close();
    }
  });
}

test("closed loop requires matching operator approval, deployment, and fresh comparable worker evidence", () => {
  const f = fixture();
  try {
    const baseline = f.evidence().artifactId;
    f.store.create(scope, "repair", "unwanted-link", baseline);
    assert.throws(() => f.store.recordDeployment(scope, "repair", "local:x", patch), /grant/);
    f.store.createTask(scope, "repair", {
      title: "Remove controlled link",
      reference: "local-task:x",
      patchDigest: patch,
    });
    assert.throws(() => f.store.approve(worker, "repair", patch, f.now() + 1000), /denied/);
    assert.throws(() => f.store.approve(scope, "repair", "b".repeat(64), f.now() + 1000), /match/);
    f.store.approve(scope, "repair", patch, f.now() + 1000);
    assert.throws(
      () => f.store.recordDeployment(scope, "repair", "local:x", "b".repeat(64)),
      /match/,
    );
    f.advance(10);
    f.store.recordDeployment(scope, "repair", "local:x", patch);
    f.advance(10);
    const after = f.evidence({
      status: "not_found",
      evidence_kind: null,
      absence_scope: "fetched_html",
      response_hash: "b".repeat(64),
      anchor: null,
      matching_anchors: [],
    }).artifactId;
    const verified = f.store.recordRemeasurement(scope, "repair", after);
    assert.equal(verified.status, "verified");
    assert.equal(verified.version, 4);
    assert.ok(verified.previousDigest);
    assert.equal(f.queue.listArtifacts(scope, "remediation.").total, 5);
  } finally {
    f.queue.close();
  }
});

test("forged absence, orphan result, replay, other URL/method/revision never produce verified", () => {
  const f = fixture();
  try {
    f.deployed();
    f.queue.putArtifact(scope, "forged", {
      kind: "remediation-observation.v1",
      cohortDigest: "a".repeat(64),
      observedAt: f.now(),
      result: "absent",
    });
    assert.throws(() => f.store.recordRemeasurement(scope, "repair", "forged"), /trusted worker/);
    for (const change of [
      { response_hash: "a".repeat(64) },
      { target_url: "https://target.example/another", response_hash: "b".repeat(64) },
      { extraction_version: "changed", response_hash: "b".repeat(64) },
      { identity_policy: "changed", response_hash: "b".repeat(64) },
      { source_revision: "changed", response_hash: "b".repeat(64) },
    ]) {
      const after = f.evidence({
        status: "not_found",
        evidence_kind: null,
        absence_scope: "fetched_html",
        ...change,
      }).artifactId;
      assert.throws(
        () => f.store.recordRemeasurement(scope, "repair", after),
        /Replayed|comparable/,
      );
      assert.equal(f.store.get(scope, "repair")!.status, "deployed");
      f.advance(10);
    }
    const orphan = f.evidence(
      {
        status: "not_found",
        evidence_kind: null,
        absence_scope: "fetched_html",
        response_hash: "c".repeat(64),
      },
      false,
    );
    assert.throws(
      () => f.store.recordRemeasurement(scope, "repair", orphan.artifactId),
      /Invalid remediation/,
    );
    f.advance(10000);
    assert.throws(
      () => f.queue.recordVerification(worker, orphan.lease, orphan.observation),
      /stale/,
    );
  } finally {
    f.queue.close();
  }
});

test("blocked, HTTP errors, changed redirect and unknown bytes cannot establish measured absence", () => {
  const f = fixture();
  try {
    f.deployed();
    const blocked = f.evidence({
      status: "error",
      evidence_kind: null,
      reason: "browser challenge",
      http_status: 403,
      response_hash: "b".repeat(64),
    }).artifactId;
    assert.equal(f.store.recordRemeasurement(scope, "repair", blocked).status, "inconclusive");
    for (const change of [
      { http_status: 404, absence_scope: "http_resource" as const },
      { response_hash: null },
      { final_url: "https://source.example/moved" },
    ]) {
      f.advance(10);
      const after = f.evidence({
        status: "not_found",
        evidence_kind: null,
        absence_scope: "fetched_html",
        response_hash: "c".repeat(64),
        ...change,
      }).artifactId;
      assert.equal(f.store.recordRemeasurement(scope, "repair", after).status, "inconclusive");
    }
    f.advance(1000);
    assert.throws(() => f.store.recordRemeasurement(scope, "repair", blocked), /expired/);
  } finally {
    f.queue.close();
  }
});

test("baseline must be real confirmed HTML and tenant-local; imports never get worker provenance", () => {
  const f = fixture();
  try {
    const fabricated = {
      schema: "queue-verification.v1",
      observation: { status: "confirmed", response_hash: "a".repeat(64) },
    };
    f.queue.putArtifact(scope, "fake-worker-envelope", fabricated);
    assert.throws(
      () => f.store.create(scope, "fake", "finding", "fake-worker-envelope"),
      /trusted worker/,
    );
    const notFound = f.evidence({ status: "not_found", evidence_kind: null }).artifactId;
    assert.throws(() => f.store.create(scope, "fake", "finding", notFound), /Baseline/);
    const other = createTenantScope(
      { subject: "operator", tenantId: "other", projectIds: ["project"], role: "operator" },
      "project",
    );
    assert.throws(() => f.store.create(other, "fake", "finding", notFound), /trusted worker/);
  } finally {
    f.queue.close();
  }
});

test("highest-version generic artifacts cannot impersonate workflow state; malformed stored records fail closed", () => {
  const f = fixture();
  try {
    const fake = {
      schema: "remediation.v1",
      id: "repair",
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      version: 99999999,
      status: "verified",
    };
    const prefix = `remediation.${createHash("sha256").update("repair").digest("hex")}.v.`;
    const key = `${prefix}99999999`;
    assert.throws(() => f.queue.putArtifact(scope, key, fake), /validated workflow/);
    assert.equal(f.store.get(scope, "repair"), null);
    assert.throws(
      () => f.queue.recordRemediation(scope, fake as unknown as RemediationRecord),
      /Invalid remediation/,
    );
    // Simulate an old/untrusted artifact row and storage corruption, beyond the public write API.
    const db = Reflect.get(f.queue, "db") as import("node:sqlite").DatabaseSync;
    const body = JSON.stringify(fake);
    const hash = createHash("sha256").update(body).digest("hex");
    db.prepare(
      "INSERT INTO platform_artifacts(tenant,project,id,body,digest,origin) VALUES(?,?,?,?,?,?)",
    ).run(scope.tenantId, scope.projectId, key, body, hash, "operator_artifact");
    assert.throws(() => f.store.get(scope, "repair"), /origin/);
    assert.throws(
      () =>
        f.store.createTask(scope, "repair", {
          title: "x",
          reference: "local:x",
          patchDigest: patch,
        }),
      /origin/,
    );
    db.prepare("UPDATE platform_artifacts SET origin='remediation-store.v1' WHERE id=?").run(key);
    assert.throws(() => f.store.get(scope, "repair"), /Invalid remediation record/);
    db.prepare("DELETE FROM platform_artifacts WHERE id=?").run(key);
    f.deployed();
    const valid = f.store.get(scope, "repair")!;
    assert.throws(
      () =>
        f.queue.recordRemediation(scope, {
          ...valid,
          version: 4,
          status: "verified",
          grant: undefined,
        }),
      /Invalid remediation/,
    );
    assert.equal(f.store.get(scope, "repair")!.status, "deployed");
  } finally {
    f.queue.close();
  }
});
