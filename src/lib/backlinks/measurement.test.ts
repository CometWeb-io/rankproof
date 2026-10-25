import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { buildRunManifest, measurementComparability, type Coverage } from "./measurement.server.ts";
import { hydrateProviderReport, runScan } from "./engine.server.ts";
import { clearNetCache, Budget, setHostResolverForTests } from "./net.server.ts";
import { clearRobotsCache } from "./robots.server.ts";
import { DOMAIN_POLICY, normalizeUrl, pageKey } from "./parse.ts";
import { backlinkId, sortBacklinks, capPerDomain, buildReferringDomains } from "./score.ts";
import { buildVelocity } from "./segments.ts";
import { backlinksCsv, domainsCsv, reportHtml } from "./export.ts";
import { scanGdelt } from "./sources.server.ts";
import { verifyPages } from "./verify.server.ts";
import { verifyBacklinks } from "./verify-api.server.ts";
import { pageRank, rankToScore, computeDomainRating, type DomainEdge } from "./graph.ts";
import { rowToDelta } from "./history-diff.ts";
import { diffReport } from "./history.ts";
import type { Backlink, ReferringDomain, ScanReport, SerpQuery, TrendPoint } from "./types.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/measurement-v1.json", import.meta.url), "utf8"),
);
const originalFetch = globalThis.fetch;
process.env.RANKPROOF_SERVICE_REVISION = "frozen-measurement-fixture-v1";
setHostResolverForTests(async () => ["93.184.216.34"]);
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearNetCache();
  clearRobotsCache();
});
function serve(html: string, type = "text/html") {
  globalThis.fetch = async (input) =>
    String(input).endsWith("/robots.txt")
      ? new Response("", { status: 404 })
      : new Response(html, { headers: { "content-type": type } });
}

test("frozen exact identities preserve signed/business URLs and anchor edits", () => {
  assert.equal(normalizeUrl(fixture.signed), fixture.signed);
  assert.equal(normalizeUrl(`${fixture.base}#fragment`), fixture.base);
  for (const other of fixture.distinct) assert.notEqual(pageKey(fixture.base), pageKey(other));
  const pair = { sourceUrl: fixture.base, targetUrl: fixture.target };
  assert.equal(backlinkId({ ...pair, anchor: "Old" }), backlinkId({ ...pair, anchor: "New" }));
  assert.equal(backlinkId({ ...pair, sourceUrl: `${fixture.base}#x` }), backlinkId(pair));
  assert.notEqual(
    backlinkId(pair),
    backlinkId({ ...pair, targetUrl: fixture.target.toLowerCase() }),
  );
  assert.equal(DOMAIN_POLICY, "suffix-subset-v1-not-full-psl");
});

test("discovery records actual base-resolved href, all provenance and response hash, once per exact pair", async () => {
  serve(fixture.html);
  const coverage: Coverage = {};
  const { backlinks } = await verifyPages(
    [{ url: fixture.base, title: "", via: "bing", sources: ["github", "webmaster"] }],
    { host: "target.example", brandTokens: [], limit: 2, budget: new Budget(10_000), coverage },
  );
  assert.equal(backlinks.length, 1);
  const b = backlinks[0]!;
  assert.equal(b.targetUrl, fixture.target);
  assert.equal(b.evidence!.kind, "html_anchor");
  assert.equal(b.evidence!.requestedSourceUrl, fixture.base);
  assert.equal(b.evidence!.resolvedHref, `${fixture.target}#first`);
  assert.equal(b.evidence!.rawHref, "Offer?sku=ABC&amp;ref=keep&amp;x=1&amp;x=2#first");
  assert.match(b.evidence!.responseHash!, /^[a-f0-9]{64}$/);
  assert.deepEqual(b.discoverySources, ["bing", "github", "webmaster"]);
  for (const via of b.discoverySources!) {
    assert.equal(coverage[via]!.admitted, 1);
    assert.equal(coverage[via]!.validHtml, 1);
    assert.equal(coverage[via]!.confirmedPairs, 1);
  }
});

