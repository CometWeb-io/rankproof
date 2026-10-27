import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DURABLE_RETENTION } from "./agent-api-store.ts";
import { createPersistentObservationStore } from "./agent-history.server.ts";
import { createAgentApi, type AgentObservation } from "./agent-api.ts";
import { createTenantScope } from "./tenant-scope.ts";

const principal = (tenantId = "tenant-a") =>
  createTenantScope(
    { subject: "operator", tenantId, projectIds: ["site"], role: "operator" },
    "site",
  );
const observation: AgentObservation = {
  source_url: "https://publisher.example/article",
  target_url: "https://brand.example/offer",
  status: "confirmed",
  checked_at: "2026-10-27T00:00:00.000Z",
  final_url: "https://publisher.example/article",
  http_status: 200,
  anchor: "Offer",
  rel: "",
  reason: null,
  evidence_kind: "html_anchor",
  observation_method: "fetched_html",
  absence_scope: null,
  extraction_version: "html-anchor-v4",
  identity_policy: "exact-http-url-v2",
  source_revision: "fixture",
  response_hash: "a".repeat(64),
  raw_href: "https://brand.example/offer",
  resolved_href: "https://brand.example/offer",
};

test("legacy v4 receipts stay readable while v5 rechecks cannot establish cross-version loss", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rankproof-agent-method-upgrade-"));
  const path = join(directory, "history.sqlite");
  const scope = principal();
  let store = createPersistentObservationStore(path, scope);
  try {
    const before = store.save([observation]);
    const after = store.save([
      {
        ...observation,
        extraction_version: "html-anchor-v5",
        checked_at: "2026-10-27T01:00:00.000Z",
        status: "not_found",
        anchor: null,
        rel: null,
        evidence_kind: null,
        absence_scope: "fetched_html",
        raw_href: null,
        resolved_href: null,
        response_hash: "b".repeat(64),
      },
    ]);
    store.close();
    store = createPersistentObservationStore(path, scope);
    const api = createAgentApi(store);
    const evidence = await api("get_evidence", {
      observation_id: before.results[0]!.observation_id,
    });
    assert.ok(evidence.ok);
    assert.equal(evidence.data.observation.extraction_version, "html-anchor-v4");
    const diff = await api("diff", {
      before_id: before.results[0]!.observation_id,
      after_id: after.results[0]!.observation_id,
    });
    assert.ok(diff.ok);
    assert.equal(diff.data.evidence_origin, "rankproof_history");
    assert.equal(diff.data.comparison.status, "UNKNOWN");
    assert.equal(diff.data.comparison.change, null);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("durable API evidence and comparable relationship survive a store restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rankproof-agent-history-"));
  const path = join(directory, "history.sqlite");
  const scope = principal();
  let store = createPersistentObservationStore(path, scope);
  try {
    const before = store.save([observation]);
    const after = store.save([
      {
        ...observation,
        status: "not_found",
        checked_at: "2026-10-27T01:00:00.000Z",
        anchor: null,
        rel: null,
        evidence_kind: null,
        absence_scope: "fetched_html",
        raw_href: null,
        resolved_href: null,
        response_hash: "b".repeat(64),
      },
    ]);
    store.close();
    store = createPersistentObservationStore(path, scope);
    const api = createAgentApi(store);
    const evidence = await api("get_evidence", {
      observation_id: before.results[0]!.observation_id,
    });
    assert.ok(evidence.ok);
    assert.equal(evidence.data.observation.status, "confirmed");
    assert.equal(evidence.data.persistence.kind, "bounded_sqlite");
    const diff = await api("diff", {
      before_id: before.results[0]!.observation_id,
      after_id: after.results[0]!.observation_id,
    });
    assert.ok(diff.ok);
    assert.equal(diff.data.evidence_origin, "rankproof_history");
    assert.equal(diff.data.comparison.change, "absent_in_representation");
    assert.equal(diff.data.comparison.scope, "fetched_html");
    const copy = store.report(before.report_id);
    copy.results[0]!.anchor = "mutated";
    assert.equal(store.report(before.report_id).results[0]!.anchor, "Offer");
    const other = createPersistentObservationStore(path, principal("tenant-b"));
    try {
      assert.throws(() => other.report(before.report_id), /unavailable/);
    } finally {
      other.close();
    }
    assert.throws(() => store.observation("../../private"), /Invalid|unavailable/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persistent evidence rejects forged confirmation and unsafe filesystem admission", () => {
  const directory = mkdtempSync(join(tmpdir(), "rankproof-agent-private-"));
  const path = join(directory, "history.sqlite");
  const scope = principal();
  const store = createPersistentObservationStore(path, scope);
  try {
    assert.throws(
      () => store.save([{ ...observation, resolved_href: "https://other.example/" }]),
      /target|destination|confirmation/i,
    );
    assert.throws(
      () => store.save([{ ...observation, response_hash: null }]),
      /evidence|hash|confirmation|invalid/i,
    );
    assert.throws(() => store.save([]), /1.*50|empty/i);
  } finally {
    store.close();
  }
  try {
    chmodSync(path, 0o644);
    assert.throws(() => createPersistentObservationStore(path, scope), /private|permission/i);
    chmodSync(path, 0o600);
    chmodSync(directory, 0o755);
    assert.throws(() => createPersistentObservationStore(path, scope), /private|permission/i);
  } finally {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persistent history is append-only, detects tampering and refuses full storage", () => {
  const directory = mkdtempSync(join(tmpdir(), "rankproof-agent-quota-"));
  const path = join(directory, "history.sqlite");
  const scope = principal();
  const store = createPersistentObservationStore(path, scope);
  const raw = new DatabaseSync(path);
  try {
    const report = store.save([observation]);
    assert.throws(
      () =>
        raw
          .prepare("UPDATE agent_verification_reports SET digest='x' WHERE id=?")
          .run(report.report_id),
      /append-only/,
    );
    assert.throws(
      () => raw.prepare("DELETE FROM agent_verification_reports WHERE id=?").run(report.report_id),
      /append-only/,
    );
    assert.throws(() => store.save([{ ...observation, reason: "x".repeat(1_048_576) }]), /1 MiB/);
    const insert = raw.prepare(
      "INSERT INTO agent_verification_reports(tenant,project,id,body,digest) VALUES(?,?,?,?,?)",
    );
    raw.exec("BEGIN");
    for (let index = 1; index < DURABLE_RETENTION.max_reports; index++) {
      // Administrative seeding exercises the real capacity boundary without 5000 network calls.
      insert.run(scope.tenantId, scope.projectId, randomUUID(), JSON.stringify(report), "seed");
    }
    raw.exec("COMMIT");
    assert.throws(() => store.save([observation]), /capacity exhausted/);
    assert.equal(store.report(report.report_id).results[0]!.status, "confirmed");
    raw.exec("DROP TRIGGER agent_reports_no_update");
    raw.prepare("UPDATE agent_verification_reports SET body='{}' WHERE id=?").run(report.report_id);
    assert.throws(() => store.report(report.report_id), /integrity/);
  } finally {
    raw.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
