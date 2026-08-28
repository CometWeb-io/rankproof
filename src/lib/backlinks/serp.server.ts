import { isTargetHost, parseTarget } from "./parse.ts";

import { Budget, BROWSER_UA, fetchText, mapLimit, timed } from "./net.server.ts";
import { DEFAULT_MARKET, MOBILE_UA, acceptLanguage, marketParams } from "./market.ts";
import {
  detectSerpBlock,
  detectSerpFeatures,
  mergePages,
  parseBingOrganic,
  parseBraveOrganic,
  parseDdgOrganic,
  parseMojeekOrganic,
  parsePeopleAlsoAsk,
  parseRelatedSearches,
  targetPosition,
  toSerpHits,
  type OrganicHit,
} from "./serp.ts";
import {
  clusterKeywords,
  contentGapTerms,
  engineConsensus,
  featuredOpportunities,
  positionBuckets,
} from "./serp-cluster.ts";
import {
  buildRankMoves,
  buildSerpCompetitors,
  classifyIntent,
  collectSerpExtras,
  detectCannibalization,
  keywordDifficulty,
  serpAggregates,
  type PositionRow,
} from "./serp-intel.ts";
import { buildKeywordStats, pickSerpKeywords, visibilityScore, type KeywordSeed } from "./keywords.ts";
import { domainScore } from "./score.ts";
import type {
  AnchorStat,
  Backlink,
  RankMove,
  SerpDevice,
  SerpMarket,
  SerpCheckResult,
  SerpEngine,
  SerpProspect,
  SerpQuery,
  SerpSnapshot,
  SerpStatus,
} from "./types.ts";

import {
  BUILTIN_SCRAPE_ENGINES,
  fetchGoogleOrganicViaProvider,
  googleProviderBaseUrl,
  isEngineConfigured,
} from "./serp-providers.ts";

export const ALL_ENGINES: SerpEngine[] = [...BUILTIN_SCRAPE_ENGINES, "google"];

/** The SERP URL for a given results page (0 = the first ten). */
const ENGINE_URL: Record<Exclude<SerpEngine, "google">, (q: string, page: number) => string> = {
  bing: (q, page) =>
    `https://www.bing.com/search?count=10&first=${page * 10 + 1}&q=${encodeURIComponent(q)}`,
  duckduckgo: (q, page) =>
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}${
      page > 0 ? `&s=${page * 30}&dc=${page * 30 + 1}` : ""
    }`,
  mojeek: (q, page) =>
    `https://www.mojeek.com/search?q=${encodeURIComponent(q)}${page > 0 ? `&s=${page * 10 + 1}` : ""}`,
  brave: (q, page) =>
    `https://search.brave.com/search?q=${encodeURIComponent(q)}${page > 0 ? `&offset=${page}` : ""}`,
};

const PARSE: Record<Exclude<SerpEngine, "google">, (html: string) => OrganicHit[]> = {
  bing: parseBingOrganic,
  duckduckgo: parseDdgOrganic,
  mojeek: parseMojeekOrganic,
  brave: parseBraveOrganic,
};

async function fetchSerpPage(
  engine: SerpEngine,
  keyword: string,
  page: number,
  budget: Budget,
  market: SerpMarket,
  device: SerpDevice,
): Promise<{ hits: OrganicHit[]; html: string; httpStatus?: number }> {
  if (engine === "google") {
    const base = googleProviderBaseUrl();
    if (!base) {
      throw new Error(
        "Google organic requires RANKPROOF_GOOGLE_PROVIDER_URL (self-hosted OpenSERP-compatible JSON).",
      );
    }
    return fetchGoogleOrganicViaProvider(keyword, {
      baseUrl: base,
      market,
      device,
      page,
    });
  }

  const url = `${ENGINE_URL[engine](keyword, page)}${marketParams(engine, market, device)}`;
  const { status, text } = await fetchText(url, {
    timeoutMs: budget.timeout(8000),
    maxBytes: 360_000,
    ua: device === "mobile" ? MOBILE_UA : BROWSER_UA,
    acceptLanguage: acceptLanguage(market),
    signal: budget.signal,
    skipRobots: true,
    cache: false,
    // Browser-like Accept/Referer reduces empty challenge pages on some engines.
    headers: {
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      ...(engine === "duckduckgo"
        ? { Referer: "https://html.duckduckgo.com/" }
        : engine === "mojeek"
          ? { Referer: "https://www.mojeek.com/" }
          : engine === "brave"
            ? { Referer: "https://search.brave.com/" }
            : { Referer: "https://www.bing.com/" }),
    },
  });
  if (status >= 400) throw new Error(`HTTP ${status}`);
  return { hits: PARSE[engine](text), html: text, httpStatus: status };
}

