import { classifyAnchor } from "./html.ts";
import {
  hostFromUrl,
  isTargetHost,
  normalizeUrl,
  parseTarget,
  pathOf,
  registrableDomain,
  sld,
  stripWww,
} from "./parse.ts";
import { Budget, mapLimit, timed, type Timed } from "./net.server.ts";
import {
  scanBing,
  scanBluesky,
  scanDuckDuckGo,
  scanGdelt,
  scanGithub,
  scanHackerNews,
  scanMojeek,
  scanNews,
  scanReddit,
  scanStackExchange,
  scanUrlscan,
  scanWikipedia,
  waybackFirstSeen,
  type Candidate,
} from "./sources.server.ts";
import { inspectTarget } from "./target.server.ts";
import {
  findLostLinks,
  markSitewide,
  probeTargets,
  verifyPages,
  type ProbeResult,
} from "./verify.server.ts";
import { computeDomainRating, pageRank, rankToScore, type DomainEdge } from "./graph.ts";
import { resolveDomains } from "./dns.server.ts";
import {
  backlinkId,
  buildAnalytics,
  capPerDomain,
  domainScore,
  sortBacklinks,
  spamScore,
} from "./score.ts";
import { collectKeywords, pickSerpKeywords, buildKeywordStats } from "./keywords.ts";
import { buildAnchorAudit, buildToxicReport } from "./toxic.ts";
import { buildSegments, buildVelocity } from "./segments.ts";
import { buildActionPlan } from "./plan.ts";
import { config } from "./config.ts";
import { buildBrandSerp } from "./brand-serp.ts";
import { buildFootprint, buildScorecard } from "./scorecard.ts";
import { runSiteAudit } from "./site-audit.server.ts";
import { fetchSearchConsoleData } from "./search-console.server.ts";
import { buildSearchConsoleInsights } from "./search-console-insights.ts";
import {
  buildProspects,
  emptySerp,
  markSerpCorankers,
  runSerpQueries,
  snapshotFromQueries,
} from "./serp.server.ts";
import type {
  Backlink,
  Mention,
  SerpDevice,
  SerpEngine,
  SerpMarket,
  OutboundDomain,
  ScanReport,
  ScanResult,
  SerpQuery,
  SiteSnapshot,
  SourceReport,
  SourceStatus,
} from "./types.ts";

export const REPORT_VERSION = 5;


const MAX_MENTIONS = 120;
const MAX_DEEP = 28;
const MAX_THIRD = 14;

function sourceReport(
  id: string,
  label: string,
  found: number,
  ms: number,
  error?: string,
): SourceReport {
  let status: SourceStatus = "ok";
  if (error) status = "error";
  else if (found === 0) status = "empty";
  return { id, label, status, found, ms, detail: error };
}

/** Fills an API record with the fields the report requires. */
function hydrate(partial: Partial<Backlink>, host: string, tokens: string[]): Backlink | null {
  if (!partial.sourceUrl || !partial.targetUrl) return null;
  const sourceUrl = normalizeUrl(partial.sourceUrl);
  const targetUrl = normalizeUrl(partial.targetUrl);
  const sourceHost = partial.sourceHost || hostFromUrl(sourceUrl);
  const anchor = (partial.anchor ?? "").trim();
  return {
    id: backlinkId({ sourceUrl, targetUrl, anchor }),
    sourceUrl,
    sourceHost,
    sourceDomain: partial.sourceDomain || registrableDomain(sourceHost),
    sourceTitle: partial.sourceTitle || sourceHost,
    sourceLang: partial.sourceLang ?? null,
    targetUrl,
    targetPath: pathOf(targetUrl),
    anchor,
    anchorType: partial.anchorType ?? classifyAnchor(anchor, host, tokens, false),
    rel: partial.rel ?? "nofollow",
    effectiveFollow: partial.effectiveFollow ?? partial.rel === "dofollow",
    placement: partial.placement ?? "content",
    sitewide: false,
    discoveredVia: partial.discoveredVia ?? "lookup",
    wikiLang: partial.wikiLang,
    verified: partial.verified ?? false,
    firstSeen: null,
    httpStatus: partial.httpStatus ?? null,
    targetStatus: null,
    domainScore: 0,
    spamScore: 0,
    relevance: partial.relevance ?? 50,
    targetFinalUrl: null,
    state: "live",
    lastSeen: null,
    flags: partial.flags ?? [],
  };
}

