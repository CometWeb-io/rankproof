import assert from "node:assert/strict";
import { test } from "node:test";
import { partitionLinkGraphs } from "./link-state.ts";
import { buildAnalytics, buildReferringDomains, buildTargetPages } from "./score.ts";
import { computeDomainRating, computeUrlRating, pageRank, rankToScore } from "./graph.ts";
import { buildRunManifest, measurementComparability } from "./measurement.server.ts";
import type { Backlink, SiteSnapshot } from "./types.ts";

const site = { host: "target.example", domain: "target.example" } as SiteSnapshot;
function link(overrides: Partial<Backlink> = {}): Backlink {
  return {
    id: "live",
    sourceUrl: "https://source.example/a",
    sourceHost: "source.example",
    sourceDomain: "source.example",
    sourceTitle: "Source",
    sourceLang: "en",
    targetUrl: "https://target.example/",
    targetPath: "/",
    anchor: "Target",
    anchorType: "brand",
    rel: "dofollow",
    effectiveFollow: true,
    placement: "content",
    sitewide: false,
    discoveredVia: "bing",
    verified: true,
    firstSeen: null,
    httpStatus: 200,
    targetStatus: 200,
    domainScore: 60,
    spamScore: 4,
    relevance: 50,
    targetFinalUrl: null,
    state: "live",
    lastSeen: null,
    flags: [],
    ...overrides,
  };
}
const current = link();
const lost = link({
  id: "old",
  state: "lost",
  sourceDomain: "old.example",
  sourceHost: "old.example",
  domainScore: 100,
});
const reported = link({
  id: "reported",
  state: "reported",
  sourceDomain: "provider.example",
  domainScore: 100,
});
function profile(rows: Backlink[]) {
  const graphs = partitionLinkGraphs(rows, site.domain);
  const ranks = rankToScore(pageRank(graphs.live.edges));
  const analytics = buildAnalytics(rows, [], site, { ranks });
  return { analytics, rating: computeDomainRating(analytics.referringDomains) };
}

test("archive and provider records never increase current graph, domain or URL ratings", () => {
  assert.deepEqual(profile([current, lost, reported]), profile([current]));
  assert.deepEqual(buildReferringDomains([lost, reported]), []);
  assert.deepEqual(buildTargetPages([lost, reported], site), []);
  assert.equal(computeUrlRating([lost, reported]), 0);
  assert.equal(computeUrlRating([current, lost, reported]), computeUrlRating([current]));
  const graphs = partitionLinkGraphs([current, lost, reported], site.domain);
  assert.deepEqual(graphs.live.links, [current]);
  assert.deepEqual(graphs.historical.links, [lost]);
  assert.deepEqual(graphs.unverified.links, [reported]);
});

test("historical records from the SAME domain cannot alter current counts, anchor shares or page scores", () => {
  const sameDomain = {
    ...lost,
    sourceDomain: current.sourceDomain,
    sourceHost: current.sourceHost,
    anchorType: "exact-match" as const,
    sitewide: true,
  };
  assert.deepEqual(profile([current, sameDomain]), profile([current]));
});

test("unverified and contradictory evidence cannot enter a current profile", () => {
  const unknown = link({ verified: false });
  const archive = link({
    evidence: { kind: "archive_anchor", method: "archive_html" } as Backlink["evidence"],
  });
  const provider = link({
    evidence: { kind: "provider_report", method: "provider_api" } as Backlink["evidence"],
  });
  assert.deepEqual(profile([unknown, archive, provider]), profile([]));
});

function manifest(rows: Backlink[]) {
  const graphs = partitionLinkGraphs(rows, site.domain);
  return buildRunManifest({
    startedAt: "2026-10-27T00:00:00Z",
    mode: "full",
    budgetMs: 1000,
    maxVerify: 64,
    maxBacklinks: 400,
    sources: [],
    coverage: {},
    edges: graphs.live.edges,
    observed: rows,
    displayed: rows,
    queries: [],
  });
}
test("history-only edits do not become score changes and graph scope is declared", () => {
  assert.equal(
    measurementComparability(manifest([current]), manifest([current, lost, reported])).scores,
    true,
  );
  assert.equal(manifest([current]).scores.graphScope, "live");
});

