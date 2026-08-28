import assert from "node:assert/strict";

// Some fixtures deliberately use Polish text: diacritics, stopwords and
// non-ASCII anchors are exactly where naive parsing and case-folding break.
import { test } from "node:test";

import {
  isTargetHost,
  normalizeUrl,
  pageKey,
  parseTarget,
  registrableDomain,
  tldOf,
} from "./parse.ts";
import {
  buildRegions,
  classifyAnchor,
  parseAnchors,
  parseRobotsSitemaps,
  parseSitemap,
  placementAt,
  extractRobotsMeta,
  snippetAround,
  unwrapRedirect,
} from "./html.ts";
import { classifyRel, markSitewide } from "./verify.server.ts";
import { backlinkId, buildAnalytics, capPerDomain, domainScore, spamScore } from "./score.ts";
import type { Backlink, SiteSnapshot } from "./types.ts";
import { setHostResolverForTests } from "./net.server.ts";

// Keep DNS hermetic for any test that exercises the network stack.
setHostResolverForTests(async () => ["93.184.216.34"]);

/* --------------------------------- parse --------------------------------- */

test("registrableDomain understands multi-part public suffixes", () => {
  assert.equal(registrableDomain("blog.sklep.com.pl"), "sklep.com.pl");
  assert.equal(registrableDomain("www.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("news.bbc.co.uk"), "bbc.co.uk");
  assert.equal(registrableDomain("example.com"), "example.com");
});

test("tldOf returns the full public suffix", () => {
  assert.equal(tldOf("firma.com.pl"), "com.pl");
  assert.equal(tldOf("nasa.gov"), "gov");
});

test("normalizeUrl strips tracking parameters and tidies the URL", () => {
  assert.equal(
    normalizeUrl("https://Example.com/blog/?utm_source=fb&b=2&a=1#sekcja"),
    "https://example.com/blog?a=1&b=2",
  );
  assert.equal(normalizeUrl("https://example.com/index.html"), "https://example.com/");
});

test("pageKey ignores protocol and www", () => {
  assert.equal(pageKey("http://www.example.com/a/"), pageKey("https://example.com/a"));
});

test("isTargetHost catches subdomains and the www variant", () => {
  assert.ok(isTargetHost("blog.example.com", "example.com"));
  assert.ok(isTargetHost("www.example.com", "example.com"));
  assert.ok(!isTargetHost("example.com.evil.net", "example.com"));
});

test("parseTarget rejects junk and normalises input", () => {
  assert.equal(parseTarget("https://WWW.Nasa.gov/mars").host, "nasa.gov");
  assert.throws(() => parseTarget("nie adres"));
  assert.throws(() => parseTarget("ftp://example.com"));
});

/* ---------------------------------- html --------------------------------- */

const PAGE = `<!doctype html><html lang="pl"><head><title>Blog</title>
<meta name="robots" content="index, nofollow"></head><body>
<main><article><p>Polecam <a href="https://cel.pl/oferta">świetne studio</a>.</p></article></main>
<aside class="sidebar"><a href="https://cel.pl/">cel.pl</a></aside>
<footer><a rel="nofollow sponsored" href="https://cel.pl/kontakt"><img src="/l.png" alt="Logo Cel"></a></footer>
</body></html>`;

test("parseAnchors identifies the document section and image alt text", () => {
  const anchors = parseAnchors(PAGE, "https://blog.pl/wpis");
  const byHref = new Map(anchors.map((a) => [a.href, a]));
  assert.equal(byHref.get("https://cel.pl/oferta")?.placement, "content");
  assert.equal(byHref.get("https://blog.pl/")?.placement ?? "unknown", "unknown");
  assert.equal(byHref.get("https://cel.pl/")?.placement, "sidebar");
  const logo = byHref.get("https://cel.pl/kontakt");
  assert.equal(logo?.placement, "footer");
  assert.equal(logo?.isImage, true);
  assert.equal(logo?.text, "Logo Cel");
});

test("placementAt picks the narrowest section", () => {
  const regions = buildRegions(PAGE);
  const at = PAGE.indexOf('href="https://cel.pl/oferta"');
  assert.equal(placementAt(regions, at), "content");
});

test("extractRobotsMeta reads page-level nofollow", () => {
  const meta = extractRobotsMeta(PAGE);
  assert.equal(meta.nofollow, true);
  assert.equal(meta.noindex, false);
});

test("classifyRel recognises every variant", () => {
  assert.equal(classifyRel(undefined), "dofollow");
  assert.equal(classifyRel("noopener"), "dofollow");
  assert.equal(classifyRel("nofollow noopener"), "nofollow");
  assert.equal(classifyRel("ugc"), "ugc");
  assert.equal(classifyRel("nofollow sponsored"), "sponsored");
});

test("classifyAnchor distinguishes brand, URL and keyword anchors", () => {
  assert.equal(classifyAnchor("cel.pl", "cel.pl", ["Studio Cel"], false), "url");
  assert.equal(classifyAnchor("Studio Cel", "cel.pl", ["Studio Cel"], false), "brand");
  assert.equal(classifyAnchor("kliknij tutaj", "cel.pl", [], false), "generic");
  assert.equal(classifyAnchor("fotografia produktowa", "cel.pl", [], false), "exact-match");
  assert.equal(classifyAnchor("", "cel.pl", [], true), "image");
  assert.equal(
    classifyAnchor("najlepsze studio fotografii produktowej w Krakowie", "cel.pl", [], false),
    "long-tail",
  );
});

test("unwrapRedirect unwraps archive and search-engine redirects", () => {
  assert.equal(
    unwrapRedirect("https://web.archive.org/web/20200101id_/https://cel.pl/a"),
    "https://cel.pl/a",
  );
  assert.equal(
    unwrapRedirect("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fcel.pl%2Fb&rut=x"),
    "https://cel.pl/b",
  );
});

test("parseSitemap and parseRobotsSitemaps read sitemaps", () => {
  const xml = `<urlset><url><loc>https://cel.pl/a</loc></url><url><loc><![CDATA[https://cel.pl/b]]></loc></url></urlset>`;
  assert.deepEqual(parseSitemap(xml), ["https://cel.pl/a", "https://cel.pl/b"]);
  assert.deepEqual(parseRobotsSitemaps("User-agent: *\nSitemap: https://cel.pl/sitemap.xml\n"), [
    "https://cel.pl/sitemap.xml",
  ]);
});

test("snippetAround returns real context around a mention", () => {
  const snippet = snippetAround(
    "<p>Studio z Krakowa, czyli cel.pl, wygrało konkurs.</p>",
    "cel.pl",
  );
  assert.ok(snippet && snippet.includes("cel.pl"));
  assert.ok(snippet && !snippet.includes("<p>"));
});

/* --------------------------------- score --------------------------------- */

function link(partial: Partial<Backlink>): Backlink {
  const sourceUrl = partial.sourceUrl ?? "https://partner.pl/wpis";
  const targetUrl = partial.targetUrl ?? "https://cel.pl/oferta";
  const anchor = partial.anchor ?? "Studio Cel";
  return {
    id: backlinkId({ sourceUrl, targetUrl, anchor }),
    sourceUrl,
    sourceHost: partial.sourceHost ?? "partner.pl",
    sourceDomain: partial.sourceDomain ?? "partner.pl",
    sourceTitle: partial.sourceTitle ?? "Partner",
    sourceLang: partial.sourceLang ?? "pl",
    targetUrl,
    targetPath: partial.targetPath ?? "/oferta",
    anchor,
    anchorType: partial.anchorType ?? "brand",
    rel: partial.rel ?? "dofollow",
    effectiveFollow: partial.effectiveFollow ?? true,
    placement: partial.placement ?? "content",
    sitewide: partial.sitewide ?? false,
    discoveredVia: partial.discoveredVia ?? "graph",
    verified: true,
    firstSeen: partial.firstSeen ?? "2015-04-02",
    httpStatus: 200,
    targetStatus: partial.targetStatus ?? 200,
    domainScore: partial.domainScore ?? 60,
    spamScore: partial.spamScore ?? 5,
    relevance: partial.relevance ?? 60,
    targetFinalUrl: partial.targetFinalUrl ?? null,
    state: partial.state ?? "live",
    lastSeen: partial.lastSeen ?? null,
    flags: partial.flags ?? [],
  };
}

test("domainScore rewards government domains and age, penalises junk TLDs", () => {
  const gov = domainScore({ host: "nasa.gov", firstSeen: "1998-01-01" });
  const junk = domainScore({ host: "tanie-linki-seo-123.xyz" });
  assert.ok(gov > 80, `gov=${gov}`);
  assert.ok(junk < 35, `junk=${junk}`);
});

test("spamScore detects link farms and directories", () => {
  const farm = spamScore({
    host: "katalog-stron-seo.xyz",
    anchors: ["pozycjonowanie tanio"],
    title: "Katalog stron",
  });
  const clean = spamScore({ host: "wikipedia.org", anchors: ["Studio Cel"] });
  assert.ok(farm >= 55, `farm=${farm}`);
  assert.ok(clean <= 10, `clean=${clean}`);
});

test("markSitewide detects a link repeated across many pages", () => {
  const items = ["a", "b", "c"].map((slug) =>
    link({ sourceUrl: `https://partner.pl/${slug}`, placement: "footer" }),
  );
  const marked = markSitewide(items);
  assert.ok(marked.every((item) => item.sitewide));
  assert.ok(marked[0]!.flags.includes("sitewide"));
});

test("capPerDomain limits domination by a single domain", () => {
  const items = Array.from({ length: 12 }, (_, i) =>
    link({ sourceUrl: `https://partner.pl/wpis-${i}`, anchor: `kotwica ${i}` }),
  );
  assert.equal(capPerDomain(items, 4).length, 4);
});

const SNAPSHOT: SiteSnapshot = {
  host: "cel.pl",
  domain: "cel.pl",
  url: "https://cel.pl",
  title: "Cel",
  description: null,
  lang: "pl",
  status: 200,
  https: true,
  canonical: null,
  robotsNoindex: false,
  archivedAt: null,
  archiveFirstSeen: null,
  archiveUrl: null,
  parked: false,
  redirectHost: null,
  usedArchive: false,
  subdomains: [],
  sitemapUrls: 0,
  indexedPages: 0,
  domainRating: 0,
  outboundDomains: 0,
};

test("buildAnalytics counts domains, anchors and profile health", () => {
  const items = [
    link({}),
    link({
      sourceUrl: "https://inny.pl/artykul",
      sourceHost: "inny.pl",
      sourceDomain: "inny.pl",
      anchor: "fotografia produktowa",
      anchorType: "exact-match",
      rel: "nofollow",
      effectiveFollow: false,
      placement: "footer",
      domainScore: 40,
    }),
  ];
  const analytics = buildAnalytics(items, [], SNAPSHOT);
  assert.equal(analytics.referringDomains.length, 2);
  assert.equal(analytics.anchors.length, 2);
  assert.ok(analytics.health.total > 0 && analytics.health.total <= 100);
  assert.ok(["A", "B", "C", "D", "E"].includes(analytics.health.grade));
  assert.ok(analytics.placements.some((p) => p.key === "content"));
});

test("buildAnalytics reports broken links and a noindex target", () => {
  const items = [link({ targetStatus: 404, flags: ["broken-target"] })];
  const analytics = buildAnalytics(items, [], { ...SNAPSHOT, robotsNoindex: true });
  const ids = analytics.issues.map((issue) => issue.id);
  assert.ok(ids.includes("broken"));
  assert.ok(ids.includes("target-noindex"));
});

/* --------------------------------- graf ---------------------------------- */

test("pageRank orders domains within the discovered graph", async () => {
  const { pageRank, rankToScore, computeDomainRating } = await import("./graph.ts");
  const ranks = pageRank([
    { from: "a.pl", to: "hub.pl", weight: 1 },
    { from: "b.pl", to: "hub.pl", weight: 1 },
    { from: "c.pl", to: "hub.pl", weight: 1 },
    { from: "hub.pl", to: "cel.pl", weight: 1 },
    { from: "a.pl", to: "cel.pl", weight: 1 },
  ]);
  const scores = rankToScore(ranks);
  assert.ok((scores.get("hub.pl") ?? 0) > (scores.get("a.pl") ?? 0));
  assert.ok((scores.get("cel.pl") ?? 0) > 0);

  const weak = computeDomainRating([
    {
      domain: "maly.pl",
      links: 1,
      pages: 1,
      dofollow: 0,
      contentLinks: 0,
      domainScore: 30,
      spamScore: 60,
      tld: "pl",
      firstSeen: null,
      sources: ["bing"],
      sampleUrl: "https://maly.pl",
      sampleAnchor: "",
      sitewide: false,
      rank: 5,
      ips: [],
      subnet: null,
      lostLinks: 0,
      reciprocal: false,
      relevance: 40,
    },
  ]);
  const strong = computeDomainRating(
    Array.from({ length: 40 }, (_, i) => ({
      domain: `mocny-${i}.gov`,
      links: 3,
      pages: 2,
      dofollow: 3,
      contentLinks: 2,
      domainScore: 85,
      spamScore: 2,
      tld: "gov",
      firstSeen: "2004-01-01",
      sources: ["graph" as const],
      sampleUrl: `https://mocny-${i}.gov`,
      sampleAnchor: "marka",
      sitewide: false,
      rank: 60,
      ips: [],
      subnet: null,
      lostLinks: 0,
      reciprocal: false,
      relevance: 70,
    })),
  );
  assert.ok(strong > weak, `strong=${strong} weak=${weak}`);
  assert.ok(strong <= 100 && weak >= 0);
});

test("buildTargetPages computes page strength (URL Rating)", async () => {
  const { buildTargetPages } = await import("./score.ts");
  const pages = buildTargetPages(
    [
      link({ targetPath: "/oferta", domainScore: 80 }),
      link({
        sourceUrl: "https://inny.pl/x",
        sourceDomain: "inny.pl",
        sourceHost: "inny.pl",
        targetPath: "/oferta",
        domainScore: 70,
      }),
      link({ targetPath: "/blog", domainScore: 20 }),
    ],
    SNAPSHOT,
  );
  assert.equal(pages[0]!.path, "/oferta");
  assert.equal(pages[0]!.domains, 2);
  assert.ok(pages[0]!.urlRating >= pages[1]!.urlRating);
});

test("analytics detects lost links and a shared subnet", () => {
  const items = [
    link({ sourceDomain: "a.pl", sourceHost: "a.pl" }),
    link({ sourceUrl: "https://b.pl/x", sourceDomain: "b.pl", sourceHost: "b.pl" }),
    link({ sourceUrl: "https://c.pl/x", sourceDomain: "c.pl", sourceHost: "c.pl" }),
    link({ sourceUrl: "https://d.pl/x", sourceDomain: "d.pl", sourceHost: "d.pl" }),
  ];
  const lost = [
    link({
      sourceUrl: "https://e.pl/x",
      sourceDomain: "e.pl",
      state: "lost",
      lastSeen: "2023-05-01",
      flags: ["lost"],
    }),
  ];
  const analytics = buildAnalytics(items, [], SNAPSHOT, {
    ips: new Map([
      ["a.pl", ["10.0.0.1"]],
      ["b.pl", ["10.0.0.2"]],
      ["c.pl", ["10.0.0.3"]],
      ["d.pl", ["10.0.0.4"]],
    ]),
    lostLinks: lost,
  });
  const ids = analytics.issues.map((issue) => issue.id);
  assert.ok(ids.includes("lost"));
  assert.ok(ids.includes("subnet"));
  assert.equal(analytics.referringDomains[0]!.subnet, "10.0.0.0/24");
});

/* -------------------------------- tematyka -------------------------------- */

test("relevanceScore separates a same-industry page from a random one", async () => {
  const { mergeTerms, relevanceScore, tokenize } = await import("./topic.ts");
  const target = mergeTerms([
    "Fotografia produktowa i sesje packshot dla sklepów internetowych. Studio fotograficzne, packshoty, zdjęcia produktów.",
  ]);
  const onTopic = relevanceScore(
    "Packshot i fotografia produktowa w e-commerce. Jak przygotować zdjęcia produktów do sklepu, studio, packshoty.",
    target,
  );
  const offTopic = relevanceScore(
    "Przepis na ciasto drożdżowe z jabłkami. Piekarnik, mąka, cukier, drożdże i jabłka.",
    target,
  );
  assert.ok(onTopic > offTopic + 20, `on=${onTopic} off=${offTopic}`);
  assert.ok(tokenize("Strona www i cookies").length === 0);
});

test("scoreBacklink downgrades off-topic and lost links", async () => {
  const { scoreBacklink } = await import("./score.ts");
  const good = scoreBacklink(link({ relevance: 80 }));
  const off = scoreBacklink(link({ relevance: 5, flags: ["off-topic"] }));
  const lost = scoreBacklink(link({ state: "lost", flags: ["lost"] }));
  assert.ok(good > off);
  assert.ok(good > lost);
});

test("a database delta counts new and lost links", async () => {
  const { rowToDelta } = await import("./history-diff.ts");
  const report = {
    backlinks: [link({}), link({ sourceUrl: "https://nowy.pl/a", sourceDomain: "nowy.pl" })],
    analytics: {
      referringDomains: [{ domain: "partner.pl" }, { domain: "nowy.pl" }],
      health: { total: 60 },
    },
    stats: { backlinks: 2, referringDomains: 2, domainRating: 20, serpVisibility: 0 },
  } as unknown as Parameters<typeof rowToDelta>[0];

  const delta = rowToDelta(report, {
    queried_at: "2026-01-01T00:00:00.000Z",
    backlinks: 1,
    referring_domains: 1,
    dofollow: 1,
    domain_rating: 10,
    health: 50,
    spam_domains: 0,
    lost_links: 0,
    link_ids: [report.backlinks[0]!.id, "stary-link"],
    domains: ["partner.pl", "znikla.pl"],
  });
  assert.ok(delta);
  assert.equal(delta!.newLinks, 1);
  assert.equal(delta!.lostLinks, 1);
  assert.deepEqual(delta!.newDomains, ["nowy.pl"]);
  assert.deepEqual(delta!.lostDomains, ["znikla.pl"]);
  assert.equal(delta!.ratingDelta, 10);
  assert.equal(delta!.visibilityDelta, 0);
});

/* --------------------------------- on-page -------------------------------- */

test("auditOnPage scores a complete page and penalises noindex", async () => {
  const { auditOnPage } = await import("./onpage.ts");
  const html = `<!doctype html><html lang="pl"><head>
<title>Fotografia produktowa Kraków — Studio Cel</title>
<meta name="description" content="Packshoty i sesje produktowe dla sklepów internetowych. Studio w Krakowie, zdjęcia packshot, retusz.">
<link rel="canonical" href="https://cel.pl/">
<meta property="og:title" content="Studio Cel">
<meta property="og:image" content="https://cel.pl/og.jpg">
<script type="application/ld+json">{"@type":"Organization","name":"Cel"}</script>
</head><body>
<h1>Fotografia produktowa</h1>
<p>${"packshot produkt studio ".repeat(80)}</p>
<a href="/oferta">oferta</a><a href="/kontakt">kontakt</a>
<a href="https://partner.pl">partner</a>
</body></html>`;
  const good = auditOnPage({
    html,
    url: "https://cel.pl/",
    host: "cel.pl",
    https: true,
    primaryKeyword: "fotografia",
  });
  assert.ok(good.score >= 70, `score=${good.score}`);
  assert.equal(good.h1.length, 1);
  assert.ok(good.schemaTypes.includes("Organization"));
  assert.equal(good.canonicalOk, true);

  const blocked = auditOnPage({
    html: `<html><head><title>x</title><meta name="robots" content="noindex"></head><body><p>hi</p></body></html>`,
    url: "http://cel.pl/",
    host: "cel.pl",
    https: false,
  });
  assert.ok(blocked.score <= 28, `blocked=${blocked.score}`);
  assert.ok(blocked.issues.some((i) => i.id === "seo-noindex"));
  assert.ok(blocked.issues.some((i) => i.id === "seo-https"));
});

test("extractHeadings and schema types from HTML", async () => {
  const { extractHeadings, extractSchemaTypes, extractOg, extractCanonical, extractDescription } =
    await import("./html.ts");
  const html = `<h1>Jeden</h1><h2>Dwa</h2><h2>Dwa</h2>
<meta property="og:title" content="Tytuł OG">
<meta property="og:image" content="https://x.pl/a.jpg">
<script type="application/ld+json">{"@type":["Article","NewsArticle"]}</script>`;
  assert.deepEqual(extractHeadings(html, "h1"), ["Jeden"]);
  assert.deepEqual(extractHeadings(html, "h2"), ["Dwa"]);
  assert.ok(extractSchemaTypes(html).includes("Article"));
  assert.equal(extractOg(html).title, "Tytuł OG");
  assert.equal(extractOg(html).image, true);

  assert.equal(
    extractCanonical(`<link rel="canonical" href="https://x.com/a">`),
    "https://x.com/a",
  );
  assert.equal(
    extractCanonical(`<link href="https://x.com/a" rel="canonical">`),
    "https://x.com/a",
  );
  assert.equal(
    extractCanonical(`<link rel="canonical" href="/produkt">`, "https://example.com/page"),
    "https://example.com/produkt",
  );
  assert.equal(
    extractDescription(`<meta content="Order-independent description text here." name="description">`),
    "Order-independent description text here.",
  );
});

/* --------------------------------- keywords / serp ------------------------ */

test("collectKeywords takes titles, H1s and exact-match anchors", async () => {
  const { collectKeywords, pickSerpKeywords, visibilityScore, buildKeywordStats } = await import(
    "./keywords.ts"
  );
  const seeds = collectKeywords({
    title: "Fotografia produktowa | Studio Cel",
    h1: ["Packshot i zdjęcia produktów"],
    brandTokens: ["Studio Cel"],
    anchors: [
      {
        text: "fotografia produktowa",
        type: "exact-match",
        count: 4,
        domains: 3,
        share: 20,
      },
    ],
  });
  assert.ok(seeds.some((s) => s.keyword.includes("fotografia")));
  const picked = pickSerpKeywords(seeds, 4);
  assert.ok(picked.length >= 2 && picked.length <= 4);

  const vis = visibilityScore([
    {
      keyword: "fotografia produktowa",
      engine: "bing",
      targetPosition: 2,
      results: [],
      features: [],
      related: [],
      questions: [],
      depth: 10,
      difficulty: 0,
      market: "pl" as const,
      device: "desktop" as const,
      status: "ok" as const,
      ms: 10,
    },
    {
      keyword: "fotografia produktowa",
      engine: "duckduckgo",
      targetPosition: 5,
      results: [],
      features: [],
      related: [],
      questions: [],
      depth: 10,
      difficulty: 0,
      market: "pl" as const,
      device: "desktop" as const,
      status: "ok" as const,
      ms: 10,
    },
    {
      keyword: "inna fraza",
      engine: "bing",
      targetPosition: null,
      results: [],
      features: [],
      related: [],
      questions: [],
      depth: 10,
      difficulty: 0,
      market: "pl" as const,
      device: "desktop" as const,
      status: "ok" as const,
      ms: 10,
    },
  ]);
  assert.equal(vis.ranked, 1);
  assert.equal(vis.top3, 1);
  assert.ok(vis.visibility > 0 && vis.visibility <= 100);

  const blockedOnly = visibilityScore([
    {
      keyword: "blocked phrase",
      engine: "bing",
      targetPosition: null,
      results: [],
      features: [],
      related: [],
      questions: [],
      depth: 10,
      difficulty: 0,
      market: "pl" as const,
      device: "desktop" as const,
      status: "blocked" as const,
      ms: 10,
    },
    {
      keyword: "ok phrase",
      engine: "bing",
      targetPosition: 1,
      results: [],
      features: [],
      related: [],
      questions: [],
      depth: 10,
      difficulty: 0,
      market: "pl" as const,
      device: "desktop" as const,
      status: "ok" as const,
      ms: 10,
    },
  ]);
  assert.equal(blockedOnly.unmeasured, 1);
  assert.equal(blockedOnly.measured, 1);
  assert.equal(blockedOnly.ranked, 1);
  assert.equal(blockedOnly.visibility, 100, "blocked keywords must not dilute visibility");

  const stats = buildKeywordStats(seeds.slice(0, 3), [], []);
  assert.ok(stats[0]!.opportunity >= 20);
});

test("SERP parsers extract organic positions and the target", async () => {
  const { parseBingOrganic, parseDdgOrganic, toSerpHits, targetPosition } = await import("./serp.ts");
  const bing = `<ol><li class="b_algo"><h2><a href="https://konkurent.pl/a">Konkurent</a></h2><p>opis</p></li>
<li class="b_algo"><h2><a href="https://cel.pl/oferta">Studio Cel</a></h2><cite>cel.pl</cite></li></ol>`;
  const bingHits = parseBingOrganic(bing);
  assert.ok(bingHits.length >= 2);
  assert.equal(bingHits[0]!.position, 1);
  const serpHits = toSerpHits(bingHits, "cel.pl");
  assert.equal(targetPosition(serpHits), 2);
  assert.equal(serpHits[1]!.isTarget, true);

  const ddg = `<a class="result__a" href="https://example.com/x">Example</a>
<a class="result__a" href="https://cel.pl/">Cel</a>`;
  const ddgHits = parseDdgOrganic(ddg);
  assert.ok(ddgHits.length >= 1);
});

test("scoreBacklink rewards a SERP co-ranker", async () => {
  const { scoreBacklink } = await import("./score.ts");
  const base = scoreBacklink(link({}));
  const corank = scoreBacklink(link({ flags: ["serp-coranker"] }));
  assert.ok(corank > base);
});



/* ------------------------------- SERP 5.0 -------------------------------- */

function hit(position: number, url: string, isTarget = false, domainScore = 50) {
  const host = new URL(url).hostname;
  return {
    position,
    url,
    host,
    domain: host.replace(/^www\./, ""),
    title: `Wynik ${position}`,
    snippet: "",
    isTarget,
    domainScore,
    ctr: 0,
  };
}

function query(overrides: Partial<import("./types.ts").SerpQuery> = {}) {
  const base = {
    keyword: "fotografia produktowa",
    engine: "bing" as const,
    targetPosition: null,
    results: [],
    features: [],
    related: [],
    questions: [],
    depth: 10,
    difficulty: 0,
    market: "pl" as const,
    device: "desktop" as const,
    status: "ok" as const,
    ms: 12,
  };
  return { ...base, ...overrides } satisfies import("./types.ts").SerpQuery;
}

test("the CTR curve falls with position and accounts for SERP features", async () => {
  const { positionCtr, adjustedCtr } = await import("./serp-intel.ts");
  assert.ok(positionCtr(1) > positionCtr(2));
  assert.ok(positionCtr(2) > positionCtr(10));
  assert.equal(positionCtr(null), 0);
  // A featured snippet takes clicks away from the organic results.
  assert.ok(adjustedCtr(1, ["featured"]) < positionCtr(1));
});

test("keyword difficulty rises with the strength of the top domains", async () => {
  const { keywordDifficulty } = await import("./serp-intel.ts");
  const easy = keywordDifficulty(
    query({
      keyword: "packshot butelek szklanych kraków",
      results: [hit(1, "https://maly-blog.pl/a", false, 20), hit(2, "https://inny.pl/b", false, 25)],
    }),
  );
  const hard = keywordDifficulty(
    query({
      keyword: "buty",
      results: [hit(1, "https://wikipedia.org/a", false, 95), hit(2, "https://allegro.pl/b", false, 90)],
    }),
  );
  assert.ok(hard > easy, `${hard} should exceed ${easy}`);
});

test("SERP competitors carry share of voice and keyword coverage", async () => {
  const { buildSerpCompetitors } = await import("./serp-intel.ts");
  const competitors = buildSerpCompetitors([
    query({
      keyword: "a",
      results: [hit(1, "https://rywal.pl/x"), hit(2, "https://cel.pl/y", true)],
    }),
    query({
      keyword: "b",
      results: [hit(1, "https://rywal.pl/z"), hit(3, "https://inny.pl/q")],
    }),
  ]);
  const top = competitors[0]!;
  assert.equal(top.domain, "rywal.pl");
  assert.equal(top.keywords, 2);
  assert.equal(top.overlap, 100);
  assert.ok(top.shareOfVoice > 0);
  assert.equal(top.bestPosition, 1);
});

test("cannibalisation detects two own URLs on one keyword", async () => {
  const { detectCannibalization } = await import("./serp-intel.ts");
  const found = detectCannibalization([
    query({
      results: [hit(2, "https://cel.pl/oferta", true), hit(6, "https://cel.pl/blog/oferta", true)],
    }),
    query({ keyword: "inna", results: [hit(3, "https://cel.pl/x", true)] }),
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.urls.length, 2);
  assert.equal(found[0]!.urls[0]!.position, 2);
});

test("rank moves distinguish gains, drops, new and lost keywords", async () => {
  const { buildRankMoves } = await import("./serp-intel.ts");
  const moves = buildRankMoves(
    [
      query({ keyword: "awans", targetPosition: 3 }),
      query({ keyword: "spadek", targetPosition: 9 }),
      query({ keyword: "nowa", targetPosition: 7 }),
    ],
    [
      { keyword: "awans", engine: "bing", position: 8 },
      { keyword: "spadek", engine: "bing", position: 4 },
      { keyword: "znikla", engine: "bing", position: 5 },
    ],
  );
  const byKeyword = new Map(moves.map((move) => [move.keyword, move]));
  assert.equal(byKeyword.get("awans")!.state, "up");
  assert.equal(byKeyword.get("awans")!.change, 5);
  assert.equal(byKeyword.get("spadek")!.state, "down");
  assert.equal(byKeyword.get("nowa")!.state, "new");
  assert.equal(byKeyword.get("znikla")!.state, "lost");
});

test("keyword intent recognises transactional, comparative and brand queries", async () => {
  const { classifyIntent } = await import("./serp-intel.ts");
  assert.equal(classifyIntent("packshot cena"), "transactional");
  assert.equal(classifyIntent("najlepszy fotograf produktowy"), "commercial");
  assert.equal(classifyIntent("jak zrobić packshot"), "informational");
  assert.equal(classifyIntent("studiofoto opinie", ["studiofoto"]), "brand");
});

test("the Brave parser and related searches work on raw HTML", async () => {
  const { parseBraveOrganic, parsePeopleAlsoAsk, mergePages } = await import("./serp.ts");
  const brave = `<div class="snippet" ><a href="https://rywal.pl/a"><span class="snippet-title">Rywal</span></a><div class="snippet-description">opis</div></div>
<div class="snippet"><a href="https://cel.pl/b"><span class="snippet-title">Cel</span></a></div>`;
  const hits = parseBraveOrganic(brave);
  assert.ok(hits.length >= 2);
  assert.equal(hits[0]!.position, 1);

  const questions = parsePeopleAlsoAsk("<div>Jak zrobić dobry packshot w domu?</div><li>Ile kosztuje sesja produktowa?</li>");
  assert.ok(questions.length >= 2);

  const merged = mergePages([hits, hits]);
  assert.equal(merged.length, hits.length, "duplicates from the second page are dropped");
});

/* -------------------------------- toxicity ------------------------------- */

function refDomain(overrides: Partial<import("./types.ts").ReferringDomain> = {}) {
  return {
    domain: "spam-site.xyz",
    links: 12,
    pages: 1,
    dofollow: 12,
    contentLinks: 0,
    domainScore: 15,
    spamScore: 70,
    tld: "xyz",
    firstSeen: null,
    sources: [],
    sampleUrl: "https://spam-site.xyz/a",
    sampleAnchor: "tanie kredyty",
    sitewide: true,
    rank: 1,
    ips: [],
    subnet: null,
    lostLinks: 0,
    reciprocal: false,
    relevance: 5,
    ...overrides,
  } as import("./types.ts").ReferringDomain;
}

test("toxicity flags domains to disavow and spares the good ones", async () => {
  const { buildToxicReport, disavowFile } = await import("./toxic.ts");
  const bad = refDomain();
  const good = refDomain({
    domain: "uczelnia.edu.pl",
    spamScore: 3,
    domainScore: 88,
    relevance: 80,
    tld: "edu.pl",
    sitewide: false,
    contentLinks: 3,
    links: 3,
    sampleUrl: "https://uczelnia.edu.pl/x",
  });
  const report = buildToxicReport(
    [
      link({ sourceDomain: "spam-site.xyz", anchorType: "exact-match", placement: "footer" }),
      link({ sourceDomain: "spam-site.xyz", anchorType: "exact-match", placement: "footer" }),
      link({ sourceDomain: "uczelnia.edu.pl", anchorType: "brand", placement: "content" }),
    ],
    [bad, good],
  );
  assert.equal(report.domains[0]!.domain, "spam-site.xyz");
  assert.equal(report.domains[0]!.verdict, "review");
  assert.equal(report.domains.find((d) => d.domain === "uczelnia.edu.pl")!.verdict, "ok");
  assert.ok(report.disavowCount >= 1);

  const file = disavowFile(report, { host: "cel.pl" });
  assert.ok(file.includes("domain:spam-site.xyz"));
  assert.ok(!file.includes("domain:uczelnia.edu.pl"), "dobra domena nie trafia do disavow");
});

test("the anchor audit penalises excess exact-match anchors", async () => {
  const { buildAnchorAudit } = await import("./toxic.ts");
  const anchors = [
    { text: "tanie kredyty", type: "exact-match" as const, count: 40, domains: 8, share: 40 },
    { text: "cel.pl", type: "brand" as const, count: 10, domains: 4, share: 10 },
  ];
  const risky = buildAnchorAudit(anchors, [
    { key: "exact-match", count: 40, share: 40 },
    { key: "brand", count: 10, share: 10 },
  ]);
  assert.equal(risky.risks.find((r) => r.type === "exact-match")!.verdict, "high");
  assert.ok(risky.overOptimized.length >= 1);

  const healthy = buildAnchorAudit(anchors, [
    { key: "brand", count: 60, share: 55 },
    { key: "url", count: 25, share: 25 },
    { key: "exact-match", count: 8, share: 8 },
  ]);
  assert.ok(healthy.score > risky.score);
});

/* ------------------ clusters, content gaps, action plan ------------------ */

test("clustering merges keywords sharing a SERP and separates unrelated topics", async () => {
  const { clusterKeywords } = await import("./serp-cluster.ts");
  const shared = [
    hit(1, "https://a.pl/1"),
    hit(2, "https://b.pl/2"),
    hit(3, "https://c.pl/3"),
    hit(4, "https://d.pl/4"),
  ];
  const clusters = clusterKeywords([
    query({ keyword: "packshot", results: shared }),
    query({ keyword: "fotografia packshotowa", results: shared }),
    query({
      keyword: "kurs excela",
      results: [hit(1, "https://excel1.pl/x"), hit(2, "https://excel2.pl/y")],
    }),
  ]);
  const main = clusters.find((cluster) => cluster.keywords.length > 1);
  assert.ok(main, "keywords sharing a SERP form a cluster");
  assert.equal(main!.keywords.length, 2);
  assert.equal(main!.strategy, "one-page");
  assert.ok(clusters.some((cluster) => cluster.keywords.includes("kurs excela") && cluster.keywords.length === 1));
});

test("content gaps surface competitor terms missing from our page", async () => {
  const { contentGapTerms } = await import("./serp-cluster.ts");
  const results = [1, 2, 3].map((index) => ({
    ...hit(index, `https://rywal${index}.pl/a`),
    title: "Packshot butelek w studiu",
    snippet: "Zdjęcia opakowań i renderowanie produktów",
  }));
  const gaps = contentGapTerms([query({ results })], "packshot butelek");
  const missing = gaps.filter((term) => !term.onTarget).map((term) => term.term);
  assert.ok(missing.includes("studiu") || missing.includes("opakowan"), missing.join(","));
  assert.ok(gaps.every((term) => term.competitorPages >= 3));
});

test("featured-snippet opportunities only consider top-10 keywords", async () => {
  const { featuredOpportunities } = await import("./serp-cluster.ts");
  const found = featuredOpportunities([
    query({ keyword: "blisko", targetPosition: 4, features: ["featured", "paa"], questions: ["Jak?"] }),
    query({ keyword: "daleko", targetPosition: null, features: ["featured"] }),
  ]);
  assert.ok(found.length >= 1);
  assert.ok(found.every((item) => item.keyword === "blisko"));
});

test("position buckets and engine consensus compute correctly", async () => {
  const { positionBuckets, engineConsensus } = await import("./serp-cluster.ts");
  const queries = [
    query({ keyword: "a", engine: "bing", targetPosition: 2 }),
    query({ keyword: "a", engine: "duckduckgo", targetPosition: 9 }),
    query({ keyword: "b", engine: "bing", targetPosition: null }),
  ];
  const buckets = positionBuckets(queries);
  assert.equal(buckets.find((bucket) => bucket.label === "TOP 3")!.count, 1);
  assert.equal(buckets.find((bucket) => bucket.label === "poza zakresem")!.count, 1);

  const consensus = engineConsensus(queries);
  assert.equal(consensus[0]!.keyword, "a");
  assert.equal(consensus[0]!.spread, 7);
  assert.equal(consensus[0]!.stable, false);
});

test("segmentation recognises site type from the domain", async () => {
  const { classifySegment, buildSegments } = await import("./segments.ts");
  assert.equal(classifySegment("uw.edu.pl"), "edu-gov");
  assert.equal(classifySegment("github.com"), "code");
  assert.equal(classifySegment("reddit.com"), "forum");
  assert.equal(classifySegment("katalog-firm.pl"), "directory");

  const segments = buildSegments(
    [refDomain({ domain: "github.com", tld: "com" }), refDomain({ domain: "uw.edu.pl", tld: "edu.pl" })],
    [],
  );
  assert.equal(segments.length, 2);
  assert.equal(segments.reduce((sum, segment) => sum + segment.domains, 0), 2);
});

test("link velocity recognises growth and missing data", async () => {
  const { buildVelocity } = await import("./segments.ts");
  const year = 365 * 24 * 3600 * 1000;
  const iso = (offset: number) => new Date(Date.now() - offset).toISOString().slice(0, 10);
  const growing = buildVelocity([
    refDomain({ domain: "a.pl", firstSeen: iso(year * 0.2) }),
    refDomain({ domain: "b.pl", firstSeen: iso(year * 0.4) }),
    refDomain({ domain: "c.pl", firstSeen: iso(year * 0.6) }),
    refDomain({ domain: "d.pl", firstSeen: iso(year * 1.5) }),
  ]);
  assert.equal(growing.verdict, "growing");
  assert.ok(growing.perMonth > 0);

  const unknown = buildVelocity([refDomain({ firstSeen: null })]);
  assert.equal(unknown.verdict, "unknown");
});

test("the action plan puts cheap, effective tasks at the top", async () => {
  const { buildActionPlan } = await import("./plan.ts");
  const plan = buildActionPlan({
    host: "cel.pl",
    stats: { backlinks: 40, brokenLinks: 2 },
    analytics: { issues: [], anchors: [] } as never,
    serp: {
      cannibalization: [],
      moves: [],
    } as never,
    keywords: [
      {
        keyword: "packshot kraków",
        source: "title",
        weight: 80,
        bestPosition: 6,
        engines: [],
        linkEquity: 10,
        matchingAnchors: 1,
        difficulty: 30,
        trafficShare: 4,
        intent: "commercial",
        opportunity: 60,
      },
    ],
    clusters: [],
    featured: [],
    prospects: [
      {
        url: "https://blog.pl/a",
        host: "blog.pl",
        domain: "blog.pl",
        title: "Wzmianka",
        keyword: "",
        position: null,
        engine: null,
        reason: "unlinked-mention",
        domainScore: 60,
        snippet: "",
        priority: 70,
        contactUrl: null,
      },
    ],
    toxic: { domains: [], disavowCount: 0, watchCount: 0, toxicLinks: 0, avgToxicity: 0 },
    anchorAudit: { risks: [], overOptimized: [], diversity: 50, score: 70 },
    segments: [],
    velocity: {
      last12m: 3,
      perMonth: 0.3,
      trend: 0,
      lostRatio: 5,
      verdict: "stable",
      hint: "",
    },
    onPage: null,
  });

  assert.ok(plan.items.length >= 3);
  assert.ok(plan.quickWins >= 1);
  // Unlinked mentions and broken targets are low-effort tasks — they must
  // outrank expensive outreach.
  const ids = plan.items.map((item) => item.id);
  assert.ok(ids.indexOf("unlinked-mentions") < ids.indexOf("striking-distance"));
  assert.ok(plan.items.every((item, index, list) => index === 0 || list[index - 1]!.priority >= item.priority));
});

/* --------------- market, brand, footprint and the index ------------------ */

test("market parameters change the query and language for every engine", async () => {
  const { marketParams, acceptLanguage, isMarket } = await import("./market.ts");
  assert.ok(marketParams("bing", "pl", "desktop").includes("mkt=pl-PL"));
  assert.ok(marketParams("duckduckgo", "de", "desktop").includes("kl=de-de"));
  assert.ok(marketParams("brave", "us", "desktop").includes("country=us"));
  // The mobile variant only adds a switch where the engine understands one.
  assert.ok(marketParams("bing", "pl", "mobile").includes("form=MOBS"));
  assert.ok(!marketParams("mojeek", "pl", "mobile").includes("MOBS"));
  assert.ok(acceptLanguage("pl").startsWith("pl-PL"));
  assert.equal(isMarket("pl"), true);
  assert.equal(isMarket("xx"), false);
});

test("the brand SERP audit measures control and detects negative results", async () => {
  const { buildBrandSerp } = await import("./brand-serp.ts");
  const brand = buildBrandSerp(
    [
      query({
        keyword: "studiofoto",
        results: [
          { ...hit(1, "https://studiofoto.pl/", true), title: "Studiofoto — packshoty" },
          { ...hit(2, "https://linkedin.com/company/studiofoto"), title: "Studiofoto | LinkedIn" },
          { ...hit(3, "https://forum.pl/watek"), title: "Studiofoto oszust? Uwaga na tę firmę" },
          { ...hit(4, "https://rywal.pl/"), title: "Rywal" },
        ],
      }),
    ],
    { host: "studiofoto.pl", brandTokens: ["studiofoto"], competitors: new Set(["rywal.pl"]) },
  );
  assert.ok(brand);
  assert.equal(brand!.owned, 2, "own site plus a LinkedIn profile carrying the brand name");
  assert.equal(brand!.risky, 1);
  assert.ok(brand!.control > 0 && brand!.control < 100);
  assert.equal(brand!.results.find((row) => row.domain === "rywal.pl")!.kind, "competitor");

  // Without brand tokens we do not guess — showing nothing beats showing nonsense.
  assert.equal(buildBrandSerp([query({})], { host: "a.pl", brandTokens: [] }), null);
});

test("footprint detects subnet and anchor concentration", async () => {
  const { buildFootprint } = await import("./scorecard.ts");
  const clustered = Array.from({ length: 6 }, (_, index) =>
    refDomain({
      domain: `sieć${index}.pl`,
      subnet: "192.0.2",
      sitewide: true,
      pages: 1,
      links: 8,
      spamScore: 10,
    }),
  );
  const risky = buildFootprint(clustered, [], [{ key: "exact-match", share: 40 }]);
  assert.equal(risky.topSubnetShare, 100);
  assert.equal(risky.verdict, "high");
  assert.ok(risky.reasons.length >= 3);

  const clean = buildFootprint(
    [
      refDomain({ domain: "a.pl", subnet: "10.0.1", sitewide: false, pages: 4, links: 4 }),
      refDomain({ domain: "b.pl", subnet: "10.0.2", sitewide: false, pages: 3, links: 3 }),
    ],
    [],
    [{ key: "exact-match", share: 5 }],
  );
  assert.equal(clean.verdict, "low");
  assert.ok(clean.score < risky.score);
});

test("the visibility index sums to 100 and names the weakest component", async () => {
  const { buildScorecard, buildFootprint } = await import("./scorecard.ts");
  const footprint = buildFootprint([], [], []);
  const card = buildScorecard({
    analytics: { health: { total: 70, grade: "B", parts: [] } } as never,
    serp: { visibility: 40, trafficScore: 12, top10: 3 } as never,
    onPage: { score: 30 } as never,
    toxic: { domains: [], disavowCount: 0, watchCount: 0, toxicLinks: 0, avgToxicity: 10 },
    anchorAudit: { risks: [], overOptimized: [], diversity: 60, score: 80 },
    footprint,
    velocity: {
      last12m: 8,
      perMonth: 0.7,
      trend: 30,
      lostRatio: 4,
      verdict: "growing",
      hint: "",
    },
    brandSerp: null,
    domainRating: 45,
    referringDomains: 30,
  });

  const max = card.parts.reduce((sum, part) => sum + part.max, 0);
  assert.equal(max, 100, "the components must sum to 100 points");
  assert.equal(card.index, card.parts.reduce((sum, part) => sum + part.score, 0));
  assert.ok(card.parts.every((part) => part.score <= part.max));
  // On-page 30/100 is the weakest part of this profile.
  assert.equal(card.weakest, "On-page and structure");
  assert.ok(["A", "B", "C", "D", "E"].includes(card.grade));
});

/* ---------------------------- konfiguracja i CLI -------------------------- */

test("configuration reads ENV but defends against nonsense values", async () => {
  const { parseEngines, parseMarket, parseDevice, config, resetConfig, DEFAULT_CONFIG } =
    await import("./config.ts");

  assert.deepEqual(parseEngines("bing, brave", []), ["bing", "brave"]);
  assert.deepEqual(parseEngines("nieistniejacy", ["bing"]), ["bing"], "an unknown engine does not wipe the defaults");
  assert.deepEqual(parseEngines("bing,bing", []), ["bing"], "duplicates are removed");
  assert.equal(parseMarket("DE", "pl"), "de");
  assert.equal(parseMarket("xx", "pl"), "pl");
  assert.equal(parseDevice("mobile", "desktop"), "mobile");
  assert.equal(parseDevice("smartwatch", "desktop"), "desktop");

  const previous = { ...process.env };
  try {
    resetConfig();
    process.env.RANKPROOF_HOST_CONCURRENCY = "999";
    process.env.RANKPROOF_SCAN_BUDGET_MS = "nie-liczba";
    process.env.RANKPROOF_PERSIST_HISTORY = "0";
    const runtime = config();
    assert.equal(runtime.hostConcurrency, 8, "concurrency is capped");
    assert.equal(runtime.scanBudgetMs, DEFAULT_CONFIG.scanBudgetMs, "junk falls back to the default");
    assert.equal(runtime.persistHistory, false);
  } finally {
    process.env = previous;
    resetConfig();
  }
});

test("the CLI argument parser understands shorthands, values and errors", async () => {
  const { parseArgs } = await import("./cli.ts");

  const scan = parseArgs(["scan", "example.com", "--market", "us", "-d", "mobile", "--json"]);
  assert.equal(scan.command, "scan");
  assert.equal(scan.target, "example.com");
  assert.equal(scan.market, "us");
  assert.equal(scan.device, "mobile");
  assert.equal(scan.format, "json");
  assert.equal(scan.error, undefined);

  // A bare domain with no command means scan.
  assert.equal(parseArgs(["example.com"]).command, "scan");

  // The --key=value form plus positional keywords.
  const serp = parseArgs(["serp", "example.com", "packshot", "--depth=20", "--engines=bing,brave"]);
  assert.deepEqual(serp.keywords, ["packshot"]);
  assert.equal(serp.depth, 20);
  assert.deepEqual(serp.engines, ["bing", "brave"]);

  // Missing required input ends in a readable error, not a scan.
  assert.match(parseArgs(["serp", "example.com"]).error ?? "", /requires keywords/);
  assert.match(parseArgs(["gap", "example.com"]).error ?? "", /competitor/);
  assert.match(parseArgs(["scan"]).error ?? "", /Provide a domain/);
  assert.match(parseArgs(["scan", "a.pl", "--format", "xml"]).error ?? "", /Unknown format/);
  assert.match(parseArgs(["serp", "a.pl", "-k", "x", "-f", "html"]).error ?? "", /only available for/);
  assert.match(parseArgs(["scan", "a.pl", "--turbo"]).error ?? "", /Unknown option/);

  assert.equal(parseArgs([]).command, "help");
  assert.equal(parseArgs(["--version"]).command, "version");
});

/* ------------------------- SSRF and network safety ----------------------- */

test("private and metadata addresses are recognised", async () => {
  const { isPrivateAddress, guardUrl } = await import("./ssrf.ts");

  for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.9.9", "169.254.169.254", "0.0.0.0"]) {
    assert.equal(isPrivateAddress(address), true, `${address} must be private`);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
    assert.equal(isPrivateAddress(address), false, `${address} must be public`);
  }
  // IPv6 loopback, unique-local and IPv4-mapped smuggling.
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("fd00::1"), true);
  assert.equal(isPrivateAddress("fe80::1"), true);
  assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateAddress("2606:4700::1111"), false);

  const blocked = [
    "http://localhost/",
    "http://127.0.0.1:8080/",
    "http://169.254.169.254/latest/meta-data/",
    "file:///etc/passwd",
    "gopher://example.com/",
    "http://user:pass@example.com/",
    "http://example.com:22/",
    "http://db.internal/",
    "http://printer.local/",
    "http://intranet/",
  ];
  for (const url of blocked) {
    assert.equal(guardUrl(url).allowed, false, `${url} must be refused`);
  }
  assert.equal(guardUrl("https://example.com/page").allowed, true);
  assert.equal(guardUrl("https://example.com:8443/page").allowed, true);
});