function mergeBacklinks(list: Backlink[], incoming: Backlink[]) {
  const index = new Map(list.map((item, i) => [item.id, i]));
  for (const item of incoming) {
    const at = index.get(item.id);
    if (at === undefined) {
      index.set(item.id, list.length);
      list.push(item);
      continue;
    }
    // Keep the HTML-verified version — it knows rel and placement.
    const current = list[at]!;
    if (!current.verified && item.verified) list[at] = item;
  }
}

function mergeMentions(list: Mention[], incoming: Mention[], linkedDomains: Set<string>) {
  const seen = new Set(list.map((m) => normalizeUrl(m.sourceUrl)));
  for (const item of incoming) {
    const key = normalizeUrl(item.sourceUrl);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({
      ...item,
      // A domain that already links is not a link opportunity.
      linkOpportunity: item.linkOpportunity && !linkedDomains.has(item.sourceDomain),
    });
  }
}

function pushCandidates(list: Candidate[], incoming: Candidate[] | undefined) {
  if (!incoming) return;
  const seen = new Set(list.map((c) => normalizeUrl(c.url)));
  for (const item of incoming) {
    const key = normalizeUrl(item.url);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(item);
  }
}

export type ScanOptions = {
  /** "light" = faster helper scan (e.g. a competitor in a link-gap analysis). */
  mode?: "full" | "light";
  budgetMs?: number;
  /** Market the positions are measured in (country + language). */
  market?: SerpMarket;
  /** Device: desktop or mobile. */
  device?: SerpDevice;
  /** Override configured SERP engines for this run. */
  engines?: SerpEngine[];
  /** Skips the internal crawl — useful in CI and for quick lookups. */
  skipSiteAudit?: boolean;
};

