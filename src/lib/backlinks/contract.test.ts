import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { contractFixtures } from "./contract-fixtures.ts";

test("API documents match the committed contract fixtures (run `npm run contract:update` on purpose)", async () => {
  for (const [name, value] of Object.entries(contractFixtures())) {
    const committed = JSON.parse(
      await readFile(new URL(`../../../contract/fixtures/${name}`, import.meta.url), "utf8"),
    );
    assert.deepEqual(JSON.parse(JSON.stringify(value)), committed, name);
  }
});

test("schema 1 stays additive: every field a v1 consumer reads is still present", async () => {
  const response = contractFixtures()["verify-response.json"] as {
    results: Record<string, unknown>[];
  };
  const v1 = [
    "source_url",
    "target_url",
    "status",
    "checked_at",
    "final_url",
    "http_status",
    "anchor",
    "rel",
    "reason",
    "evidence_kind",
    "observation_method",
    "absence_scope",
    "extraction_version",
    "identity_policy",
    "source_revision",
    "response_hash",
    "raw_href",
    "resolved_href",
    "matching_anchors",
  ];
  for (const result of response.results) {
    for (const field of v1) assert.ok(field in result, `${field} missing`);
  }
});
