import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  collectConnector,
  connectorResult,
  datasetConnector,
  importDataset,
  type DataConnector,
} from "./connectors.ts";
import { ownerConnector } from "./connectors.server.ts";

const pair = { source_url: "https://source.example/a", target_url: "https://target.example/b" };

test("BYO JSON retains every source row, duplicate and provider claim without confirming links", async () => {
  const rows = [{ ...pair, verified: true, provider: "external", nested: { note: "żółw" } }, pair];
  const data = JSON.stringify(rows);
  const result = await collectConnector(datasetConnector, "backlinks.discover", {
    format: "json",
    data,
    dataset_id: "export-1",
  });
  assert.equal(result.status, "ok");
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records[0]!.provenance.original_record, rows[0]);
  assert.equal(result.records[0]!.verification_status, "unverified");
  assert.equal(
    result.records[0]!.provenance.dataset_sha256,
    createHash("sha256").update(data).digest("hex"),
  );
  assert.deepEqual(
    result.records.map((row) => row.provenance.row_number),
    [1, 2],
  );
  assert.equal(
    importDataset({ format: "json", data: "[]", dataset_id: "empty" }).status,
    "no-results",
  );
});

test("CSV handles BOM, CRLF, quoted commas/newlines/quotes and retains provenance", () => {
  const data =
    '\uFEFFsource_url,target_url,note\r\nhttps://source.example/a,https://target.example/b,"comma, line\nquoted ""text"""\r\n';
  const result = importDataset({ format: "csv", data, dataset_id: "csv-1" });
  assert.equal(result.records[0]!.provenance.original_record.note, 'comma, line\nquoted "text"');
  assert.equal(
    result.records[0]!.provenance.dataset_sha256,
    createHash("sha256").update(data).digest("hex"),
  );
});

test("malformed/oversized/private-url datasets fail atomically, never silently skip rows", () => {
  for (const data of [
    '"unclosed',
    "source_url,target_url\na,b,c",
    "source_url,source_url\na,b",
    'source_url,target_url\n"a"x,b',
  ]) {
    assert.throws(() => importDataset({ format: "csv", data, dataset_id: "bad" }));
  }
  for (const data of [
    JSON.stringify([pair, { ...pair, source_url: "http://127.0.0.1/secret" }]),
    JSON.stringify([null]),
    "{}",
    "[broken",
    JSON.stringify(Array(1001).fill(pair)),
    "x".repeat(1_000_001),
  ]) {
    assert.throws(() => importDataset({ format: "json", data, dataset_id: "bad" }));
  }
});

test("connector boundaries distinguish no-results, unavailable source, capability and malformed provider results", async () => {
  const connector: DataConnector<unknown, unknown> = {
    manifest: {
      schema_version: "1",
      id: "test",
      capabilities: ["serp.query"],
      credentials: "none",
    },
    collect: async () => connectorResult("test", "blocked", [], "HTTP 403"),
  };
  assert.equal((await collectConnector(connector, "serp.query", {})).status, "blocked");
  await assert.rejects(collectConnector(connector, "backlinks.discover", {}), /does not support/);
  assert.throws(() => connectorResult("test", "ok", []));
  assert.throws(() => connectorResult("test", "blocked", [pair]));
  connector.collect = async () => ({}) as never;
  await assert.rejects(collectConnector(connector, "serp.query", {}), /Invalid connector result/);
});

test("empty BYO owner credentials cannot fall through to server environment credentials", async () => {
  const oldGoogle = process.env.GOOGLE_OAUTH_ACCESS_TOKEN,
    oldBing = process.env.BING_WEBMASTER_API_KEY;
  process.env.GOOGLE_OAUTH_ACCESS_TOKEN = "server-private-token";
  process.env.BING_WEBMASTER_API_KEY = "server-private-key";
  try {
    for (const connector of [
      ownerConnector({ source: "google", credentials: {} }),
      ownerConnector({ source: "bing", apiKey: "" }),
    ]) {
      assert.equal((await connector.collect({ url: "owned.example" })).status, "not-configured");
      assert.equal(JSON.stringify(connector.manifest).includes("private"), false);
    }
  } finally {
    if (oldGoogle === undefined) delete process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
    else process.env.GOOGLE_OAUTH_ACCESS_TOKEN = oldGoogle;
    if (oldBing === undefined) delete process.env.BING_WEBMASTER_API_KEY;
    else process.env.BING_WEBMASTER_API_KEY = oldBing;
  }
});