test("provider verified flags are not fetched-HTML confirmation and bad representations stay unconfirmed", async () => {
  const reported = hydrateProviderReport(
    {
      sourceUrl: fixture.base,
      targetUrl: fixture.target,
      verified: true,
      effectiveFollow: true,
      discoveredVia: "github",
    },
    "target.example",
    [],
  );
  assert.equal(reported!.verified, false);
  assert.equal(reported!.state, "reported");
  assert.equal(reported!.effectiveFollow, false);
  assert.equal(reported!.placement, "unknown");
  assert.equal(reported!.evidence!.kind, "provider_report");
  for (const [html, type] of [
    [fixture.noLink, "text/html"],
    [fixture.html, "application/json"],
    ["<title>Just a moment</title>" + fixture.html, "text/html"],
  ]) {
    clearNetCache();
    clearRobotsCache();
    serve(html, type);
    const result = await verifyPages([{ url: fixture.base, title: "", via: "github" }], {
      host: "target.example",
      brandTokens: [],
      limit: 1,
      budget: new Budget(10_000),
    });
    assert.equal(result.backlinks.length, 0);
  }
});

test("readable JS-added link has HTML-only absence; mixed-rel occurrences stay separate evidence", async () => {
  serve(fixture.jsOnly);
  const body = { items: [{ source_url: fixture.base, target_url: fixture.target }] };
  const absence = (await verifyBacklinks(body)).results[0]!;
  assert.equal(absence.status, "not_found");
  assert.equal(absence.absence_scope, "fetched_html");
  assert.equal(absence.evidence_kind, null);
  assert.match(absence.reason!, /rendered-page presence is unknown/);
  clearNetCache();
  clearRobotsCache();
  serve(fixture.html);
  const confirmed = (await verifyBacklinks(body)).results[0]!;
  assert.deepEqual(
    confirmed.matching_anchors.map((a) => a.rel),
    ["nofollow", ""],
  );
});

test("candidate admission reports duplicate, domain-cap, limit and time exclusions", async () => {
  serve(fixture.html);
  const coverage: Coverage = {};
  const pages = [
    "https://source.example/One",
    "https://source.example/One",
    "https://source.example/Two",
    "https://second.example/Three",
  ].map((url) => ({ url, title: "", via: "bing" as const }));
  const result = await verifyPages(pages, {
    host: "target.example",
    brandTokens: [],
    limit: 1,
    perDomain: 1,
    budget: new Budget(10_000),
    coverage,
  });
  assert.equal(result.backlinks.length, 1);
  assert.equal(coverage.bing!.duplicate, 1);
  assert.equal(coverage.bing!.domainCap, 1);
  assert.equal(coverage.bing!.limit, 1);
  const skipped: Coverage = {};
  await verifyPages(pages.slice(0, 1), {
    host: "target.example",
    brandTokens: [],
    limit: 1,
    budget: new Budget(2000),
    coverage: skipped,
  });
  assert.equal(skipped.bing!.timeSkipped, 1);
  assert.equal(skipped.bing!.attempted, 0);
});

const query = {
  keyword: "frozen keyword",
  engine: "bing",
  market: "pl",
  device: "desktop",
  depth: 10,
  status: "ok",
  targetPosition: 5,
} as SerpQuery;
const observed = {
  id: "pair-v2:frozen",
  sourceDomain: "linker.example",
  discoveredVia: "bing",
  state: "live",
  domainScore: 60,
  spamScore: 4,
  effectiveFollow: true,
  placement: "content",
  domainFirstArchivedAt: "2001-01-01",
} as Backlink;
const edges: DomainEdge[] = [
  { from: "linker.example", to: "target.example", weight: 3 },
  { from: "other.example", to: "linker.example", weight: 1 },
];
function manifest(extra: Partial<Parameters<typeof buildRunManifest>[0]> = {}) {
  return buildRunManifest({
    startedAt: "2026-10-25T00:00:00Z",
    mode: "full",
    budgetMs: 58_000,
    maxVerify: 64,
    maxBacklinks: 400,
    sources: [{ id: "bing", status: "ok" }],
    coverage: {},
    edges,
    observed: [observed],
    displayed: [],
    queries: [query],
    ...extra,
  });
}

test("frozen graph perturbation quantifies score sensitivity and blocks progress comparison", () => {
  const extra = Array.from({ length: 20 }, (_, i) => ({
    from: `neighbor${i}.example`,
    to: "outside.example",
    weight: 1,
  }));
  const rating = (graph: DomainEdge[]) =>
    computeDomainRating([
      {
        domainScore: 60,
        spamScore: 4,
        dofollow: 1,
        contentLinks: 1,
        rank: rankToScore(pageRank(graph)).get("linker.example")!,
      } as ReferringDomain,
    ]);
  assert.equal(rating(edges), 19);
  assert.equal(rating([...edges, ...extra]), 17);
  const base = manifest();
  assert.equal(base.observed.pairs, 1);
  assert.equal(base.displayed.omittedPairs, 1);
  assert.equal(base.rendering.enabled, false);
  assert.deepEqual(measurementComparability(base, manifest()), { scores: true, visibility: true });
  assert.equal(
    measurementComparability(base, manifest({ edges: [...edges, ...extra] })).scores,
    false,
  );
  assert.equal(
    measurementComparability(base, manifest({ sources: [{ id: "bing", status: "error" }] })).scores,
    false,
  );
  assert.equal(
    measurementComparability(
      base,
      manifest({ observed: [{ ...observed, domainFirstArchivedAt: null }] }),
    ).scores,
    false,
  );
});

