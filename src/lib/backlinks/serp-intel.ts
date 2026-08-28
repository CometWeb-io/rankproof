import { registrableDomain, stripWww } from "./parse.ts";
import type {
  Cannibalization,
  KeywordIntent,
  RankMove,
  SerpCompetitor,
  SerpFeature,
  SerpHit,
  SerpQuery,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* CTR i szacowany ruch                                                */
/* ------------------------------------------------------------------ */

/**
 * An averaged CTR curve for organic positions 1–20 (as percentages).
 * Source: public SERP click-through studies — good enough as a proxy,
 * because we care about the ordering of opportunities, not absolute traffic.
 */
const CTR_CURVE = [
  27.6, 15.8, 11.0, 8.4, 6.3, 4.9, 3.9, 3.3, 2.7, 2.4, 1.8, 1.6, 1.4, 1.2, 1.1, 1.0, 0.9, 0.8, 0.7,
  0.6,
];

export function positionCtr(position: number | null): number {
  if (position === null || position < 1) return 0;
  return CTR_CURVE[position - 1] ?? 0.4;
}

/** SERP elements that take clicks away from the organic results. */
const CTR_PENALTY: Partial<Record<SerpFeature, number>> = {
  featured: 0.75,
  paa: 0.9,
  ads: 0.85,
  shopping: 0.85,
  knowledge: 0.9,
  local: 0.85,
  video: 0.95,
};

/** CTR pozycji skorygowany o to, co jeszcze siedzi na tym SERP-ie. */
export function adjustedCtr(position: number | null, features: SerpFeature[]): number {
  let ctr = positionCtr(position);
  for (const feature of features) ctr *= CTR_PENALTY[feature] ?? 1;
  return Math.round(ctr * 10) / 10;
}

/* ------------------------------------------------------------------ */
/* Keyword difficulty                                                      */
/* ------------------------------------------------------------------ */

/**
 * Open Difficulty / SERP Competition Estimate (0–100).
 * Heuristic from scraped competitor `domainScore` + SERP features — not
 * Semrush/Ahrefs KD. Prefer this label in UI over "Keyword Difficulty".
 */
export function keywordDifficulty(query: Pick<SerpQuery, "results" | "features" | "keyword">): number {
  const top = query.results.filter((hit) => !hit.isTarget).slice(0, 10);
  if (top.length === 0) return 20;
  const weights = top.map((hit, index) => ({
    score: hit.domainScore,
    weight: 1 / (index + 1),
  }));
  const totalWeight = weights.reduce((sum, item) => sum + item.weight, 0);
  const weighted = weights.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight;

  let difficulty = weighted * 0.9;
  const words = query.keyword.trim().split(/\s+/).length;
  if (words >= 4) difficulty -= 12;
  else if (words === 3) difficulty -= 6;
  else if (words === 1) difficulty += 6;

  if (query.features.includes("featured")) difficulty += 5;
  if (query.features.includes("ads")) difficulty += 4;
  if (query.features.includes("shopping")) difficulty += 3;
  if (query.features.includes("discussions")) difficulty -= 4;

  return Math.max(1, Math.min(100, Math.round(difficulty)));
}

/** Alias: honest product name for `keywordDifficulty`. */
export const serpCompetitionEstimate = keywordDifficulty;

/* ------------------------------------------------------------------ */
/* Intencja                                                            */
/* ------------------------------------------------------------------ */

// Intent patterns cover English and Polish; add your market's phrasing here.
const TRANSACTIONAL = /\b(kup|kupno|zamow|zamów|cena|ceny|cennik|sklep|promocja|tanio|rabat|buy|price|pricing|order|shop|deal|discount|za darmo|free trial)\b/i;
const COMMERCIAL = /\b(najlepsz\w*|ranking|porownanie|porównanie|opinie|recenzja|test|alternatyw\w*|vs|best|top \d+|review|compare|alternative)\b/i;
const INFORMATIONAL = /\b(jak|co to|czym jest|dlaczego|poradnik|instrukcja|przyklad|przykład|definicja|how|what|why|guide|tutorial|examples?)\b/i;
const LOCAL = /\b(w |we |near me|niedaleko|w poblizu|w pobliżu|warszaw\w*|krakow\w*|kraków\w*|wroclaw\w*|wrocław\w*|poznan\w*|poznań\w*|gdansk\w*|gdańsk\w*|lodz\w*|łódź\w*|katowic\w*)\b/i;

/** Identifies keyword intent — brand wins over everything else. */
export function classifyIntent(keyword: string, brandTokens: string[] = []): KeywordIntent {
  const value = keyword.toLowerCase();
  for (const token of brandTokens) {
    const brand = token.toLowerCase().trim();
    if (brand.length >= 3 && value.includes(brand)) return "brand";
  }
  if (TRANSACTIONAL.test(value)) return "transactional";
  if (COMMERCIAL.test(value)) return "commercial";
  if (LOCAL.test(value)) return "local";
  if (INFORMATIONAL.test(value) || value.includes("?")) return "informational";
  if (value.split(/\s+/).length <= 2) return "navigational";
  return "informational";
}

/* ------------------------------------------------------------------ */
/* Konkurenci w SERP-ie                                                */
/* ------------------------------------------------------------------ */

type CompetitorAcc = {
  domain: string;
  host: string;
  appearances: number;
  keywords: Set<string>;
  positions: number[];
  voice: number;
  domainScore: number;
  sampleUrl: string;
  sampleKeyword: string;
};

/**
 * Domains ranking for the same keywords as the target — the real competition
 * in search, not the one from a board deck. Share of voice is computed from
 * adjusted CTR, so first position weighs many times more than tenth.
 */
export function buildSerpCompetitors(
  queries: SerpQuery[],
  options: { linkingDomains?: Set<string>; limit?: number } = {},
): SerpCompetitor[] {
  const acc = new Map<string, CompetitorAcc>();
  const keywordCount = new Set(queries.map((q) => q.keyword)).size || 1;
  let totalVoice = 0;

  for (const query of queries) {
    for (const hit of query.results) {
      if (hit.isTarget || !hit.domain) continue;
      const voice = adjustedCtr(hit.position, query.features);
      totalVoice += voice;
      const current = acc.get(hit.domain);
      if (current) {
        const best = Math.min(...current.positions);
        current.appearances += 1;
        current.keywords.add(query.keyword);
        current.voice += voice;
        if (hit.position < best) {
          current.sampleUrl = hit.url;
          current.sampleKeyword = query.keyword;
        }
        current.positions.push(hit.position);
        continue;
      }
      acc.set(hit.domain, {
        domain: hit.domain,
        host: hit.host,
        appearances: 1,
        keywords: new Set([query.keyword]),
        positions: [hit.position],
        voice,
        domainScore: hit.domainScore,
        sampleUrl: hit.url,
        sampleKeyword: query.keyword,
      });
    }
  }

  const targetVoice = queries.reduce((sum, query) => {
    const hit = query.results.find((item) => item.isTarget);
    return sum + (hit ? adjustedCtr(hit.position, query.features) : 0);
  }, 0);
  const denominator = Math.max(1, totalVoice + targetVoice);

  return [...acc.values()]
    .map((item) => ({
      domain: item.domain,
      host: item.host,
      appearances: item.appearances,
      keywords: item.keywords.size,
      bestPosition: Math.min(...item.positions),
      avgPosition:
        Math.round((item.positions.reduce((s, p) => s + p, 0) / item.positions.length) * 10) / 10,
      shareOfVoice: Math.round((item.voice / denominator) * 1000) / 10,
      overlap: Math.round((item.keywords.size / keywordCount) * 100),
      domainScore: item.domainScore,
      sampleUrl: item.sampleUrl,
      sampleKeyword: item.sampleKeyword,
      linksToTarget: options.linkingDomains?.has(item.domain) ?? false,
    }))
    .sort(
      (a, b) =>
        b.shareOfVoice - a.shareOfVoice || b.keywords - a.keywords || a.avgPosition - b.avgPosition,
    )
    .slice(0, options.limit ?? 25);
}

/* ------------------------------------------------------------------ */
/* Search-intent overlap                                               */
/* ------------------------------------------------------------------ */

/**
 * Two different URLs from the same site on one keyword. The search engine does
 * not know which to promote — and usually demotes both.
 */
export function detectCannibalization(queries: SerpQuery[]): Cannibalization[] {
  const out: Cannibalization[] = [];
  for (const query of queries) {
    const own = query.results.filter((hit) => hit.isTarget);
    const unique = new Map<string, SerpHit>();
    for (const hit of own) {
      const key = hit.url.replace(/[?#].*$/, "").replace(/\/$/, "");
      if (!unique.has(key)) unique.set(key, hit);
    }
    if (unique.size < 2) continue;
    out.push({
      keyword: query.keyword,
      engine: query.engine,
      urls: [...unique.values()]
        .map((hit) => ({ url: hit.url, position: hit.position }))
        .sort((a, b) => a.position - b.position),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Position changes between scans                                       */
/* ------------------------------------------------------------------ */

export type PositionRow = { keyword: string; engine: string; position: number | null };

/** Compares current positions against stored ones — gains and drops. */
export function buildRankMoves(queries: SerpQuery[], previous: PositionRow[]): RankMove[] {
  const before = new Map<string, number | null>();
  for (const row of previous) {
    before.set(`${row.engine}|${row.keyword}`, row.position);
  }
  const out: RankMove[] = [];
  const seen = new Set<string>();

  for (const query of queries) {
    const key = `${query.engine}|${query.keyword}`;
    seen.add(key);
    if (!before.has(key)) {
      if (query.targetPosition === null) continue;
      out.push({
        keyword: query.keyword,
        engine: query.engine,
        previous: null,
        current: query.targetPosition,
        change: null,
        state: "new",
      });
      continue;
    }
    const prev = before.get(key) ?? null;
    const current = query.targetPosition;
    if (prev === null && current === null) continue;
    if (prev === null) {
      out.push({
        keyword: query.keyword,
        engine: query.engine,
        previous: null,
        current,
        change: null,
        state: "new",
      });
      continue;
    }
    if (current === null) {
      out.push({
        keyword: query.keyword,
        engine: query.engine,
        previous: prev,
        current: null,
        change: null,
        state: "lost",
      });
      continue;
    }
    const change = prev - current;
    out.push({
      keyword: query.keyword,
      engine: query.engine,
      previous: prev,
      current,
      change,
      state: change > 0 ? "up" : change < 0 ? "down" : "stable",
    });
  }

  for (const [key, position] of before) {
    if (seen.has(key) || position === null) continue;
    const [engine, ...rest] = key.split("|");
    out.push({
      keyword: rest.join("|"),
      engine: (engine ?? "bing") as RankMove["engine"],
      previous: position,
      current: null,
      change: null,
      state: "lost",
    });
  }

  const rank = (state: RankMove["state"]) =>
    state === "lost" ? 0 : state === "down" ? 1 : state === "up" ? 2 : state === "new" ? 3 : 4;
  return out.sort((a, b) => rank(a.state) - rank(b.state) || Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0));
}

/* ------------------------------------------------------------------ */
/* Agregaty                                                            */
/* ------------------------------------------------------------------ */

/** Average position and modelled traffic across a set of queries. */
export function serpAggregates(queries: SerpQuery[]): {
  avgPosition: number;
  trafficScore: number;
} {
  const best = new Map<string, { position: number; features: SerpFeature[] }>();
  for (const query of queries) {
    if (query.targetPosition === null) continue;
    const current = best.get(query.keyword);
    if (!current || query.targetPosition < current.position) {
      best.set(query.keyword, { position: query.targetPosition, features: query.features });
    }
  }
  if (best.size === 0) return { avgPosition: 0, trafficScore: 0 };
  const positions = [...best.values()].map((item) => item.position);
  const traffic = [...best.values()].reduce(
    (sum, item) => sum + adjustedCtr(item.position, item.features),
    0,
  );
  return {
    avgPosition: Math.round((positions.reduce((s, p) => s + p, 0) / positions.length) * 10) / 10,
    trafficScore: Math.round(traffic * 10) / 10,
  };
}

/** Collects unique related searches and questions across all SERPs. */
export function collectSerpExtras(queries: SerpQuery[]): { related: string[]; questions: string[] } {
  const related = new Set<string>();
  const questions = new Set<string>();
  for (const query of queries) {
    for (const item of query.related) related.add(item);
    for (const item of query.questions) questions.add(item);
  }
  return {
    related: [...related].slice(0, 30),
    questions: [...questions].slice(0, 20),
  };
}

/** Domain from a host — used when building competitor lists outside the SERP. */
export function domainOf(host: string): string {
  return registrableDomain(stripWww(host));
}