test("IPv6 forms that smuggle an IPv4 address are refused", async () => {
  const { isPrivateAddress, guardUrl } = await import("./ssrf.ts");

  // `new URL()` rewrites `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so the
  // guard has to recognise the hex form — the dotted one never reaches it.
  assert.equal(new URL("http://[::ffff:127.0.0.1]/").hostname, "[::ffff:7f00:1]");

  const smuggled = [
    "::ffff:7f00:1", // IPv4-mapped loopback, as normalised by URL
    "::ffff:a9fe:a9fe", // IPv4-mapped cloud metadata
    "::ffff:a00:1", // IPv4-mapped RFC 1918
    "::7f00:1", // deprecated IPv4-compatible
    "::ffff:0:7f00:1", // IPv4-translated (RFC 2765)
    "64:ff9b::7f00:1", // NAT64
    "2002:7f00:1::", // 6to4
    "2001:db8::1", // documentation range
    "ff02::1", // multicast
  ];
  for (const address of smuggled) {
    assert.equal(isPrivateAddress(address), true, `${address} must be private`);
  }

  for (const address of ["2606:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:80f::200e"]) {
    assert.equal(isPrivateAddress(address), false, `${address} must stay reachable`);
  }

  for (const url of [
    "http://[::ffff:127.0.0.1]:8080/",
    "http://[0:0:0:0:0:ffff:127.0.0.1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[2002:7f00:1::]/",
    "http://[::127.0.0.1]/",
  ]) {
    assert.equal(guardUrl(url).allowed, false, `${url} must be refused`);
  }
  assert.equal(guardUrl("https://[2606:4700::1111]/").allowed, true);
});