test("visibility comparison requires identical successfully observed query cohorts and scope", () => {
  const base = manifest();
  for (const queries of [
    [query, { ...query, engine: "mojeek" as const }],
    [{ ...query, status: "error" as const }],
    [{ ...query, market: "us" as const }],
    [{ ...query, keyword: "new title keyword" }],
  ]) {
    assert.equal(measurementComparability(base, manifest({ queries })).visibility, false);
  }
  assert.equal(
    measurementComparability(base, manifest({ queries: [{ ...query, targetPosition: 2 }] }))
      .visibility,
    true,
  );
  assert.equal(manifest({ queries: [{ ...query, status: "error" }] }).visibility.measured, false);
});

test("old/new domain archives and 1-day/90-day scan intervals cannot manufacture acquisition rates", () => {
  const domains = [
    { links: 2, lostLinks: 0, firstSeen: "2001-01-01", domainFirstArchivedAt: "2026-10-25" },
  ] as ReferringDomain[];
  for (const days of [1, 90]) {
    const trend = [
      { at: "2026-01-01", referringDomains: 1 },
      {
        at: new Date(Date.parse("2026-01-01") + days * 86400000).toISOString(),
        referringDomains: 5,
      },
    ] as TrendPoint[];
    assert.equal(buildVelocity(domains, trend).verdict, "unknown");
    assert.equal(buildVelocity(domains, trend).perMonth, 0);
  }
});

test("new measurement cannot compare with legacy DB/browser history lacking manifests", () => {
  const report = { measurement: manifest(), target: { host: "target.example" } } as ScanReport;
  assert.equal(rowToDelta(report, {} as Parameters<typeof rowToDelta>[1]), null);
  assert.equal(
    diffReport(report, { host: "target.example" } as Parameters<typeof diffReport>[1]),
    null,
  );
});

test("full discovery flow keeps provider assertion out of observed statistics when source HTML lacks the link", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
    if (url.hostname === "en.wikipedia.org" && url.pathname === "/w/api.php")
      return Response.json({
        query: {
          exturlusage: [{ pageid: 1, ns: 0, title: "Frozen fixture", url: fixture.target }],
        },
      });
    if (url.hostname === "en.wikipedia.org" && url.pathname === "/wiki/Frozen_fixture")
      return new Response(fixture.noLink, { headers: { "content-type": "text/html" } });
    if (url.hostname === "target.example" && url.pathname === "/")
      return new Response(
        "<html><head><title>Frozen target</title></head><body><article>" +
          "Readable target text. ".repeat(100) +
          "</article></body></html>",
        { headers: { "content-type": "text/html" } },
      );
    return Response.json({});
  };
  const scan = await runScan("target.example", {
    mode: "light",
    skipSiteAudit: true,
    budgetMs: 10_000,
    seedUrls: ["https://en.wikipedia.org/wiki/Frozen_fixture"],
  });
  assert.equal(scan.ok, true);
  if (!scan.ok) return;
  const html = reportHtml(scan.report);
  assert.match(html, /<b>unknown<\/b>Link velocity/);
  assert.doesNotMatch(html, /<b>0\/mo<\/b>/);
  assert.equal(scan.report.providerReports!.length, 1);
  assert.equal(scan.report.backlinks.length, 0);
  assert.equal(scan.report.stats.backlinks, 0);
  assert.equal(scan.report.measurement!.observed.livePairs, 0);
  assert.equal(scan.report.measurement!.coverage.wikipedia!.confirmedPairs, 0);
  assert.equal(scan.report.measurement!.coverage.webmaster!.admitted, 1);
  assert.equal(scan.report.sources.find((s) => s.id === "hacker-news")!.status, "skipped");
});

test("GDELT retains its own provenance instead of merging with the News adapter", async () => {
  globalThis.fetch = async () =>
    Response.json({
      articles: [{ url: "https://publisher.example/target-guide", title: "target.example guide" }],
    });
  const result = await scanGdelt("target.example");
  assert.equal(result.length, 1);
  assert.equal(result[0]!.via, "gdelt");
});

