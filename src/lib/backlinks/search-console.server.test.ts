import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchSearchConsole } from "./search-console.server.ts";

type GscRequest = { startDate: string; endDate: string; dimensions?: string[] };

test("Search Console property totals are not inferred from truncated keyword rows", async () => {
  const original = globalThis.fetch;
  const requests: GscRequest[] = [];
  try {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? "{}")) as GscRequest;
      requests.push(request);
      const rows = !request.dimensions
        ? [{ clicks: 500, impressions: 12_000, ctr: 500 / 12_000, position: 7.2 }]
        : request.dimensions.includes("page")
          ? [{ keys: ["https://example.com/"], clicks: 10, impressions: 100, position: 3 }]
          : [{ keys: ["one query"], clicks: 10, impressions: 100, position: 3 }];
      return new Response(JSON.stringify({ rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const data = await fetchSearchConsole("example.com", {
      credentials: { accessToken: "synthetic-test-token" },
      property: "sc-domain:example.com",
      days: 28,
      rowLimit: 10,
    });
    assert.ok(data?.connected);
    assert.equal(data.totals.clicks, 500);
    assert.equal(data.totals.impressions, 12_000);
    assert.equal(data.queries[0]?.clicks, 10);
    assert.equal(requests.length, 4);
    const current = requests.find((request) => request.dimensions?.[0] === "page");
    assert.ok(current);
    const dayMs = 86_400_000;
    assert.equal((Date.parse(current.endDate) - Date.parse(current.startDate)) / dayMs, 27);
    const queryRanges = requests.filter((request) => request.dimensions?.[0] === "query");
    assert.equal(queryRanges.length, 2);
    assert.equal(
      Date.parse(queryRanges[0]!.startDate) - Date.parse(queryRanges[1]!.endDate),
      dayMs,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Search Console does not mislabel truncated rows as totals when aggregation fails", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? "{}")) as GscRequest;
      const status = request.dimensions ? 200 : 503;
      return new Response(
        JSON.stringify({
          rows: [{ keys: ["partial query"], clicks: 9, impressions: 90, position: 2 }],
        }),
        { status, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const result = await fetchSearchConsole("example.com", {
      credentials: { accessToken: "synthetic-test-token" },
      property: "sc-domain:example.com",
      days: 28,
    });
    assert.equal(result?.connected, false);
    assert.equal(result?.totals.clicks, 0);
    assert.match(result?.error ?? "", /property-wide totals/);
  } finally {
    globalThis.fetch = original;
  }
});