test("archive recovery issues do not change current profile health and absent samples earn no health credits", () => {
  const clean = buildAnalytics([current], [], site);
  const withArchive = buildAnalytics([current, lost], [], site, { lostLinks: [lost] });
  assert.deepEqual(withArchive.health, clean.health);
  assert.ok(withArchive.issues.some((issue) => issue.id === "lost"));
  assert.equal(buildAnalytics([], [], site).health.total, 0);
});

test("actual scan separates an archive candidate from current counts and graph scores", async () => {
  const { runScan } = await import("./engine.server.ts");
  const { clearNetCache, setHostResolverForTests } = await import("./net.server.ts");
  const { clearRobotsCache } = await import("./robots.server.ts");
  const originalFetch = globalThis.fetch;
  const originalPin = process.env.RANKPROOF_PIN_DNS;
  delete process.env.RANKPROOF_PIN_DNS;
  setHostResolverForTests(async () => ["93.184.216.34"]);
  let includeArchive = false;
  const html = (body: string) =>
    new Response(
      `<html><head><title>Target guide</title></head><body><article>${body}${"Readable factual article content. ".repeat(160)}</article></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
    if (url.hostname === "target.example" || url.hostname === "www.target.example")
      return html("Target website");
    if (url.hostname === "source.example")
      return html(
        url.pathname === "/live"
          ? '<a href="https://target.example/">Target</a>'
          : "We mention target.example without linking.",
      );
    if (url.hostname === "archive.org" && url.pathname === "/wayback/available") {
      return Response.json(
        includeArchive && url.searchParams.get("url") === "https://source.example/history"
          ? {
              archived_snapshots: {
                closest: {
                  available: true,
                  url: "https://web.archive.org/web/20200101000000/https://source.example/history",
                  timestamp: "20200101000000",
                },
              },
            }
          : {},
      );
    }
    if (url.hostname === "web.archive.org" && url.pathname.startsWith("/web/"))
      return html('<a href="https://target.example/">Archived target</a>');
    return Response.json({});
  };
  try {
    const scan = async () => {
      clearNetCache();
      clearRobotsCache();
      const result = await runScan("target.example", {
        mode: "full",
        profile: "quick",
        budgetMs: 30_000,
        skipSiteAudit: true,
        seedUrls: ["https://source.example/live", "https://source.example/history"],
      });
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("Fixture scan refused");
      return result.report;
    };
    const before = await scan();
    includeArchive = true;
    const after = await scan();
    assert.equal(after.backlinks.filter((row) => row.state === "lost").length, 1);
    assert.equal(after.stats.lostLinks, 1);
    assert.equal(after.stats.backlinks, before.stats.backlinks);
    assert.equal(after.stats.referringDomains, before.stats.referringDomains);
    assert.equal(after.stats.domainRating, before.stats.domainRating);
    assert.deepEqual(after.analytics.anchors, before.analytics.anchors);
    assert.deepEqual(after.measurement!.graph, before.measurement!.graph);
    assert.equal(after.measurement!.graphPartitions.historical.edges, 1);
    assert.equal(after.measurement!.scores.graphScope, "live");
  } finally {
    globalThis.fetch = originalFetch;
    clearNetCache();
    clearRobotsCache();
    if (originalPin === undefined) delete process.env.RANKPROOF_PIN_DNS;
    else process.env.RANKPROOF_PIN_DNS = originalPin;
  }
});

test("legacy mixed-population reports cannot fabricate current count deltas", async () => {
  const { rowToDelta } = await import("./history-diff.ts");
  const currentManifest = manifest([current]);
  const legacy = structuredClone(currentManifest);
  delete (legacy.cohort as Partial<typeof legacy.cohort>).population;
  const report = {
    target: site,
    queriedAt: "2026-10-27T12:00:00Z",
    measurement: currentManifest,
    backlinks: [current],
    stats: { backlinks: 1, referringDomains: 1 },
    analytics: buildAnalytics([current], [], site),
  } as unknown as import("./types.ts").ScanReport;
  assert.equal(
    rowToDelta(report, {
      queried_at: "2026-10-26T12:00:00Z",
      backlinks: 2,
      referring_domains: 2,
      dofollow: 1,
      domain_rating: 40,
      health: 70,
      spam_domains: 0,
      lost_links: 1,
      link_ids: [current.id, lost.id],
      domains: [current.sourceDomain, lost.sourceDomain],
      measurement: legacy,
    }),
    null,
  );
});
