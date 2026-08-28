import { classifyIntent, keywordDifficulty } from "./serp-intel.ts";
import { tokenize } from "./topic.ts";
import type {
  ContentGapTerm,
  EngineConsensus,
  FeaturedOpportunity,
  KeywordCluster,
  PositionBucket,
  SerpEngine,
  SerpFeature,
  SerpQuery,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* Keyword clustering by SERP overlap                         */
/* ------------------------------------------------------------------ */

function normalizeUrlKey(url: string): string {
  return url.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
}

/** The set of top-10 URLs for a keyword (the strongest engine wins). */
function topUrls(queries: SerpQuery[], keyword: string, limit = 10): Set<string> {
  const out = new Set<string>();
  const related = queries
    .filter((query) => query.keyword === keyword)
    .sort((a, b) => b.results.length - a.results.length);
  for (const query of related) {
    for (const hit of query.results.slice(0, limit)) out.add(normalizeUrlKey(hit.url));
  }
  return out;
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const item of a) if (b.has(item)) count += 1;
  return count;
}

/**
 * Groups keywords the search engine answers with largely the same pages. That
 * is the most honest signal that one piece of content can serve several
 * queries — exactly how SERP-overlap clustering works in paid tools.
 *
 * `minShared` = how many shared top-10 URLs count as the same topic. Three is
 * the industry standard: fewer merges unrelated topics, more splits genuine
 * clusters.
 */
export function clusterKeywords(
  queries: SerpQuery[],
  options: { minShared?: number; brandTokens?: string[] } = {},
): KeywordCluster[] {
  const minShared = options.minShared ?? 3;
  const keywords = [...new Set(queries.map((query) => query.keyword))];
  if (keywords.length === 0) return [];

  const urls = new Map(keywords.map((keyword) => [keyword, topUrls(queries, keyword)]));
  const assigned = new Set<string>();
  const clusters: KeywordCluster[] = [];

  // Keywords with a richer SERP become cluster heads.
  const ordered = [...keywords].sort(
    (a, b) => (urls.get(b)?.size ?? 0) - (urls.get(a)?.size ?? 0) || a.length - b.length,
  );

  for (const head of ordered) {
    if (assigned.has(head)) continue;
    const headUrls = urls.get(head) ?? new Set<string>();
    const members = [head];
    let sharedPool = new Set(headUrls);

    for (const candidate of ordered) {
      if (candidate === head || assigned.has(candidate)) continue;
      const candidateUrls = urls.get(candidate) ?? new Set<string>();
      if (intersectionSize(headUrls, candidateUrls) < minShared) continue;
      members.push(candidate);
      sharedPool = new Set([...sharedPool].filter((url) => candidateUrls.has(url)));
    }

    for (const member of members) assigned.add(member);

    const clusterQueries = queries.filter((query) => members.includes(query.keyword));
    const difficulties = clusterQueries.map(
      (query) => query.difficulty || keywordDifficulty(query),
    );
    const positions = clusterQueries
      .map((query) => query.targetPosition)
      .filter((position): position is number => position !== null);

    const overlap = members.length > 1 ? sharedPool.size : headUrls.size;
    const strategy: KeywordCluster["strategy"] =
      members.length > 1 && overlap >= minShared ? "one-page" : "split";

    clusters.push({
      id: head.replace(/\s+/g, "-").slice(0, 60),
      head,
      keywords: members,
      sharedUrls: [...sharedPool].slice(0, 8),
      overlap,
      difficulty:
        difficulties.length > 0
          ? Math.round(difficulties.reduce((sum, value) => sum + value, 0) / difficulties.length)
          : 0,
      intent: classifyIntent(head, options.brandTokens ?? []),
      bestPosition: positions.length > 0 ? Math.min(...positions) : null,
      strategy,
      hint:
        members.length > 1
          ? `One page can serve ${members.length} keywords — the search engine answers them with ${overlap} of the same URLs.`
          : "A standalone topic — it needs its own page, since its SERP does not overlap with the other keywords.",
    });
  }

  return clusters.sort(
    (a, b) => b.keywords.length - a.keywords.length || a.difficulty - b.difficulty,
  );
}

/* ------------------------------------------------------------------ */
/* Content gaps against the ranking pages                              */
/* ------------------------------------------------------------------ */

const GENERIC = new Set([
  "strona",
  "www",
  "https",
  "http",
  "oferta",
  "kontakt",
  "home",
  "page",
  "the",
  "and",
  "for",
  "with",
  "you",
  "your",
]);

/**
 * Terms that recur in the titles and descriptions of top-ranking pages and are
 * absent from the target's content. This is the simplest honest version of a
 * "content gap": the vocabulary the search engine expects on this topic.
 */