test("malformed IPv6 literals are not mistaken for addresses", async () => {
  const { expandIpv6 } = await import("./ssrf.ts");

  assert.equal(expandIpv6("1:2:3:4:5:6:7:8")?.length, 8);
  assert.deepEqual(expandIpv6("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expandIpv6("fe80::1%eth0"), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  for (const bad of ["1:2:3", "::1::2", "gggg::1", "1:2:3:4:5:6:7:8:9", ""]) {
    assert.equal(expandIpv6(bad), null, `${bad} must not parse`);
  }
});

test("DNS rebinding is refused even when one address is public", async () => {
  const { guardUrlWithDns } = await import("./ssrf.ts");

  const publicOnly = await guardUrlWithDns("https://example.com/", async () => ["93.184.216.34"]);
  assert.equal(publicOnly.allowed, true);

  // A host resolving to both public and private space is the classic rebind.
  const mixed = await guardUrlWithDns("https://example.com/", async () => [
    "93.184.216.34",
    "127.0.0.1",
  ]);
  assert.equal(mixed.allowed, false);

  const noRecords = await guardUrlWithDns("https://example.com/", async () => []);
  assert.equal(noRecords.allowed, false);

  const failing = await guardUrlWithDns("https://example.com/", async () => {
    throw new Error("SERVFAIL");
  });
  assert.equal(failing.allowed, false);
});

/* -------------------------------- robots.txt ----------------------------- */

test("a group addressed to us wins over the wildcard, even when it allows everything", async () => {
  const { parseRobots, isAllowed } = await import("./robots.server.ts");

  // An empty `Disallow:` is how a site says "you may fetch anything". It adds
  // no rule, so an emptiness test would fall back to the wildcard's block.
  const txt = ["User-agent: *", "Disallow: /", "", "User-agent: RankProof", "Disallow:"].join("\n");
  const rules = parseRobots(txt, "rankproof");
  assert.equal(isAllowed(rules, "/anything"), true);
});

test("robots groups match on the agent token, not on any substring of it", async () => {
  const { parseRobots, isAllowed } = await import("./robots.server.ts");

  // "roof" and "pro" are substrings of "rankproof" but address other crawlers.
  for (const other of ["roof", "pro", "a"]) {
    const txt = [`User-agent: ${other}`, "Disallow: /", "", "User-agent: *", "Disallow:"].join("\n");
    const rules = parseRobots(txt, "rankproof");
    assert.equal(isAllowed(rules, "/page"), true, `a group for "${other}" must not bind us`);
  }

  // A real prefix match still binds.
  const ours = parseRobots(["User-agent: RankProof", "Disallow: /private"].join("\n"), "rankproof");
  assert.equal(isAllowed(ours, "/private/x"), false);
  assert.equal(isAllowed(ours, "/public"), true);
});


test("robots.txt rules are parsed and applied per agent", async () => {
  const { parseRobots, isAllowed } = await import("./robots.server.ts");
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(new URL("./fixtures/robots.txt", import.meta.url), "utf8");

  const rules = parseRobots(text, "rankproof");
  // Our own group wins over the wildcard group.
  assert.equal(isAllowed(rules, "/private/secret"), false);
  assert.equal(isAllowed(rules, "/private/public-page"), true, "Allow overrides a longer Disallow");
  assert.equal(isAllowed(rules, "/blog/post"), true);
  assert.equal(rules.crawlDelay, 1);
  assert.deepEqual(rules.sitemaps, ["https://example.com/sitemap.xml"]);

  const generic = parseRobots(text, "some-other-bot");
  assert.equal(isAllowed(generic, "/admin/panel"), false);
  assert.equal(isAllowed(generic, "/private/secret"), true, "the wildcard group has no /private rule");
  assert.equal(generic.crawlDelay, 2);

  // Wildcards and end anchors.
  const wild = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp/", "rankproof");
  assert.equal(isAllowed(wild, "/files/report.pdf"), false);
  assert.equal(isAllowed(wild, "/files/report.pdf.html"), true);
  assert.equal(isAllowed(wild, "/tmp/x"), false);

  // No robots.txt means everything is allowed.
  const { ALLOW_ALL } = await import("./robots.server.ts");
  assert.equal(isAllowed(ALLOW_ALL, "/anything"), true);
});

/* --------------------------- golden parser tests ------------------------- */

async function fixture(name: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

test("every SERP parser still understands its engine's markup", async () => {
  const { parseBingOrganic, parseDdgOrganic, parseMojeekOrganic, parseBraveOrganic, toSerpHits, targetPosition } =
    await import("./serp.ts");

  const cases = [
    { file: "bing.html", parse: parseBingOrganic, expected: 3, target: 3 },
    { file: "duckduckgo.html", parse: parseDdgOrganic, expected: 3, target: 3 },
    { file: "mojeek.html", parse: parseMojeekOrganic, expected: 2, target: 2 },
    { file: "brave.html", parse: parseBraveOrganic, expected: 2, target: 2 },
  ];

  for (const item of cases) {
    const html = await fixture(item.file);
    const hits = item.parse(html);
    assert.equal(hits.length, item.expected, `${item.file}: expected ${item.expected} results`);
    assert.equal(hits[0]!.position, 1);
    assert.ok(hits.every((hit) => hit.url.startsWith("https://")), `${item.file}: every URL absolute`);
    const serpHits = toSerpHits(hits, "target-site.com");
    assert.equal(targetPosition(serpHits), item.target, `${item.file}: target position`);
  }
});

test("related searches and questions survive real markup", async () => {
  const { parseRelatedSearches, parsePeopleAlsoAsk } = await import("./serp.ts");
  const bing = await fixture("bing.html");
  const related = parseRelatedSearches(bing, "bing");
  assert.ok(related.includes("free seo tools"), related.join(","));
  assert.ok(parsePeopleAlsoAsk(bing).length >= 1);

  const brave = await fixture("brave.html");
  assert.ok(parseRelatedSearches(brave, "brave").includes("free seo tools"));
});

test("DuckDuckGo results wrapped in a protocol-relative redirect survive", async () => {
  const { parseDdgOrganic } = await import("./serp.ts");

  // html.duckduckgo.com emits `//duckduckgo.com/l/?uddg=<encoded>`; unwrapping
  // has to happen after the scheme is restored, or `new URL()` throws and the
  // result is later dropped for pointing at duckduckgo.com.
  const target = "https://example.org/guide";
  const html =
    `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=x">` +
    "A guide</a><a class=\"result__snippet\">Snippet text.</a>";

  const hits = parseDdgOrganic(html);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.url, target);
});

test("Mojeek never invents results from navigation when the markup changes", async () => {
  const { parseMojeekOrganic, detectSerpBlock } = await import("./serp.ts");

  // Markup with no result titles at all — only chrome. A parser that scrapes
  // any anchor would report these as organic hits at positions 1..n.
  const chrome =
    "<html><body><nav><a href=\"https://www.mojeek.com/about\">About</a>" +
    "<a href=\"https://www.mojeek.com/preferences\">Settings</a>" +
    "<a href=\"https://blog.mojeek.com/\">Blog</a></nav>" +
    `<div>${"x".repeat(25_000)}</div></body></html>`;

  assert.deepEqual(parseMojeekOrganic(chrome), []);
  // …and the honest status for that page is a parser bug, not "ok".
  assert.equal(detectSerpBlock(chrome, parseMojeekOrganic(chrome).length), "parser-failed");
});

test("a working SERP that mentions captcha is not reported as blocked", async () => {
  const { detectSerpBlock } = await import("./serp.ts");

  // This tool's own users search for anti-bot terms; the words appearing in a
  // snippet must not turn ten parsed results into a reported block.
  const page = `<html><body>How to solve a captcha and unusual traffic errors${"x".repeat(30_000)}</body></html>`;
  assert.equal(detectSerpBlock(page, 10), "ok");
});

test("a bot challenge is reported as a block, not as zero visibility", async () => {
  const { detectSerpBlock, parseBingOrganic } = await import("./serp.ts");
  const blocked = await fixture("blocked.html");
  assert.equal(detectSerpBlock(blocked, parseBingOrganic(blocked).length), "blocked");

  const working = await fixture("bing.html");
  assert.equal(detectSerpBlock(working, 3), "ok");

  // A long page that parses to nothing means the markup moved.
  assert.equal(detectSerpBlock("<html>" + "x".repeat(30_000) + "</html>", 0), "parser-failed");
  assert.equal(detectSerpBlock("", 0), "empty-response");

  // Real-world challenge pages. DuckDuckGo never says "captcha" — it serves an
  // `anomaly-modal` puzzle with HTTP 202, and Mojeek asks for JavaScript with
  // HTTP 200. Reporting either as "parser-failed" sends people to file a bug
  // against a parser that is working correctly.
  const ddgAnomaly =
    '<html><body><div class="anomaly-modal__modal"><div class="anomaly-modal__puzzle">' +
    "x".repeat(25_000) +
    "</div></div></body></html>";
  assert.equal(detectSerpBlock(ddgAnomaly, 0), "blocked");

  const mojeekChallenge =
    "<html><body><h1>Captcha</h1><p>JavaScript is required to complete this challenge. " +
    "Please enable it and reload the page.</p></body></html>";
  assert.equal(detectSerpBlock(mojeekChallenge, 0), "blocked");

  // A 202 on a search endpoint is an interstitial, never a result page.
  assert.equal(detectSerpBlock("<html>" + "x".repeat(30_000) + "</html>", 0, 202), "blocked");
  // …but a 202 that still parsed results is not a block.
  assert.equal(detectSerpBlock("<html>" + "x".repeat(30_000) + "</html>", 5, 202), "ok");
  // A plain 200 with a long unparseable body stays a parser bug.
  assert.equal(detectSerpBlock("<html>" + "x".repeat(30_000) + "</html>", 0, 200), "parser-failed");
});

test("engine health surfaces the worst outcome per engine", async () => {
  const { engineHealth } = await import("./serp.server.ts");
  const health = engineHealth([
    query({ engine: "bing", status: "ok", results: [hit(1, "https://a.pl/x")] }),
    query({ engine: "bing", status: "blocked" }),
    query({ engine: "mojeek", status: "ok", results: [hit(1, "https://b.pl/x")] }),
  ]);
  const bing = health.find((item) => item.engine === "bing")!;
  assert.equal(bing.status, "blocked", "one block among successes still matters");
  assert.equal(bing.queries, 2);
  assert.equal(health.find((item) => item.engine === "mojeek")!.status, "ok");
});

/* ---------------------- Search Console insights -------------------------- */

function scRow(query: string, clicks: number, impressions: number, position: number) {
  return {
    keys: [query],
    clicks,
    impressions,
    ctr: impressions > 0 ? Math.round((clicks / impressions) * 1000) / 10 : 0,
    position,
  };
}

function scData(overrides: Partial<import("./types.ts").SearchConsoleData> = {}) {
  return {
    source: "google" as const,
    connected: true,
    property: "sc-domain:example.com",
    error: null,
    days: 28,
    queries: [],
    pages: [],
    previousQueries: [],
    totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
    ...overrides,
  };
}

test("striking distance ranks queries by measured click upside", async () => {
  const { strikingDistance } = await import("./search-console-insights.ts");
  const rows = strikingDistance(
    scData({
      queries: [
        scRow("big opportunity", 20, 2000, 6),
        scRow("small opportunity", 2, 60, 7),
        scRow("already first", 300, 1000, 1),
        scRow("too few impressions", 0, 5, 8),
      ],
    }),
  );
  assert.equal(rows[0]!.query, "big opportunity", "highest upside first");
  assert.ok(rows.every((row) => row.position >= 3.5 && row.position <= 15));
  assert.ok(!rows.some((row) => row.query === "already first"), "top-3 queries are not upside");
  assert.ok(!rows.some((row) => row.query === "too few impressions"));
});

test("CTR anomalies find rankings that earn no clicks", async () => {
  const { ctrAnomalies } = await import("./search-console-insights.ts");
  const rows = ctrAnomalies(
    scData({
      queries: [
        scRow("weak snippet", 5, 1000, 2), // 0.5% at position 2 — far below curve
        scRow("healthy", 150, 1000, 2),
        scRow("low volume", 0, 10, 2),
      ],
    }),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.query, "weak snippet");
  assert.ok(rows[0]!.lostClicks > 50, `expected meaningful loss, got ${rows[0]!.lostClicks}`);
});

test("decay separates lost clicks from lost positions", async () => {
  const { decayingQueries } = await import("./search-console-insights.ts");
  const rows = decayingQueries(
    scData({
      queries: [scRow("stable", 20, 1000, 4), scRow("dropped", 10, 500, 9)],
      previousQueries: [scRow("stable", 60, 1000, 4.2), scRow("dropped", 40, 500, 3)],
    }),
  );
  const stable = rows.find((row) => row.query === "stable")!;
  const dropped = rows.find((row) => row.query === "dropped")!;
  assert.equal(stable.positionStable, true, "clicks fell while position held");
  assert.equal(dropped.positionStable, false, "this one actually lost ranking");
  assert.ok(stable.clickDelta < 0);
});

test("model accuracy reports honestly when the CTR curve is off", async () => {
  const { modelAccuracy } = await import("./search-console-insights.ts");
  const unknown = modelAccuracy(scData({ queries: [scRow("a", 1, 200, 3)] }));
  assert.equal(unknown.verdict, "unknown", "too few samples to judge");

  const optimistic = modelAccuracy(
    scData({
      queries: Array.from({ length: 8 }, (_, index) => scRow(`q${index}`, 1, 1000, 1)),
    }),
  );
  // Our curve says ~27% at position 1; reality here is 0.1%.
  assert.equal(optimistic.verdict, "optimistic");
  assert.ok(optimistic.meanAbsoluteError > 10);
});

test("insights degrade gracefully without a connected account", async () => {
  const { buildSearchConsoleInsights } = await import("./search-console-insights.ts");
  assert.equal(buildSearchConsoleInsights([], []), null);

  const failed = buildSearchConsoleInsights(
    [scData({ connected: false, error: "No accessible property." })],
    [],
  );
  assert.equal(failed?.connected, false);
  assert.match(failed?.hint ?? "", /No accessible property/);
});

/* ------------------------------ disk cache ------------------------------- */

test("disk cache stores bodies and issues conditional headers", async () => {
  const { DiskCache } = await import("./disk-cache.server.ts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = await mkdtemp(join(tmpdir(), "rankproof-test-"));
  try {
    const cache = new DiskCache({ dir });
    assert.equal(cache.enabled, true);
    assert.equal(await cache.get("missing"), null);

    await cache.set("key", {
      url: "https://example.com/",
      status: 200,
      text: "<html>ok</html>",
      finalUrl: "https://example.com/",
      etag: '"abc"',
      lastModified: "Wed, 01 Jan 2025 00:00:00 GMT",
      storedAt: Date.now(),
    });
    const entry = await cache.get("key");
    assert.equal(entry?.text, "<html>ok</html>");
    assert.deepEqual(cache.conditionalHeaders(entry), {
      "If-None-Match": '"abc"',
      "If-Modified-Since": "Wed, 01 Jan 2025 00:00:00 GMT",
    });

    // Error bodies must never be cached — they would poison the next run.
    await cache.set("bad", {
      url: "https://example.com/404",
      status: 404,
      text: "not found",
      finalUrl: "https://example.com/404",
      etag: null,
      lastModified: null,
      storedAt: Date.now(),
    });
    assert.equal(await cache.get("bad"), null);

    // Expired entries are ignored.
    const expiring = new DiskCache({ dir, maxAgeMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await expiring.get("key"), null);

    const disabled = new DiskCache({ enabled: false });
    assert.equal(disabled.enabled, false);
    assert.equal(await disabled.get("key"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------------------------- site audit -------------------------------- */

test("the internal audit finds orphans, depth and wasted authority", async () => {
  const { runSiteAudit } = await import("./site-audit.server.ts");
  const { Budget } = await import("./net.server.ts");

  // A tiny site served from memory. Bodies are padded because the crawler
  // ignores responses under 200 bytes as unusable.
  const filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6);
  const page = (body: string, head = "") =>
    `<html><head><title>Example</title>${head}</head><body>${body}<p>${filler}</p></body></html>`;

  const pages: Record<string, string> = {
    "https://example.com/": page(
      `<a href="/services">Services</a><a href="/blog">Blog</a><a href="https://other.com/">External</a>`,
    ),
    "https://example.com/services": page(`<a href="/">Home</a><a href="/blog/deep">Deep</a>`),
    "https://example.com/blog": page(`<a href="/">Home</a>`),
    "https://example.com/blog/deep": page(`<a href="/">Home</a>`),
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/robots.txt")) {
      return new Response("User-agent: *\nAllow: /", { status: 200 });
    }
    const key = url.replace(/\/$/, "") || url;
    const body = pages[url] ?? pages[`${key}/`] ?? pages[key];
    return body
      ? new Response(body, { status: 200, headers: { "content-type": "text/html" } })
      : new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const { clearRobotsCache } = await import("./robots.server.ts");
    clearRobotsCache();

    const audit = await runSiteAudit(
      "https://example.com/",
      "example.com",
      new Budget(15_000),
      // /blog/deep earns external links but only one internal link.
      [{ targetPath: "/blog/deep" } as never, { targetPath: "/blog/deep" } as never],
      20,
    );

    assert.ok(audit, "the audit should return a result");
    assert.equal(audit!.status, "ok");
    assert.ok(audit!.crawled >= 4, `expected at least 4 pages, got ${audit!.crawled}`);

    // With no sitemap inventory, crawl-reachable pages are not reported as orphans
    // (inboundLinks===0 && depth>0 used to false-positive).
    assert.equal(audit!.orphans, 0, "BFS-discovered pages are not orphans");
    assert.ok(!audit!.issues.some((item) => item.id === "orphan-pages"));

    const home = audit!.pages.find((page) => page.path === "/");
    assert.equal(home?.depth, 0, "the home page is depth 0");

    const deep = audit!.pages.find((page) => page.path === "/blog/deep");
    assert.equal(deep?.depth, 2, "reached in two clicks via /services");

    // A page with backlinks but only one internal link must be flagged.
    const underlinked = audit!.issues.find((item) => item.id === "underlinked-money-pages");
    assert.ok(underlinked, "under-linked money pages should be reported");
    assert.equal(underlinked!.severity, "high");

    assert.ok(audit!.score >= 0 && audit!.score <= 100);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("orphan candidates come from inventory, not from the crawl graph alone", async () => {
  const { runSiteAudit } = await import("./site-audit.server.ts");
  const { Budget } = await import("./net.server.ts");
  const { clearRobotsCache } = await import("./robots.server.ts");

  const filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6);
  const page = (body: string) =>
    `<html><head><title>Example</title></head><body>${body}<p>${filler}</p></body></html>`;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/robots.txt")) {
      return new Response("User-agent: *\nAllow: /\nSitemap: https://example.net/sitemap.xml", {
        status: 200,
      });
    }
    if (url.endsWith("/sitemap.xml")) {
      return new Response(
        `<?xml version="1.0"?><urlset><loc>https://example.net/</loc><loc>https://example.net/orphan-only</loc></urlset>`,
        { status: 200, headers: { "content-type": "application/xml" } },
      );
    }
    if (url.includes("/orphan-only")) {
      return new Response("not linked", { status: 404 });
    }
    return new Response(page(`<a href="/about">About</a>`), {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;

  try {
    clearRobotsCache();
    const audit = await runSiteAudit("https://example.net/", "example.net", new Budget(15_000), [], 20);
    assert.equal(audit.status, "ok");
    assert.ok(audit.orphans >= 1, `expected sitemap orphan, got ${audit.orphans}`);
    assert.ok(audit.issues.some((item) => item.id === "orphan-pages"));
  } finally {
    globalThis.fetch = originalFetch;
    clearRobotsCache();
  }
});

test("crawling respects robots.txt disallow rules", async () => {
  const { runSiteAudit } = await import("./site-audit.server.ts");
  const { clearRobotsCache } = await import("./robots.server.ts");
  const { Budget } = await import("./net.server.ts");

  const fetched: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/robots.txt")) {
      return new Response("User-agent: *\nDisallow: /private/", { status: 200 });
    }
    fetched.push(url);
    const filler = "Content that makes the page long enough to be parsed. ".repeat(6);
    return new Response(
      `<html><head><title>Page</title></head><body><a href="/private/secret">Secret</a>` +
        `<a href="/public">Public</a><p>${filler}</p></body></html>`,
      { status: 200, headers: { "content-type": "text/html" } },
    );
  }) as typeof fetch;

  try {
    clearRobotsCache();
    // A different host than the previous test, so the in-memory HTTP cache
    // cannot serve those responses here.
    await runSiteAudit("https://example.org/", "example.org", new Budget(10_000), [], 10);
    assert.ok(
      !fetched.some((url) => url.includes("/private/")),
      `disallowed path was fetched: ${fetched.join(", ")}`,
    );
    assert.ok(fetched.some((url) => url.includes("/public")), "allowed paths are still crawled");
  } finally {
    globalThis.fetch = originalFetch;
    clearRobotsCache();
  }
});

/* ------------------------------- doctor ---------------------------------- */

test("doctor names the failure instead of reporting an empty result", async () => {
  const { runDoctor } = await import("./doctor.server.ts");
  const bingHtml = await fixture("bing.html");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    // Bing works; the rest serve a bot challenge.
    if (url.includes("bing.com")) {
      return new Response(bingHtml, { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response(
      "<html><body><h1>Are you a robot?</h1><p>Please complete the captcha.</p></body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    );
  }) as typeof fetch;

  try {
    const diagnosis = await runDoctor("test query");
    assert.equal(diagnosis.engines.length, 5);

    const bing = diagnosis.engines.find((item) => item.engine === "bing")!;
    assert.equal(bing.status, "ok");
    assert.ok(bing.hits >= 3);

    const brave = diagnosis.engines.find((item) => item.engine === "brave")!;
    assert.equal(brave.status, "blocked", "a challenge page must read as blocked");
    assert.match(brave.hint, /CAPTCHA|challenge/i);

    const google = diagnosis.engines.find((item) => item.engine === "google")!;
    assert.equal(google.status, "not-configured");
    assert.match(google.hint, /RANKPROOF_GOOGLE_PROVIDER_URL|Search Console/i);

    // One working engine is enough to produce usable scans.
    assert.equal(diagnosis.healthy, true);
    assert.ok(diagnosis.environment.length > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Google provider adapter parses OpenSERP-style JSON", async () => {
  const { fetchGoogleOrganicViaProvider } = await import("./serp-providers.ts");
  const { hits } = await fetchGoogleOrganicViaProvider("seo tools", {
    baseUrl: "https://provider.test",
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          organic: [
            { link: "https://a.example/x", title: "A", snippet: "one" },
            { url: "https://b.example/y", title: "B", description: "two" },
          ],
        }),
        { status: 200 },
      )) as typeof fetch,
  });
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.url, "https://a.example/x");
  assert.equal(hits[1]!.position, 2);
});
