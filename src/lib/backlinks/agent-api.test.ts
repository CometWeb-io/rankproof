import assert from "node:assert/strict";
import { test } from "node:test";
import { callAgent, createAgentApi } from "./agent-api.ts";
import { RankProofApiError, RankProofClient } from "./agent-api-client.ts";
import { AGENT_INPUT_SCHEMAS, validateAgentSchema } from "./agent-api-contract.ts";
import { agentResponseSchema } from "./agent-api-schemas.ts";
import { createObservationStore, SESSION_RETENTION } from "./agent-api-store.ts";
import { buildEvidenceLedger } from "./evidence-ledger.server.ts";
import type { ScanReport } from "./types.ts";

test("input schemas reject unknown fields, malformed statuses, huge workloads and SSRF before I/O", async () => {
  for (const [operation, body] of [
    [
      "verify_backlinks",
      { items: [{ source_url: "http://169.254.169.254/", target_url: "https://target.example/" }] },
    ],
    ["verify_backlinks", { items: [] }],
    ["serp_status", { url: "target.example", keywords: ["aa"], engines: ["unknown"] }],
    ["serp_status", { url: "target.example", keywords: ["  "] }],
    ["capabilities", { token: "unexpected" }],
    ["diff", { observations: [{ verification_status: "unverified" }] }],
    ["diff", { before_id: "a", after_id: "b", observations: [] }],
  ] as const) {
    const result = await callAgent(operation, body);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "invalid_input");
  }
  assert.equal((await callAgent("verify_evidence", { ledger: {} })).ok, true);
  assert.deepEqual(
    ((await callAgent("verify_evidence", { ledger: {} })) as { data?: unknown }).data,
    { valid: false, integrity_scope: "internal_hashes_only", persistence: "caller" },
  );
});

test("capabilities distinguish configured from live availability; imports do not create verification receipts", async () => {
  const api = createAgentApi();
  const result = await api("capabilities", {});
  assert.ok(result.ok);
  assert.ok(result.data.providers.every((row) => row.availability === "not-probed"));
  validateAgentSchema(result, agentResponseSchema("capabilities"));
  const imported = await api("import_dataset", {
    format: "json",
    dataset_id: "claimed",
    data: JSON.stringify([
      {
        source_url: "https://source.example/",
        target_url: "https://target.example/",
        status: "confirmed",
      },
    ]),
  });
  assert.ok(imported.ok);
  assert.equal(imported.data.records[0]!.verification_status, "unverified");
  assert.equal("observation_id" in imported.data.records[0]!, false);
  assert.equal((await api("get_evidence", { observation_id: "../../etc/passwd" })).ok, false);
});

test("TS SDK runtime validation rejects malformed success, malformed error, foreign operation and unknown version", async () => {
  const original = globalThis.fetch;
  const client = new RankProofClient("http://127.0.0.1:1");
  try {
    for (const value of [
      {
        ok: true,
        schema_version: "1",
        operation: "verify_backlinks",
        data: { results: [{ status: "confirmed" }] },
      },
      { ok: false, schema_version: "1", error: null },
      { ok: true, schema_version: "1", operation: "capabilities", data: {} },
      { ok: true, schema_version: "2", operation: "verify_backlinks", data: {} },
    ]) {
      globalThis.fetch = async () => Response.json(value);
      await assert.rejects(
        client.verifyBacklinks([
          { source_url: "https://source.example/", target_url: "https://target.example/" },
        ]),
        (error) => error instanceof RankProofApiError && error.code === "invalid_response",
      );
    }
    globalThis.fetch = async () =>
      Response.json(
        { ok: false, schema_version: "1", error: { code: "invalid_input", message: "Bad URL" } },
        { status: 400 },
      );
    await assert.rejects(
      client.capabilities(),
      (error) => error instanceof RankProofApiError && error.code === "invalid_input",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("bounded observation store evicts and expires receipts, isolates returned objects", () => {
  const store = createObservationStore();
  const first = store.save([]);
  for (let i = 0; i < SESSION_RETENTION.max_reports; i++) store.save([]);
  assert.throws(() => store.report(first.report_id), /unavailable/);
  const report = store.save([]);
  report.results.push({} as never);
  assert.deepEqual(store.report(report.report_id).results, []);
  const originalNow = Date.now;
  Date.now = () => originalNow() + (SESSION_RETENTION.ttl_seconds + 1) * 1000;
  try {
    assert.throws(() => store.report(report.report_id), /unavailable/);
  } finally {
    Date.now = originalNow;
  }
});

test("schema validation handles null, booleans, integer limits and Unicode code points", () => {
  for (const value of [null, false, "", 1])
    assert.throws(() => validateAgentSchema(value, AGENT_INPUT_SCHEMAS.capabilities));
  assert.throws(() =>
    validateAgentSchema(
      { ok: false, schema_version: "1", error: null },
      agentResponseSchema("capabilities"),
    ),
  );
  validateAgentSchema("🛰", { type: "string", maxLength: 1 });
  assert.throws(() => validateAgentSchema(21, { type: "integer", maximum: 20 }));
  assert.throws(() => validateAgentSchema("true", { type: "boolean" }));
});

test("relationship diff rejects spoofed confirmed destination and accepts fragment-only identity differences", async () => {
  const base = {
    source_url: "https://source.example/article",
    target_url: "https://target.example/path?ref=1",
    status: "confirmed",
    checked_at: "2026-10-27T01:00:00.000Z",
    final_url: "https://source.example/article",
    http_status: 200,
    anchor: "Reference",
    rel: "",
    reason: null,
    evidence_kind: "html_anchor",
    observation_method: "fetched_html",
    absence_scope: null,
    extraction_version: "fixture",
    identity_policy: "fixture",
    source_revision: null,
    response_hash: "a".repeat(64),
    raw_href: "https://target.example/path?ref=1#fragment",
    resolved_href: "https://target.example/path?ref=1#fragment",
  };
  for (const resolved_href of [
    "https://foreign.example/path?ref=1",
    "https://target.example/path?ref=2",
    "https://www.target.example/path?ref=1",
    "https://target.example/other?ref=1",
    "invalid",
  ]) {
    const result = await callAgent("diff", { observations: [{ ...base, resolved_href }] });
    assert.equal(result.ok, false, resolved_href);
    if (!result.ok) assert.equal(result.error.code, "invalid_input");
  }
  const accepted = await callAgent("diff", { observations: [base] });
  assert.ok(accepted.ok);
  assert.equal(accepted.data.comparison.status, "CONFIRMED");
  assert.equal(accepted.data.evidence_origin, "caller_supplied_untrusted");
});

test("agent integrity check consumes the engine ledger and detects tampering", async () => {
  const ledger = buildEvidenceLedger({
    target: { host: "target.example" },
    queriedAt: "2026-10-27T00:00:00.000Z",
    backlinks: [],
  } as unknown as ScanReport);
  const valid = await callAgent("verify_evidence", { ledger });
  assert.ok(valid.ok);
  assert.equal(valid.data.valid, true);
  const tampered = await callAgent("verify_evidence", {
    ledger: { ...ledger, host: "foreign.example" },
  });
  assert.ok(tampered.ok);
  assert.equal(tampered.data.valid, false);
});