export function contentGapTerms(
  queries: SerpQuery[],
  targetText: string,
  options: { limit?: number; minPages?: number } = {},
): ContentGapTerm[] {
  const own = new Set(tokenize(targetText));
  const counts = new Map<string, { pages: Set<string>; keywords: Set<string> }>();

  for (const query of queries) {
    for (const hit of query.results.slice(0, 10)) {
      if (hit.isTarget) continue;
      const terms = new Set(tokenize(`${hit.title} ${hit.snippet}`));
      for (const term of terms) {
        if (term.length < 4 || GENERIC.has(term)) continue;
        if (/^\d+$/.test(term)) continue;
        const entry = counts.get(term) ?? { pages: new Set<string>(), keywords: new Set<string>() };
        entry.pages.add(normalizeUrlKey(hit.url));
        entry.keywords.add(query.keyword);
        counts.set(term, entry);
      }
    }
  }

  const minPages = options.minPages ?? 3;
  const denominator = Math.max(1, new Set(queries.flatMap((q) => q.results.map((h) => normalizeUrlKey(h.url)))).size);

  return [...counts.entries()]
    .filter(([, entry]) => entry.pages.size >= minPages)
    .map(([term, entry]) => ({
      term,
      competitorPages: entry.pages.size,
      coverage: Math.round((entry.pages.size / denominator) * 100),
      onTarget: own.has(term),
      keywords: [...entry.keywords].slice(0, 4),
    }))
    .sort(
      (a, b) =>
        Number(a.onTarget) - Number(b.onTarget) || b.competitorPages - a.competitorPages,
    )
    .slice(0, options.limit ?? 40);
}

/* ------------------------------------------------------------------ */
/* Featured-snippet opportunities                                       */
/* ------------------------------------------------------------------ */

const FEATURE_HINT: Partial<Record<SerpFeature, string>> = {
  featured: "Add a concise 40–55 word answer directly under the heading — that is the format that wins a featured snippet.",
  paa: "Build an FAQ section from the questions in the SERP, with short answers marked up as FAQPage.",
  video: "The SERP shows video — a recording or embed improves the odds of a slot above the organic results.",
  images: "Image results are present — add your own photos with descriptive alt text and captions.",
};

/**
 * Keywords where the target already sits near the top and the SERP has an
 * element to take. These are the cheapest visibility gains: the content already
 * ranks, it only lacks
 * tylko formatu odpowiedzi.
 */
export function featuredOpportunities(queries: SerpQuery[]): FeaturedOpportunity[] {
  const out: FeaturedOpportunity[] = [];
  for (const query of queries) {
    const position = query.targetPosition;
    if (position === null || position > 10) continue;
    for (const feature of query.features) {
      if (!FEATURE_HINT[feature]) continue;
      out.push({
        keyword: query.keyword,
        engine: query.engine,
        position,
        feature,
        questions: query.questions.slice(0, 4),
        hint: FEATURE_HINT[feature] ?? "",
      });
    }
  }
  return out
    .sort((a, b) => a.position - b.position)
    .filter(
      (item, index, list) =>
        list.findIndex((other) => other.keyword === item.keyword && other.feature === item.feature) ===
        index,
    )
    .slice(0, 20);
}

/* ------------------------------------------------------------------ */
/* Position distribution and engine agreement                                 */
/* ------------------------------------------------------------------ */

/** How many keywords sit in the top 3, top 10, second ten, and outside. */
export function positionBuckets(queries: SerpQuery[]): PositionBucket[] {
  const best = new Map<string, number | null>();
  for (const query of queries) {
    const current = best.get(query.keyword);
    if (current === undefined || (query.targetPosition !== null && (current === null || query.targetPosition < current))) {
      best.set(query.keyword, query.targetPosition);
    }
  }
  const total = Math.max(1, best.size);
  const counters = { top3: 0, top10: 0, top20: 0, out: 0 };
  for (const position of best.values()) {
    if (position === null) counters.out += 1;
    else if (position <= 3) counters.top3 += 1;
    else if (position <= 10) counters.top10 += 1;
    else counters.top20 += 1;
  }
  const rows: [string, number][] = [
    ["TOP 3", counters.top3],
    ["4–10", counters.top10],
    ["11–20", counters.top20],
    ["poza zakresem", counters.out],
  ];
  return rows.map(([label, count]) => ({
    label,
    count,
    share: Math.round((count / total) * 100),
  }));
}

/**
 * Divergence of positions between engines. A wide spread means one engine has
 * not digested recent changes yet — or that the result is incidental.
 */
export function engineConsensus(queries: SerpQuery[]): EngineConsensus[] {
  const byKeyword = new Map<string, { engine: SerpEngine; position: number | null }[]>();
  for (const query of queries) {
    const list = byKeyword.get(query.keyword) ?? [];
    list.push({ engine: query.engine, position: query.targetPosition });
    byKeyword.set(query.keyword, list);
  }
  const out: EngineConsensus[] = [];
  for (const [keyword, positions] of byKeyword) {
    if (positions.length < 2) continue;
    const found = positions
      .map((item) => item.position)
      .filter((position): position is number => position !== null);
    const spread = found.length >= 2 ? Math.max(...found) - Math.min(...found) : 0;
    const missing = positions.length - found.length;
    out.push({
      keyword,
      positions,
      spread,
      stable: spread <= 3 && missing === 0,
    });
  }
  return out.sort((a, b) => b.spread - a.spread);
}
