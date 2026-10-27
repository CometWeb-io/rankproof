import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
test("Web history persists ledgers, relation chronology and scoped SERP positions", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "";
  const server = await createServer({
    root,
    configFile: false,
    server: { middlewareMode: true },
    resolve: { alias: { "@": `${root}/src` } },
    appType: "custom",
  });
  try {
    const store = await server.ssrLoadModule("/src/lib/backlinks/store.server.ts");
    const { buildRunManifest } = await server.ssrLoadModule(
      "/src/lib/backlinks/measurement.server.ts",
    );
    const { verifyEvidenceLedger } = await server.ssrLoadModule(
      "/src/lib/backlinks/evidence-ledger.server.ts",
    );
    const at = "2026-10-26T00:00:00Z";
    const link = {
      id: "pair-one",
      sourceUrl: "https://publisher.example/one",
      targetUrl: "https://target.example/",
      sourceDomain: "publisher.example",
      state: "live",
      verified: true,
      discoveredVia: "bing",
      evidence: { kind: "html_anchor", observedAt: at, responseHash: "a".repeat(64) },
    };
    const scan = {
      queriedAt: at,
      target: { host: "target.example" },
      backlinks: [link],
      providerReports: [],
      stats: {
        backlinks: 1,
        referringDomains: 1,
        dofollow: 1,
        domainRating: 10,
        spamDomains: 0,
        lostLinks: 0,
        serpVisibility: 50,
      },
      analytics: { referringDomains: [{ domain: "publisher.example" }], health: { total: 80 } },
      serp: { queries: [], moves: [] },
      velocity: { verdict: "steady", perMonth: 0 },
      measurement: undefined as unknown,
    };
    scan.measurement = buildRunManifest({
      startedAt: at,
      mode: "full",
      budgetMs: 10000,
      maxVerify: 20,
      maxBacklinks: 20,
      sources: [{ id: "bing", status: "ok" }],
      coverage: {},
      edges: [],
      observed: [link],
      displayed: [link],
      queries: [],
    });
    const first = await store.attachHistory(scan);
    assert.equal(first.persisted, true);
    assert.equal(first.backlinks[0].firstObserved, at);
    const ledger = await store.loadEvidenceLedger("target.example", at);
    assert.equal(verifyEvidenceLedger(ledger), true);
    const later = structuredClone(scan);
    later.queriedAt = "2026-10-27T00:00:00Z";
    later.backlinks[0].evidence.observedAt = later.queriedAt;
    const second = await store.attachHistory(later);
    assert.equal(second.persisted, true);
    assert.equal(second.backlinks[0].firstObserved, new Date(at).toISOString());
    assert.equal(second.backlinks[0].lastConfirmed, later.queriedAt);
    assert.equal(second.delta.commonLinks, 1);
    const query = {
      keyword: "keyword",
      engine: "bing",
      targetPosition: 3,
      difficulty: 10,
      market: "pl",
      device: "desktop",
      depth: 10,
      status: "ok",
    };
    await store.saveSerpPositions("target.example", at, [query]);
    assert.equal((await store.loadPreviousPositions("target.example", later.queriedAt)).length, 0);
    assert.equal(
      (
        await store.loadPreviousPositions("target.example", later.queriedAt, {
          market: "us",
          device: "desktop",
          depth: 10,
        })
      ).length,
      0,
    );
    assert.equal(
      (
        await store.loadPreviousPositions("target.example", later.queriedAt, {
          market: "pl",
          device: "desktop",
          depth: 10,
        })
      )[0].position,
      3,
    );
  } finally {
    await server.close();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});
