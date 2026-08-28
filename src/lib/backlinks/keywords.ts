import { tokenize } from "./topic.ts";
import { adjustedCtr, classifyIntent, keywordDifficulty } from "./serp-intel.ts";
import type {
  AnchorStat,
  KeywordSource,
  KeywordStat,
  SerpEngine,
  SerpQuery,
} from "./types.ts";

export type KeywordSeed = {
  keyword: string;
  source: KeywordSource;
  weight: number;
};

const PHRASE_STOP = new Set([
  "strona glowna",
  "home page",
  "official website",
  "skip to",
  "cookie",
  "privacy policy",
  "polityka prywatnosci",
  "all rights reserved",
]);

function cleanPhrase(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[|–—•·].*$/, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function isUsefulPhrase(phrase: string): boolean {
  if (phrase.length < 4 || phrase.length > 60) return false;
  if (PHRASE_STOP.has(phrase)) return false;
  const words = phrase.split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;
  if (words.every((w) => w.length <= 2)) return false;
  return true;
}

function pushSeed(out: KeywordSeed[], keyword: string, source: KeywordSource, weight: number) {
  const phrase = cleanPhrase(keyword);
  if (!isUsefulPhrase(phrase)) return;
  const existing = out.find((item) => item.keyword === phrase);
  if (existing) {
    existing.weight = Math.max(existing.weight, weight);
    return;
  }
  out.push({ keyword: phrase, source, weight });
}

/**
 * Collects the keywords a page *should* rank for: title, H1, meta description,
 * the most frequent content n-grams, and exact-match anchors (a signal of what
 * someone already links for).
 */
export function collectKeywords(input: {
  title?: string | null;
  description?: string | null;
  h1?: string[];
  h2?: string[];
  brandTokens?: string[];
  content?: string;
  anchors?: AnchorStat[];
}): KeywordSeed[] {
  const out: KeywordSeed[] = [];

  for (const token of input.brandTokens ?? []) {
    pushSeed(out, token, "brand", 90);
  }
  if (input.title) {
    pushSeed(out, input.title, "title", 88);
    const head = input.title.split(/\s*[|\-–—•·]\s*/)[0];
    if (head && head !== input.title) pushSeed(out, head, "title", 84);
  }
  for (const h of input.h1 ?? []) pushSeed(out, h, "h1", 78);
  for (const h of (input.h2 ?? []).slice(0, 4)) pushSeed(out, h, "h1", 52);
  if (input.description) {
    const first = input.description.split(/[.!?]/)[0];
    if (first) pushSeed(out, first, "meta", 48);
  }

  const tokens = tokenize(input.content ?? "");
  const bigrams = new Map<string, number>();
  for (let i = 0; i < tokens.length - 1 && i < 400; i++) {
    const pair = `${tokens[i]} ${tokens[i + 1]}`;
    bigrams.set(pair, (bigrams.get(pair) ?? 0) + 1);
  }
  [...bigrams.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .forEach(([phrase, count]) => pushSeed(out, phrase, "content", 30 + Math.min(20, count * 4)));

  for (const anchor of (input.anchors ?? []).filter((a) => a.type === "exact-match" || a.type === "long-tail")) {
    pushSeed(out, anchor.text, "anchor", 40 + Math.min(30, anchor.domains * 6));
  }

  return out.sort((a, b) => b.weight - a.weight).slice(0, 16);
}

export function pickSerpKeywords(seeds: KeywordSeed[], limit = 5): string[] {
  const out: string[] = [];
  for (const seed of seeds) {
    if (out.length >= limit) break;
    if (out.some((k) => k === seed.keyword || k.includes(seed.keyword) || seed.keyword.includes(k))) {
      continue;
    }
    out.push(seed.keyword);
  }
  return out;
}

export function visibilityScore(queries: SerpQuery[]): {
  visibility: number;
  ranked: number;
  top3: number;
  top10: number;
  /** Keywords with at least one successful measurement (ok / empty). */
  measured: number;
  /** Keywords where every engine attempt was blocked / errored / parser-failed. */
  unmeasured: number;
} {
  // measured = ranked or confirmed not-in-top-N; unmeasured must not dilute visibility.
  type Agg = { best: number | null; measured: boolean };
  const byKeyword = new Map<string, Agg>();

  for (const query of queries) {
    const failed =
      query.status === "blocked" ||
      query.status === "rate-limited" ||
      query.status === "parser-failed" ||
      query.status === "not-configured" ||
      query.status === "empty-response" ||
      query.status === "error";
    const current = byKeyword.get(query.keyword) ?? { best: null, measured: false };
    if (!failed) {
      current.measured = true;
      if (query.targetPosition !== null) {
        if (current.best === null || query.targetPosition < current.best) {
          current.best = query.targetPosition;
        }
      }
    }
    byKeyword.set(query.keyword, current);
  }

  let ranked = 0;
  let top3 = 0;
  let top10 = 0;
  let points = 0;
  let measured = 0;
  let unmeasured = 0;
  for (const agg of byKeyword.values()) {
    if (!agg.measured) {
      unmeasured += 1;
      continue;
    }
    measured += 1;
    if (agg.best === null) continue;
    ranked += 1;
    if (agg.best <= 3) top3 += 1;
    if (agg.best <= 10) top10 += 1;
    points += Math.round((11 - agg.best) * (100 / 10));
  }
  const denominator = Math.max(1, measured);
  return {
    visibility: measured === 0 ? 0 : Math.max(0, Math.min(100, Math.round(points / denominator))),
    ranked,
    top3,
    top10,
    measured,
    unmeasured,
  };
}

export function buildKeywordStats(
  seeds: KeywordSeed[],
  queries: SerpQuery[],
  anchors: AnchorStat[],
  brandTokens: string[] = [],
): KeywordStat[] {
  return seeds.slice(0, 16).map((seed) => {
    const related = queries.filter((q) => q.keyword === seed.keyword);
    const engines: { engine: SerpEngine; position: number | null }[] = [];
    for (const engine of ["bing", "duckduckgo", "mojeek", "brave"] as const) {
      const hit = related.find((q) => q.engine === engine);
      if (hit) engines.push({ engine, position: hit.targetPosition });
    }
    const positions = engines.map((e) => e.position).filter((p): p is number => p !== null);
    const bestPosition = positions.length > 0 ? Math.min(...positions) : null;

    const matching = anchors.filter((a) => {
      const t = a.text.toLowerCase();
      return t.includes(seed.keyword) || seed.keyword.includes(cleanPhrase(a.text));
    });
    const matchingAnchors = matching.reduce((sum, a) => sum + a.count, 0);
    const linkEquity = matching.reduce((sum, a) => sum + a.domains * 12 + a.count * 4, 0);

    let opportunity = 20;
    if (bestPosition === null) opportunity += 35;
    else if (bestPosition > 3) opportunity += Math.round((bestPosition - 1) * 4);
    opportunity += Math.min(25, Math.round(linkEquity / 8));
    opportunity += Math.min(15, Math.round(seed.weight / 8));
    if (bestPosition === 1) opportunity = Math.min(opportunity, 18);

    // Difficulty is taken from the richest SERP we managed to fetch.
    const richest = related
      .slice()
      .sort((a, b) => b.results.length - a.results.length)[0];
    const difficulty = richest ? (richest.difficulty || keywordDifficulty(richest)) : 0;
    const trafficShare = richest ? adjustedCtr(bestPosition, richest.features) : 0;

    // An easy keyword with existing links is a real opportunity; a hard one less so.
    if (difficulty > 0) opportunity += Math.round((60 - difficulty) / 4);

    return {
      keyword: seed.keyword,
      source: seed.source,
      weight: seed.weight,
      bestPosition,
      engines,
      linkEquity: Math.min(100, linkEquity),
      matchingAnchors,
      difficulty,
      trafficShare,
      intent: classifyIntent(seed.keyword, brandTokens),
      opportunity: Math.max(0, Math.min(100, opportunity)),
    };
  });
}