function statusFromFetchError(error: unknown): SerpStatus {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP 429/.test(message)) return "rate-limited";
  if (/HTTP 403|HTTP 401/.test(message)) return "blocked";
  return "error";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One gentle retry on 429 — engines often unblock after a short pause. */
async function fetchSerpPageWithRetry(
  engine: SerpEngine,
  keyword: string,
  page: number,
  budget: Budget,
  market: SerpMarket,
  device: SerpDevice,
): Promise<{ hits: OrganicHit[]; html: string; httpStatus?: number }> {
  try {
    return await fetchSerpPage(engine, keyword, page, budget, market, device);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/HTTP 429/.test(message) || budget.left() < 2500) throw error;
    await sleep(1_200, budget.signal);
    return fetchSerpPage(engine, keyword, page, budget, market, device);
  }
}

async function fetchSerpQuery(
  engine: SerpEngine,
  keyword: string,
  host: string,
  budget: Budget,
  depth: number,
  market: SerpMarket,
  device: SerpDevice,
): Promise<SerpQuery> {
  const started = Date.now();
  const empty = (status: SerpStatus): SerpQuery => ({
    keyword,
    engine,
    targetPosition: null,
    results: [],
    features: [],
    related: [],
    questions: [],
    depth: 0,
    difficulty: 0,
    market,
    device,
    status,
    ms: Date.now() - started,
  });

  if (!isEngineConfigured(engine)) return empty("not-configured");

  try {
    const first = await fetchSerpPageWithRetry(engine, keyword, 0, budget, market, device);
    const pages = [first.hits];

    // A second page only when we really want the top 20 and time allows.
    if (depth > 10 && !budget.spent(0.85) && budget.left() > 3000) {
      try {
        const second = await fetchSerpPageWithRetry(engine, keyword, 1, budget, market, device);
        if (second.hits.length > 0) pages.push(second.hits);
      } catch {
        // Second page is often blocked — first page is enough.
      }
    }

    const merged = mergePages(pages).slice(0, depth);
    const hits = toSerpHits(merged, host);
    const query: SerpQuery = {
      keyword,
      engine,
      targetPosition: targetPosition(hits),
      results: hits,
      features: engine === "google" ? [] : detectSerpFeatures(first.html, engine),
      related: engine === "google" ? [] : parseRelatedSearches(first.html, engine),
      questions: engine === "google" ? [] : parsePeopleAlsoAsk(first.html),
      depth: hits.length,
      difficulty: 0,
      market,
      device,
      status:
        engine === "google"
          ? hits.length > 0
            ? "ok"
            : "no-results"
          : detectSerpBlock(first.html, hits.length, first.httpStatus),
      ms: Date.now() - started,
    };
    return { ...query, difficulty: keywordDifficulty(query) };
  } catch (error) {
    return empty(statusFromFetchError(error));
  }
}

/**
 * Check the target's organic positions on Bing / DDG / Mojeek / Brave / Google
 * for keywords extracted from the page and its anchors.
 */
export async function runSerpQueries(
  host: string,
  keywords: string[],
  budget: Budget,
  engines: SerpEngine[] = ["bing", "duckduckgo"],
  options: {
    depth?: number;
    maxKeywords?: number;
    market?: SerpMarket;
    device?: SerpDevice;
  } = {},
): Promise<SerpQuery[]> {
  const depth = Math.max(10, Math.min(20, options.depth ?? 10));
  const market = options.market ?? DEFAULT_MARKET;
  const device = options.device ?? "desktop";
  const unique = [...new Set(keywords.map((k) => k.trim()).filter((k) => k.length >= 3))].slice(
    0,
    options.maxKeywords ?? 6,
  );
  if (unique.length === 0) return [];
  const jobs = unique.flatMap((keyword) => engines.map((engine) => ({ keyword, engine })));
  const settled = await mapLimit(jobs, 3, async (job) => {
    if (budget.spent(0.97) || budget.left() < 1200) return null;
    try {
      return await fetchSerpQuery(job.engine, job.keyword, host, budget, depth, market, device);
    } catch {
      return {
        keyword: job.keyword,
        engine: job.engine,
        targetPosition: null,
        results: [],
        features: [],
        related: [],
        questions: [],
        depth: 0,
        difficulty: 0,
        market,
        device,
        status: "error" as SerpStatus,
        ms: 0,
      } satisfies SerpQuery;
    }
  });
  return settled.filter(
    (item): item is SerpQuery => item !== null && item.results.length + item.ms > 0,
  );
}