export async function runScan(rawInput: string, options: ScanOptions = {}): Promise<ScanResult> {
  const startedAt = Date.now();
  const light = options.mode === "light";
  let parsed;
  try {
    parsed = parseTarget(rawInput);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Invalid address.",
    };
  }

  const { host } = parsed;
  const runtime = config();
  const budget = new Budget(
    options.budgetMs ?? (light ? runtime.lightBudgetMs : runtime.scanBudgetMs),
  );
  const notes: string[] = [];

  /* --- Phase 1: target plus sources that need no brand tokens ---------------------- */
  const intelT = timed(() => inspectTarget(host, budget));
  const wikiT = timed(() => scanWikipedia(host, budget.signal));
  const urlscanT = timed(() => scanUrlscan(host, budget.signal));
  const seT = timed(() => scanStackExchange(host, budget.signal));
  const redditT = timed(() => scanReddit([host, sld(host)], host, budget.signal));

  const intelR = await intelT;
  if (intelR.error) notes.push(`Analiza celu: ${intelR.error}`);
  notes.push(...(intelR.value?.notes ?? []));

  const tokens = intelR.value?.tokens ?? [sld(host)];
  const queries = [host, ...tokens.filter((t) => t.toLowerCase() !== host)].slice(0, 3);

  /* --- Phase 2: sources that use the brand name ----------------------- */
  const skip = <T>(value: T) => timed(async () => value);

  const hnT = light
    ? skip({ backlinks: [], mentions: [] })
    : timed(() => scanHackerNews(queries, host, budget.signal));
  const bingT = timed(() => scanBing(host, tokens, budget.signal));
  const ddgT = timed(() => scanDuckDuckGo(host, tokens, budget.signal));
  const mojeekT = timed(() => scanMojeek(host, tokens, budget.signal));
  const newsT = light
    ? skip({ mentions: [], candidates: [] as Candidate[] })
    : timed(() => scanNews(queries, host, budget.signal));
  const githubT = timed(() => scanGithub(queries, host, budget.signal));
  const gdeltT = light ? skip([] as Candidate[]) : timed(() => scanGdelt(host, budget.signal));
  const bskyT = light
    ? skip({ backlinks: [], mentions: [] })
    : timed(() => scanBluesky(queries, host, budget.signal));

  const [wikiR, urlscanR, seR, redditR, hnR, bingR, ddgR, mojeekR, newsR, githubR, gdeltR, bskyR] =
    await Promise.all([
      wikiT,
      urlscanT,
      seT,
      redditT,
      hnT,
      bingT,
      ddgT,
      mojeekT,
      newsT,
      githubT,
      gdeltT,
      bskyT,
    ]);

  const backlinks: Backlink[] = [];
  const mentions: Mention[] = [];
  const candidates: Candidate[] = [];
  const linkedDomains = new Set<string>();

  const addPartials = (items: Partial<Backlink>[] | undefined) => {
    if (!items) return;
    const hydrated = items
      .map((item) => hydrate(item, host, tokens))
      .filter((item): item is Backlink => item !== null)
      // A link from the same site is not a reciprocal backlink.
      .filter((item) => !isTargetHost(item.sourceHost, host));
    mergeBacklinks(backlinks, hydrated);
  };

  addPartials(wikiR.value as unknown as Partial<Backlink>[] | undefined);
  addPartials(hnR.value?.backlinks);
  addPartials(redditR.value?.backlinks);
  addPartials(bskyR.value?.backlinks);
  addPartials(githubR.value?.backlinks);

  mergeMentions(mentions, hnR.value?.mentions ?? [], linkedDomains);
  mergeMentions(mentions, redditR.value?.mentions ?? [], linkedDomains);
  mergeMentions(mentions, bskyR.value?.mentions ?? [], linkedDomains);
  mergeMentions(mentions, newsR.value?.mentions ?? [], linkedDomains);

  pushCandidates(candidates, intelR.value?.outbound);
  pushCandidates(candidates, githubR.value?.candidates);
  pushCandidates(candidates, bingR.value);
  pushCandidates(candidates, ddgR.value);
  pushCandidates(candidates, mojeekR.value);
  pushCandidates(candidates, urlscanR.value);
  pushCandidates(candidates, gdeltR.value);
  pushCandidates(candidates, seR.value);
  pushCandidates(candidates, newsR.value?.candidates);

  /* --- Phase 3: HTML verification (waves) + SERP ---------------------- */
  const seen = new Set<string>();
  const edges: DomainEdge[] = [];
  const unlinkedPages: string[] = [];
  let checked = 0;

  const topicTerms = intelR.value?.topicTerms ?? new Map<string, number>();

  const seedKeywords = pickSerpKeywords(
    collectKeywords({
      title: intelR.value?.snapshot.title,
      description: intelR.value?.snapshot.description,
      h1: intelR.value?.headings.h1,
      h2: intelR.value?.headings.h2,
      brandTokens: tokens,
      content: intelR.value?.contentText,
    }),
    light ? 0 : 5,
  );

  // The brand is a separate query: it shows what a customer who already knows you sees.
  const brandQuery = tokens[0] && tokens[0].length >= 3 ? [tokens[0]] : [];
  const serpKeywords = [...new Set([...brandQuery, ...seedKeywords])].slice(0, 6);

  const serpT = light
    ? skip([] as SerpQuery[])
    : timed(() =>
        runSerpQueries(host, serpKeywords, budget, options.engines?.length ? options.engines : runtime.engines, {
          depth: runtime.serpDepth,
          maxKeywords: 6,
          market: options.market ?? runtime.market,
          device: options.device ?? runtime.device,
        }),
      );

  const wave1P = verifyPages(candidates, {
    host,
    brandTokens: tokens,
    topicTerms,
    limit: budget.scale(runtime.maxVerify, 22_000),
    perDomain: 3,
    budget,
    seen,
  });

  const [wave1, serpR] = await Promise.all([wave1P, serpT]);

  mergeBacklinks(backlinks, wave1.backlinks);
  mergeMentions(mentions, wave1.mentions, linkedDomains);
  edges.push(...wave1.edges);
  unlinkedPages.push(...wave1.unlinkedPages);
  checked += wave1.checked;

  const wave2 = await verifyPages(light ? [] : wave1.deeper, {
    host,
    brandTokens: tokens,
    topicTerms,
    limit: budget.scale(MAX_DEEP, 10_000),
    perDomain: 4,
    budget,
    seen,
  });
  mergeBacklinks(backlinks, wave2.backlinks);
  mergeMentions(mentions, wave2.mentions, linkedDomains);
  edges.push(...wave2.edges);
  unlinkedPages.push(...wave2.unlinkedPages);
  checked += wave2.checked;

  let wave3Found = 0;
  if (!light && !budget.spent(0.8)) {
    const wave3 = await verifyPages(wave2.deeper, {
      host,
      brandTokens: tokens,
      topicTerms,
      limit: budget.scale(MAX_THIRD, 6000),
      perDomain: 3,
      budget,
      seen,
    });
    mergeBacklinks(backlinks, wave3.backlinks);
    mergeMentions(mentions, wave3.mentions, linkedDomains);
    edges.push(...wave3.edges);
    unlinkedPages.push(...wave3.unlinkedPages);
    checked += wave3.checked;
    wave3Found = wave3.backlinks.length;
  } else {
    notes.push("Third verification wave skipped — scan time budget reached.");
  }

  /* --- Phase 4: lost links from the archive ----------------------------- */
  let lostLinks: Backlink[] = [];
  if (!light && !budget.spent(0.72) && unlinkedPages.length > 0) {
    lostLinks = await findLostLinks(unlinkedPages, {
      host,
      brandTokens: tokens,
      budget,
      limit: budget.scale(14, 6000),
    });
    if (lostLinks.length > 0) {
      notes.push(`Archive: ${lostLinks.length} lost links available to recover.`);
    }
  }

  /* --- Phase 5: enrichment and scoring ---------------------------------- */
  let enriched = markSitewide([...backlinks, ...lostLinks]);

  const wikiDomains = new Set(
    enriched.filter((b) => b.discoveredVia === "wikipedia").map((b) => b.sourceDomain),
  );
  const domains = [...new Set(enriched.map((b) => b.sourceDomain))];
  const domainPages = new Map<string, number>();
  for (const item of enriched) {
    domainPages.set(item.sourceDomain, (domainPages.get(item.sourceDomain) ?? 0) + 1);
  }

  const ageLookup = new Map<string, string | null>();
  if (!light && !budget.spent(0.88)) {
    const topDomains = domains
      .sort((a, b) => (domainPages.get(b) ?? 0) - (domainPages.get(a) ?? 0))
      .slice(0, budget.scale(24, 6000));
    await mapLimit(topDomains, 6, async (domain) => {
      ageLookup.set(domain, await waybackFirstSeen(domain, budget.signal));
    });
  }

  const targetStatuses =
    light || budget.spent(0.92)
      ? new Map<string, ProbeResult>()
      : await probeTargets(
          enriched.map((b) => b.targetUrl),
          budget,
          budget.scale(30, 5000),
        );

  const anchorsByDomain = new Map<string, string[]>();
  for (const item of enriched) {
    const list = anchorsByDomain.get(item.sourceDomain) ?? [];
    list.push(item.anchor);
    anchorsByDomain.set(item.sourceDomain, list);
  }

  enriched = enriched.map((item) => {
    const firstSeen = ageLookup.get(item.sourceDomain) ?? null;
    const score = domainScore({
      host: item.sourceHost,
      firstSeen,
      wikipedia: wikiDomains.has(item.sourceDomain),
      linkingPages: domainPages.get(item.sourceDomain) ?? 1,
      https: item.sourceUrl.startsWith("https://"),
      lang: item.sourceLang,
      discoveredVia: item.discoveredVia,
    });
    const spam = spamScore({
      host: item.sourceHost,
      anchors: anchorsByDomain.get(item.sourceDomain) ?? [],
      placement: item.placement,
      sitewide: item.sitewide,
      title: item.sourceTitle,
    });
    const probe = targetStatuses.get(item.targetUrl) ?? null;
    const status = probe?.status ?? null;
    const finalUrl = probe && probe.finalUrl !== item.targetUrl ? probe.finalUrl : null;
    const flags = [...item.flags];
    if (finalUrl && !flags.includes("redirected-target")) {
      flags.push("redirected-target");
    }
    // 401/403/429 usually means bot protection, not a broken address.
    const reallyBroken = status !== null && (status === 404 || status === 410 || status >= 500);
    if (reallyBroken && !flags.includes("broken-target")) {
      flags.push("broken-target");
    }
    if (spam >= 55 && !flags.includes("spam-risk")) flags.push("spam-risk");
    if (score >= 75 && !flags.includes("high-authority")) flags.push("high-authority");
    return {
      ...item,
      firstSeen,
      domainScore: score,
      spamScore: spam,
      targetStatus: status,
      targetFinalUrl: finalUrl,
      flags,
    };
  });

  /* --- Phase 6: domain graph, PageRank and subnets ---------------------- */
  for (const item of enriched) {
    edges.push({ from: item.sourceDomain, to: parsed.domain, weight: 3 });
  }
  const ranks = rankToScore(pageRank(edges));

  const ipLookup =
    light || budget.spent(0.94)
      ? new Map<string, string[]>()
      : await resolveDomains(
          [...new Set(enriched.map((b) => b.sourceDomain))],
          budget,
          budget.scale(40, 4000),
        );

  const lostByDomain = new Map<string, number>();
  for (const item of enriched) {
    if (item.state !== "lost") continue;
    lostByDomain.set(item.sourceDomain, (lostByDomain.get(item.sourceDomain) ?? 0) + 1);
  }

  // The target's outbound links, plus reciprocal-link detection.
  const outboundMap = new Map<string, OutboundDomain>();
  for (const item of intelR.value?.outbound ?? []) {
    if (item.via !== "graph") continue;
    const domain = registrableDomain(hostFromUrl(item.url));
    if (!domain) continue;
    const current = outboundMap.get(domain);
    if (current) current.links += 1;
    else {
      outboundMap.set(domain, {
        domain,
        links: 1,
        reciprocal: false,
        sampleUrl: item.url,
        status: null,
      });
    }
  }
  const linkingDomains = new Set(enriched.map((b) => b.sourceDomain));
  const reciprocal = new Set<string>();
  for (const [domain, entry] of outboundMap) {
    if (linkingDomains.has(domain)) {
      entry.reciprocal = true;
      reciprocal.add(domain);
    }
  }
  if (!light && !budget.spent(0.96)) {
    const probes = await probeTargets(
      [...outboundMap.values()].slice(0, 20).map((item) => item.sampleUrl),
      budget,
      budget.scale(20, 4000),
    );
    for (const entry of outboundMap.values()) {
      const probe = probes.get(normalizeUrl(entry.sampleUrl));
      if (probe) entry.status = probe.status;
    }
  }

  const outboundDomains = [...outboundMap.values()].sort(
    (a, b) => Number(b.reciprocal) - Number(a.reciprocal) || b.links - a.links,
  );

  enriched = enriched.map((item) =>
    reciprocal.has(item.sourceDomain) && !item.flags.includes("reciprocal")
      ? { ...item, flags: [...item.flags, "reciprocal" as const] }
      : item,
  );

  for (const item of enriched) linkedDomains.add(item.sourceDomain);
  const mentionList = mentions
    .map((m) => ({
      ...m,
      linkOpportunity: m.linkOpportunity && !linkedDomains.has(m.sourceDomain),
    }))
    .slice(0, MAX_MENTIONS);

  const serpQueries = serpR.value ?? [];
  enriched = markSerpCorankers(enriched, serpQueries);

  const ranked = capPerDomain(sortBacklinks(enriched), 25).slice(0, runtime.maxBacklinks);

  const site: SiteSnapshot = intelR.value?.snapshot ?? {
    host,
    domain: parsed.domain,
    url: parsed.url,
    title: null,
    description: null,
    lang: null,
    status: null,
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

  const keywordSeeds = collectKeywords({
    title: site.title,
    description: site.description,
    h1: intelR.value?.headings.h1,
    h2: intelR.value?.headings.h2,
    brandTokens: tokens,
    content: intelR.value?.contentText,
    anchors: ranked.map((item) => ({
      text: item.anchor,
      type: item.anchorType,
      count: 1,
      domains: 1,
      share: 0,
    })),
  });
  const targetText = `${site.title ?? ""} ${site.description ?? ""} ${
    intelR.value?.contentText ?? ""
  }`;
  const serpSnapshot =
    serpQueries.length > 0
      ? snapshotFromQueries(serpQueries, {
          linkingDomains,
          brandTokens: tokens,
          targetText: light ? "" : targetText,
        })
      : emptySerp(options.market ?? runtime.market, options.device ?? runtime.device);
  const prospects = buildProspects({
    host,
    queries: serpQueries,
    linkingDomains,
    mentions: mentionList,
    lost: ranked.filter((b) => b.state === "lost"),
  });
  const onPage = intelR.value?.onPage ?? null;

  const analytics = buildAnalytics(ranked, mentionList, site, {
    ranks,
    ips: ipLookup,
    lostByDomain,
    reciprocal,
    outbound: outboundDomains.slice(0, 60),
    lostLinks: ranked.filter((b) => b.state === "lost"),
    visibility: serpSnapshot.visibility,
    rankedKeywords: serpSnapshot.ranked,
    keywordCount: keywordSeeds.length,
    onPageIssues: onPage?.issues,
  });

  const domainRating = computeDomainRating(analytics.referringDomains);
  site.domainRating = domainRating;
  const keywordStats = buildKeywordStats(keywordSeeds, serpQueries, analytics.anchors, tokens);
  const toxic = buildToxicReport(ranked, analytics.referringDomains);
  const anchorAudit = buildAnchorAudit(analytics.anchors, analytics.anchorTypes);
  const segments = buildSegments(analytics.referringDomains, ranked);
  const velocity = buildVelocity(analytics.referringDomains, []);
  const footprint = buildFootprint(analytics.referringDomains, ranked, analytics.anchorTypes);
  const brandSerp = buildBrandSerp(serpQueries, {
    host,
    brandTokens: tokens,
    competitors: new Set(serpSnapshot.competitors.map((item) => item.domain)),
  });
  // Clusters, content gaps and featured opportunities are computed in snapshotFromQueries.
  const clusters = serpSnapshot.clusters;
  const featured = serpSnapshot.featured;
  const enrichedSerp = serpSnapshot;

  /* --- Phase 7: own-site audit and owner-level performance data --------- */

  // The internal audit needs its own budget: it crawls the target, not the web.
  const siteAudit =
    light || options.skipSiteAudit
      ? null
      : await runSiteAudit(
          site.url,
          host,
          new Budget(Math.max(8_000, Math.min(25_000, budget.left() + 12_000))),
          ranked,
          Math.max(10, budget.scale(80, 15_000)),
        );

  // Real clicks and impressions, but only when the operator connected an account.
  const searchConsole = light
    ? null
    : buildSearchConsoleInsights(
        await fetchSearchConsoleData(host).catch(() => []),
        serpQueries,
      );

  const scorecard = buildScorecard({
    analytics,
    serp: serpSnapshot,
    onPage,
    toxic,
    anchorAudit,
    footprint,
    velocity,
    brandSerp,
    domainRating,
    referringDomains: analytics.referringDomains.length,
    siteAudit,
    searchConsole,
  });

  const brokenTargetLinks = ranked.filter((b) => b.flags.includes("broken-target")).length;
  const plan = buildActionPlan({
    host,
    stats: {
      backlinks: ranked.length,
      brokenLinks: brokenTargetLinks,
    },
    analytics,
    serp: enrichedSerp,
    keywords: keywordStats,
    clusters,
    featured,
    prospects,
    toxic,
    anchorAudit,
    segments,
    velocity,
    onPage,
    siteAudit,
    searchConsole,
  });

  const referring = analytics.referringDomains;
  const dofollow = ranked.filter((b) => b.effectiveFollow).length;
  const avgDomainScore =
    referring.length > 0
      ? Math.round(referring.reduce((sum, d) => sum + d.domainScore, 0) / referring.length)
      : 0;

  const count = <T>(result: Timed<T>, fn: (value: T) => number): number =>
    result.value === undefined ? 0 : fn(result.value);

  const sources: SourceReport[] = [
    sourceReport(
      "graph",
      "Site graph, sitemap and archive",
      intelR.value?.outbound.length ?? 0,
      intelR.ms,
      intelR.error,
    ),
    sourceReport(
      "wikipedia",
      "Wikipedia / Wikimedia",
      wikiR.value?.length ?? 0,
      wikiR.ms,
      wikiR.error,
    ),
    sourceReport(
      "github",
      "GitHub",
      count(githubR, (v) => v.backlinks.length + v.candidates.length),
      githubR.ms,
      githubR.error,
    ),
    sourceReport(
      "hacker-news",
      "Hacker News",
      count(hnR, (v) => v.backlinks.length + v.mentions.length),
      hnR.ms,
      hnR.error,
    ),
    sourceReport(
      "reddit",
      "Reddit",
      count(redditR, (v) => v.backlinks.length + v.mentions.length),
      redditR.ms,
      redditR.error,
    ),
    sourceReport(
      "bluesky",
      "Bluesky",
      count(bskyR, (v) => v.backlinks.length + v.mentions.length),
      bskyR.ms,
      bskyR.error,
    ),
    sourceReport("stackexchange", "Stack Exchange", seR.value?.length ?? 0, seR.ms, seR.error),
    sourceReport("bing", "Bing", bingR.value?.length ?? 0, bingR.ms, bingR.error),
    sourceReport("duckduckgo", "DuckDuckGo", ddgR.value?.length ?? 0, ddgR.ms, ddgR.error),
    sourceReport("mojeek", "Mojeek", mojeekR.value?.length ?? 0, mojeekR.ms, mojeekR.error),
    sourceReport(
      "news",
      "Google News",
      count(newsR, (v) => v.mentions.length),
      newsR.ms,
      newsR.error,
    ),
    sourceReport("gdelt", "GDELT", gdeltR.value?.length ?? 0, gdeltR.ms, gdeltR.error),
    sourceReport("urlscan", "urlscan.io", urlscanR.value?.length ?? 0, urlscanR.ms, urlscanR.error),
    sourceReport(
      "verify",
      "Weryfikacja HTML (3 fale)",
      wave1.backlinks.length + wave2.backlinks.length + wave3Found,
      0,
    ),
    sourceReport(
      "serp",
      `SERP (${serpSnapshot.engines.join(" / ") || "Bing / DuckDuckGo"})`,
      serpSnapshot.ranked,
      serpR.ms,
      serpR.error,
    ),
  ];

  const report: ScanReport = {
    version: REPORT_VERSION,
    queriedAt: new Date().toISOString(),
    input: rawInput.trim(),
    target: site,
    sources,
    backlinks: ranked,
    mentions: mentionList,
    stats: {
      backlinks: ranked.length,
      referringDomains: referring.length,
      dofollow,
      nofollow: ranked.length - dofollow,
      mentions: mentionList.length,
      pagesCrawled: intelR.value?.pagesCrawled ?? 0,
      candidatesChecked: checked,
      brokenLinks: brokenTargetLinks,
      sitewideLinks: ranked.filter((b) => b.sitewide).length,
      contentLinks: ranked.filter((b) => b.placement === "content").length,
      spamDomains: referring.filter((d) => d.spamScore >= 55).length,
      authorityDomains: referring.filter((d) => d.domainScore >= 75).length,
      uniqueAnchors: new Set(ranked.map((b) => b.anchor.toLowerCase())).size,
      avgDomainScore,
      avgRelevance:
        ranked.length > 0
          ? Math.round(ranked.reduce((sum, b) => sum + b.relevance, 0) / ranked.length)
          : 0,
      domainRating,
      redirectedLinks: ranked.filter((b) => b.flags.includes("redirected-target")).length,
      brokenOutbound: outboundDomains.filter(
        (o) => o.status !== null && (o.status === 404 || o.status === 410 || o.status >= 500),
      ).length,
      referringIps: new Set(analytics.referringDomains.flatMap((d) => d.ips)).size,
      referringSubnets: new Set(
        analytics.referringDomains.map((d) => d.subnet).filter((s): s is string => Boolean(s)),
      ).size,
      lostLinks: ranked.filter((b) => b.state === "lost").length,
      outboundDomains: outboundDomains.length,
      reciprocalDomains: reciprocal.size,
      durationMs: Date.now() - startedAt,
      serpVisibility: serpSnapshot.visibility,
      rankedKeywords: serpSnapshot.ranked,
      onPageScore: onPage?.score ?? 0,
      prospects: prospects.length,
      serpTraffic: serpSnapshot.trafficScore,
      keywordClusters: clusters.length,
      visibilityIndex: scorecard.index,
      footprintRisk: footprint.score,
      brandControl: brandSerp?.control ?? 0,
      siteHealth: siteAudit?.score ?? 0,
      internalPages: siteAudit?.crawled ?? 0,
      realClicks:
        searchConsole?.providers.reduce((sum, item) => sum + item.totals.clicks, 0) ?? 0,
      linkVelocity: velocity.perMonth,
      actions: plan.items.length,
      toxicDomains: toxic.disavowCount,
      anchorScore: anchorAudit.score,
      serpCompetitors: serpSnapshot.competitors.length,
    },
    analytics,
    notes: [...new Set(notes)].slice(0, 8),
    trend: [],
    delta: null,
    persisted: false,
    serp: enrichedSerp,
    keywords: keywordStats,
    prospects,
    onPage,
    toxic,
    anchorAudit,
    segments,
    velocity,
    plan,
    brandSerp,
    footprint,
    scorecard,
    searchConsole,
    siteAudit,
  };

  return { ok: true, report };
}

export { stripWww };
