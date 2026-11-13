import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  RankProofClient,
  RankProofError,
  lostLinks,
  parseVerifyResponse,
  verdictOf,
} from "./rankproof-client.ts";

const fixture = async (name: string) =>
  JSON.parse(await readFile(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8"));

test("parses the golden response; every verdict is represented", async () => {
  const results = parseVerifyResponse(await fixture("verify-response.json"));
  assert.deepEqual(
    new Set(results.map(verdictOf)),
    new Set(["meets", "deviates", "missing", "unverified"]),
  );
});

test("lost links never include measurement gaps", async () => {
  const lost = lostLinks(
    parseVerifyResponse(await fixture("verify-response-previous.json")),
    parseVerifyResponse(await fixture("verify-response.json")),
  );
  assert.ok(lost.length > 0);
  assert.ok(lost.every((o) => verdictOf(o) !== "unverified"));
});

test("batches, auth header, capability check and errors", async () => {
  const health = await fixture("health.json");
  const calls: { url: string; body: { items: unknown[] } | null; auth: string | null }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({
      url,
      body: init.body ? JSON.parse(String(init.body)) : null,
      auth: headers.get("authorization"),
    });
    if (url.endsWith("/health")) return Response.json(health);
    const { items } = JSON.parse(String(init.body));
    return Response.json({
      ok: true,
      schema_version: "1",
      results: items.map((i: object) => ({ ...i, status: "error" })),
    });
  }) as typeof fetch;
  const client = new RankProofClient({ baseUrl: "http://x.test/", token: "t", fetch: fake });
  await client.require("backlinks.verify.contract.v1");
  await assert.rejects(client.require("backlinks.verify.render.v1"), RankProofError);
  const items = Array.from({ length: 120 }, (_, i) => ({
    source_url: `https://s${i}.example/`,
    target_url: "https://t.example/",
  }));
  const results = await client.verify(items);
  assert.equal(results.length, 120);
  assert.deepEqual(
    calls.filter((c) => c.body).map((c) => c.body!.items.length),
    [50, 50, 20],
  );
  assert.ok(calls.every((c) => c.auth === "Bearer t"));
  assert.equal(verdictOf(results[0]!), "unverified");
  const failing = new RankProofClient({
    baseUrl: "http://x.test",
    fetch: (async () =>
      Response.json({ ok: false, error: "bad" }, { status: 400 })) as typeof fetch,
  });
  await assert.rejects(failing.verify(items.slice(0, 1)), (e: RankProofError) => e.status === 400);
});