export function emptySerp(
  market: SerpMarket = DEFAULT_MARKET,
  device: SerpDevice = "desktop",
): SerpSnapshot {
  return {
    queries: [],
    visibility: 0,
    ranked: 0,
    top3: 0,
    top10: 0,
    avgPosition: 0,
    trafficScore: 0,
    engines: [],
    competitors: [],
    cannibalization: [],
    moves: [],
    engineHealth: [],
    market,
    device,
    related: [],
    questions: [],
    clusters: [],
    contentGaps: [],
    featured: [],
    buckets: [],
    consensus: [],
  };
}

export function snapshotFromQueries(
  queries: SerpQuery[],
  options: {
    linkingDomains?: Set<string>;
    moves?: RankMove[];
    brandTokens?: string[];
    targetText?: string;
  } = {},
): SerpSnapshot {
  const vis = visibilityScore(queries);
  const aggregates = serpAggregates(queries);
  const extras = collectSerpExtras(queries);
  return {
    queries,
    ...vis,
    ...aggregates,
    engines: [...new Set(queries.map((q) => q.engine))],
    competitors: buildSerpCompetitors(queries, { linkingDomains: options.linkingDomains }),
    cannibalization: detectCannibalization(queries),
    engineHealth: engineHealth(queries),
    moves: options.moves ?? [],
    market: queries[0]?.market ?? DEFAULT_MARKET,
    device: queries[0]?.device ?? "desktop",
    clusters: clusterKeywords(queries, { brandTokens: options.brandTokens }),
    contentGaps: options.targetText ? contentGapTerms(queries, options.targetText) : [],
    featured: featuredOpportunities(queries),
    buckets: positionBuckets(queries),
    consensus: engineConsensus(queries),
    ...extras,
  };
}

/**
 * Aggregates per-engine outcomes. If an engine blocked us, that fact belongs
 * in the report — a zero from a CAPTCHA is not a zero from the index.
 */
export function engineHealth(
  queries: SerpQuery[],
): { engine: SerpEngine; status: SerpStatus; queries: number; hits: number }[] {
  const acc = new Map<SerpEngine, { statuses: SerpStatus[]; queries: number; hits: number }>();
  for (const query of queries) {
    const current = acc.get(query.engine) ?? { statuses: [], queries: 0, hits: 0 };
    current.statuses.push(query.status);
    current.queries += 1;
    current.hits += query.results.length;
    acc.set(query.engine, current);
  }
  const severity: SerpStatus[] = [
    "blocked",
    "rate-limited",
    "parser-failed",
    "error",
    "empty-response",
    "not-configured",
    "no-results",
    "ok",
  ];
  return [...acc.entries()].map(([engine, value]) => ({
    engine,
    // The worst outcome wins: one block among ten queries still matters.
    status: severity.find((item) => value.statuses.includes(item)) ?? "ok",
    queries: value.queries,
    hits: value.hits,
  }));
}