test("CSV exports keep unknown link dates separate from domain archive context and raw evidence", () => {
  const row = hydrateProviderReport(
    { sourceUrl: fixture.base, targetUrl: fixture.target, discoveredVia: "github" },
    "target.example",
    [],
  )!;
  row.domainFirstArchivedAt = "2001-01-01";
  row.evidence!.rawHref = "Offer?sku=ABC&amp;ref=keep";
  const report = {
    backlinks: [row],
    analytics: {
      referringDomains: [
        {
          ...row,
          domain: "source.example",
          links: 1,
          pages: 1,
          dofollow: 0,
          contentLinks: 0,
          tld: "example",
          sampleUrl: fixture.base,
          sources: ["github"],
        },
      ],
    },
  } as unknown as ScanReport;
  const links = backlinksCsv(report);
  assert.match(
    links.split("\n")[0]!,
    /first_seen.*domain_first_archived_at,evidence_kind,observed_at,raw_href,resolved_href,identity_policy,source_revision$/,
  );
  assert.match(links, /"2001-01-01","provider_report"/);
  assert.match(links, /Offer\?sku=ABC&amp;ref=keep/);
  assert.match(domainsCsv(report), /domain_first_archived_at/);
});

test("score comparison rejects relevance-only selection changes to the scored follow cohort", () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({
    ...hydrateProviderReport(
      {
        sourceUrl: `https://source.example/${i}`,
        targetUrl: fixture.target,
        discoveredVia: "bing",
      },
      "target.example",
      [],
    )!,
    state: "live" as const,
    verified: true,
    domainScore: 60,
    spamScore: 4,
    placement: "content" as const,
    effectiveFollow: i === 6,
    rel: i === 6 ? ("dofollow" as const) : ("nofollow" as const),
    relevance: i === 6 ? 0 : 100,
  }));
  const changed = rows.map((row, i) => (i === 6 ? { ...row, relevance: 100 } : row));
  const before = capPerDomain(sortBacklinks(rows), 25);
  const after = capPerDomain(sortBacklinks(changed), 25);
  assert.equal(before.filter((b) => b.effectiveFollow).length, 0);
  assert.equal(after.filter((b) => b.effectiveFollow).length, 1);
  assert.notEqual(
    computeDomainRating(buildReferringDomains(before)),
    computeDomainRating(buildReferringDomains(after)),
  );
  assert.equal(
    measurementComparability(
      manifest({ observed: rows, displayed: before }),
      manifest({ observed: changed, displayed: after }),
    ).scores,
    false,
  );
});

test("repeat discovery refetches source instead of relabeling a cached anchor as current", async () => {
  const candidate = [{ url: fixture.base, title: "", via: "bing" as const }];
  const options = () => ({
    host: "target.example",
    brandTokens: [],
    limit: 1,
    budget: new Budget(10_000),
  });
  serve(fixture.html);
  assert.equal((await verifyPages(candidate, options())).backlinks.length, 1);
  serve(fixture.noLink);
  assert.equal((await verifyPages(candidate, options())).backlinks.length, 0);
});

test("exact HTML attribute references are case-sensitive and decode all valid names once", async () => {
  for (const [raw, target, status] of [
    ["https://target.example/Offer?q=&NbSp;", "https://target.example/Offer?q=%C2%A0", "not_found"],
    ["https://target.example/Offer?q=&NbSp;", "https://target.example/Offer?q=&NbSp;", "confirmed"],
    ["https://target.example/&copy;&sol;Offer", "https://target.example/%C2%A9/Offer", "confirmed"],
    [
      "https://target.example/Offer?q=&CounterClockwiseContourIntegral;",
      "https://target.example/Offer?q=%E2%88%B3",
      "confirmed",
    ],
    [
      "https://target.example/Offer?q=&amp;copy;",
      "https://target.example/Offer?q=&copy;",
      "confirmed",
    ],
  ] as const) {
    clearNetCache();
    clearRobotsCache();
    serve(`<html><body><a href="${raw}">actual link</a></body></html>`);
    const result = (
      await verifyBacklinks({ items: [{ source_url: fixture.base, target_url: target }] })
    ).results[0]!;
    assert.equal(result.status, status, raw);
    const discovery = await verifyPages([{ url: fixture.base, title: "", via: "bing" }], {
      host: "target.example",
      brandTokens: [],
      limit: 1,
      budget: new Budget(10_000),
    });
    const expected = raw.includes("NbSp") ? "https://target.example/Offer?q=&NbSp;" : target;
    assert.equal(discovery.backlinks[0]!.targetUrl, expected, raw);
  }
});
