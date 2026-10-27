import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchGoogleOrganicViaProvider } from "./serp-providers.ts";
const base = { baseUrl: "https://provider.example", resolve: async () => ["93.184.216.34"] };
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

test("OpenSERP v2 request pins market/language/offset and filters organic results", async () => {
  const result = await fetchGoogleOrganicViaProvider("żółta łódź", {
    ...base,
    market: "pl",
    page: 1,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/google/search");
      assert.equal(url.searchParams.get("text"), "żółta łódź");
      assert.equal(url.searchParams.get("region"), "pl");
      assert.equal(url.searchParams.get("lang"), "pl");
      assert.equal(url.searchParams.get("start"), "10");
      assert.equal(init?.redirect, "manual");
      return json({
        results: [
          { type: "ad", url: "https://ad.example" },
          { type: "organic", url: "https://result.example", rank: 11 },
        ],
      });
    },
  });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]!.position, 11);
});

test("failed providers, redirects and unsupported device cannot become no-results", async () => {
  for (const envelope of [
    { error: "blocked" },
    { meta: { engines_failed: ["google"] }, results: [] },
    { meta: { engine_errors: { google: "timeout" } }, results: [] },
    null,
  ]) {
    await assert.rejects(
      fetchGoogleOrganicViaProvider("q", { ...base, fetchImpl: async () => json(envelope) }),
    );
  }
  await assert.rejects(
    fetchGoogleOrganicViaProvider("q", {
      ...base,
      fetchImpl: async () =>
        new Response("", { status: 302, headers: { location: "http://127.0.0.1" } }),
    }),
    /redirect/,
  );
  await assert.rejects(
    fetchGoogleOrganicViaProvider("q", {
      ...base,
      device: "mobile",
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
    }),
    /mobile device/,
  );
  await assert.rejects(
    fetchGoogleOrganicViaProvider("q", {
      ...base,
      fetchImpl: async () => json({ results: [{ title: "broken", url: "not a URL" }] }),
    }),
    /supported|invalid/,
  );
});

test("provider bodies are bounded rather than silently truncated", async () => {
  let canceled = false;
  const largeBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(2_000_001));
    },
    cancel() {
      canceled = true;
    },
  });
  await assert.rejects(
    fetchGoogleOrganicViaProvider("q", {
      ...base,
      fetchImpl: async () =>
        new Response(largeBody, { headers: { "content-type": "application/json" } }),
    }),
    /2 MB/,
  );
  assert.equal(canceled, true);
});

test("provider cancels an unfinished stream after fatal UTF8 decoding", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0xff]));
    },
    cancel() {
      canceled = true;
    },
  });
  await assert.rejects(
    fetchGoogleOrganicViaProvider("q", {
      ...base,
      fetchImpl: async () =>
        new Response(body, { headers: { "content-type": "application/json" } }),
    }),
  );
  assert.equal(canceled, true);
});