/** A typical contact-page path — the starting point for outreach. */
function guessContactUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/kontakt`;
  } catch {
    return null;
  }
}

function prospectPriority(input: {
  reason: SerpProspect["reason"];
  domainScore: number;
  position: number | null;
}): number {
  let score = input.domainScore * 0.6;
  if (input.reason === "lost-link") score += 28; // the cheapest recovery
  else if (input.reason === "unlinked-mention") score += 22; // they already know the brand
  else score += 8;
  if (input.position !== null) score += Math.max(0, 12 - input.position);
  return Math.max(1, Math.min(100, Math.round(score)));
}

export function buildProspects(input: {
  host: string;
  queries: SerpQuery[];
  linkingDomains: Set<string>;
  mentions: {
    sourceUrl: string;
    sourceHost: string;
    sourceDomain: string;
    sourceTitle: string;
    snippet: string;
    linkOpportunity: boolean;
  }[];
  lost: {
    sourceUrl: string;
    sourceHost: string;
    sourceDomain: string;
    sourceTitle: string;
    lastSeen: string | null;
  }[];
}): SerpProspect[] {
  const out: SerpProspect[] = [];
  const seen = new Set<string>();

  const push = (item: Omit<SerpProspect, "priority" | "contactUrl">) => {
    const key = item.domain || item.host;
    if (!key || isTargetHost(item.host, input.host)) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      ...item,
      priority: prospectPriority(item),
      contactUrl: guessContactUrl(item.url),
    });
  };

  for (const query of input.queries) {
    for (const hit of query.results) {
      if (hit.isTarget) continue;
      if (input.linkingDomains.has(hit.domain)) continue;
      push({
        url: hit.url,
        host: hit.host,
        domain: hit.domain,
        title: hit.title,
        keyword: query.keyword,
        position: hit.position,
        engine: query.engine,
        reason: "serp-coranker",
        domainScore: hit.domainScore,
        snippet: hit.snippet || `Pozycja ${hit.position} na „${query.keyword}” (${query.engine})`,
      });
    }
  }

  for (const mention of input.mentions) {
    if (!mention.linkOpportunity) continue;
    if (input.linkingDomains.has(mention.sourceDomain)) continue;
    push({
      url: mention.sourceUrl,
      host: mention.sourceHost,
      domain: mention.sourceDomain,
      title: mention.sourceTitle,
      keyword: "",
      position: null,
      engine: null,
      reason: "unlinked-mention",
      domainScore: domainScore({ host: mention.sourceHost }),
      snippet: mention.snippet,
    });
  }

  for (const lost of input.lost) {
    push({
      url: lost.sourceUrl,
      host: lost.sourceHost,
      domain: lost.sourceDomain,
      title: lost.sourceTitle,
      keyword: "",
      position: null,
      engine: null,
      reason: "lost-link",
      domainScore: domainScore({ host: lost.sourceHost }),
      snippet: lost.lastSeen ? `Ostatnio widziany ${lost.lastSeen}` : "Link utracony",
    });
  }

  return out.sort((a, b) => b.priority - a.priority || b.domainScore - a.domainScore).slice(0, 80);
}

export function markSerpCorankers(items: Backlink[], queries: SerpQuery[]): Backlink[] {
  const corankers = new Set<string>();
  for (const query of queries) {
    for (const hit of query.results) {
      if (!hit.isTarget && hit.domain) corankers.add(hit.domain);
    }
  }
  return items.map((item) =>
    corankers.has(item.sourceDomain) && !item.flags.includes("serp-coranker")
      ? { ...item, flags: [...item.flags, "serp-coranker" as const] }
      : item,
  );
}

export type KeywordSerpOptions = {
  engines?: SerpEngine[];
  depth?: number;
  market?: SerpMarket;
  device?: SerpDevice;
  brandTokens?: string[];
  /** Earlier positions (from the database) used to compute gains and drops. */
  previous?: PositionRow[];
};

/** Manual keyword checking — the "check your own keywords" panel. */
export async function runKeywordSerp(
  rawHost: string,
  keywords: string[],
  options: KeywordSerpOptions = {},
): Promise<SerpCheckResult> {
  let host: string;
  try {
    host = parseTarget(rawHost).host;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid address." };
  }
  const unique = [...new Set(keywords.map((k) => k.trim()).filter((k) => k.length >= 2))].slice(0, 10);
  if (unique.length === 0) return { ok: false, error: "Enter at least one keyword." };

  const engines =
    options.engines && options.engines.length > 0
      ? options.engines.filter((engine) => ALL_ENGINES.includes(engine))
      : (["bing", "duckduckgo", "mojeek"] as SerpEngine[]);
  const depth = options.depth ?? 10;

  const budget = new Budget(depth > 10 || unique.length > 5 ? 30_000 : 18_000);
  const timedRun = await timed(() =>
    runSerpQueries(host, unique, budget, engines, {
      depth,
      maxKeywords: unique.length,
      market: options.market,
      device: options.device,
    }),
  );
  if (timedRun.error && !timedRun.value) {
    return { ok: false, error: timedRun.error };
  }
  const queries = timedRun.value ?? [];
  const seeds: KeywordSeed[] = unique.map((keyword) => ({
    keyword,
    source: "brand" as const,
    weight: 70,
  }));
  const emptyAnchors: AnchorStat[] = [];
  const stats = buildKeywordStats(seeds, queries, emptyAnchors, options.brandTokens);
  const moves = options.previous ? buildRankMoves(queries, options.previous) : [];
  return { ok: true, snapshot: snapshotFromQueries(queries, { moves }), keywords: stats };
}

export { pickSerpKeywords, classifyIntent };
