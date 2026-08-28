import { Budget, API_UA, BROWSER_UA, fetchJson, fetchText, mapLimit } from "./net.server.ts";
import { classifyIntent } from "./serp-intel.ts";
import { parsePeopleAlsoAsk, parseRelatedSearches } from "./serp.ts";
import type { KeywordIdea, SuggestResult } from "./types.ts";

/** Modifiers that turn a head keyword into long tail with clear intent. */
const MODIFIERS = [
  "cena",
  "opinie",
  "najlepszy",
  "ranking",
  "jak",
  "co to jest",
  "dla firm",
  "online",
  "comparison",
  "alternatywa",
];

const PREFIX = ["jak ", "co to ", "czy ", "ile kosztuje ", "gdzie "];

function cleanIdea(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s"'“”„-]+|[\s"'“”„-]+$/g, "")
    .slice(0, 80);
}

/**
 * Podpowiedzi DuckDuckGo — publiczny endpoint JSON, bez klucza i limitu
 * registration. Returns phrases people actually type.
 */
async function ddgAutocomplete(seed: string, signal?: AbortSignal): Promise<string[]> {
  const url = `https://duckduckgo.com/ac/?q=${encodeURIComponent(seed)}&type=list`;
  const data = await fetchJson<unknown>(url, 5000, API_UA, signal);
  const out: string[] = [];
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === "string") out.push(item);
      else if (item && typeof item === "object" && "phrase" in item) {
        const phrase = (item as { phrase?: unknown }).phrase;
        if (typeof phrase === "string") out.push(phrase);
      } else if (Array.isArray(item)) {
        for (const nested of item) if (typeof nested === "string") out.push(nested);
      }
    }
  }
  return out;
}

/** Bing autocomplete (OpenSearch JSON) — a second independent source. */
async function bingAutocomplete(seed: string, signal?: AbortSignal): Promise<string[]> {
  const url = `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(seed)}`;
  const data = await fetchJson<unknown>(url, 5000, API_UA, signal);
  if (!Array.isArray(data) || !Array.isArray(data[1])) return [];
  return (data[1] as unknown[]).filter((item): item is string => typeof item === "string");
}

/** Related searches and questions taken straight from Bing's HTML. */
async function serpExtras(
  seed: string,
  signal?: AbortSignal,
): Promise<{ related: string[]; questions: string[] }> {
  try {
    const { text } = await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(seed)}`, {
      timeoutMs: 7000,
      maxBytes: 300_000,
      ua: BROWSER_UA,
      signal,
    });
    return {
      related: parseRelatedSearches(text, "bing"),
      questions: parsePeopleAlsoAsk(text),
    };
  } catch {
    return { related: [], questions: [] };
  }
}

type Acc = { keyword: string; sources: Set<KeywordIdea["source"]>; seed: string };

function push(acc: Map<string, Acc>, raw: string, source: KeywordIdea["source"], seed: string) {
  const keyword = cleanIdea(raw);
  if (keyword.length < 4 || keyword.length > 70) return;
  if (/^https?:/i.test(keyword)) return;
  const current = acc.get(keyword);
  if (current) {
    current.sources.add(source);
    return;
  }
  acc.set(keyword, { keyword, sources: new Set([source]), seed });
}

function ideaScore(item: Acc, brandTokens: string[]): number {
  const words = item.keyword.split(/\s+/).filter(Boolean).length;
  let score = 34;
  // A keyword confirmed by several sources is genuinely being searched.
  score += (item.sources.size - 1) * 14;
  if (item.sources.has("autocomplete")) score += 16;
  if (item.sources.has("related")) score += 10;
  if (item.sources.has("question")) score += 8;
  // Long tail: easier to rank for, converts better.
  if (words >= 3 && words <= 6) score += 12;
  if (words === 2) score += 4;
  if (words > 7) score -= 10;
  const intent = classifyIntent(item.keyword, brandTokens);
  if (intent === "transactional") score += 14;
  else if (intent === "commercial") score += 9;
  else if (intent === "local") score += 6;
  else if (intent === "brand") score -= 6;
  return Math.max(1, Math.min(100, Math.round(score)));
}

/**
 * Builds a keyword idea list from three free sources: DuckDuckGo and Bing
 * autocomplete, related searches, and SERP questions. Each seed
 * rozszerzamy jeszcze o modyfikatory intencji (cena, opinie, jak…).
 */
export async function suggestKeywords(
  seeds: string[],
  options: { brandTokens?: string[]; limit?: number; budgetMs?: number } = {},
): Promise<SuggestResult> {
  const clean = [...new Set(seeds.map((s) => cleanIdea(s)).filter((s) => s.length >= 2))].slice(0, 5);
  if (clean.length === 0) return { ok: false, error: "Enter at least one seed keyword." };

  const started = Date.now();
  const budget = new Budget(options.budgetMs ?? 16_000);
  const acc = new Map<string, Acc>();
  const brandTokens = options.brandTokens ?? [];

  // Layer 1: plain suggestions for the seed phrases.
  await mapLimit(clean, 3, async (seed) => {
    if (budget.spent(0.9)) return null;
    const [ddg, bing] = await Promise.all([
      ddgAutocomplete(seed, budget.signal).catch(() => []),
      bingAutocomplete(seed, budget.signal).catch(() => []),
    ]);
    for (const item of [...ddg, ...bing]) push(acc, item, "autocomplete", seed);
    return null;
  });

  // Warstwa 2: modyfikatory intencji — „fraza + cena”, „jak + fraza”.
  const expansions = clean.flatMap((seed) => [
    ...MODIFIERS.slice(0, 6).map((mod) => ({ seed, query: `${seed} ${mod}` })),
    ...PREFIX.slice(0, 3).map((pre) => ({ seed, query: `${pre}${seed}` })),
  ]);
  await mapLimit(expansions.slice(0, 18), 4, async (item) => {
    if (budget.spent(0.82) || budget.left() < 1500) return null;
    const list = await ddgAutocomplete(item.query, budget.signal).catch(() => []);
    if (list.length === 0) push(acc, item.query, "modifier", item.seed);
    for (const phrase of list.slice(0, 6)) push(acc, phrase, "modifier", item.seed);
    return null;
  });

  // Layer 3: related searches and questions from a real SERP.
  await mapLimit(clean.slice(0, 3), 2, async (seed) => {
    if (budget.spent(0.94)) return null;
    const extras = await serpExtras(seed, budget.signal);
    for (const item of extras.related) push(acc, item, "related", seed);
    for (const item of extras.questions) push(acc, item, "question", seed);
    return null;
  });

  const ideas: KeywordIdea[] = [...acc.values()]
    .filter((item) => !clean.includes(item.keyword))
    .map((item) => ({
      keyword: item.keyword,
      source: (item.sources.has("autocomplete")
        ? "autocomplete"
        : item.sources.has("related")
          ? "related"
          : item.sources.has("question")
            ? "question"
            : "modifier") as KeywordIdea["source"],
      seed: item.seed,
      score: ideaScore(item, brandTokens),
      intent: classifyIntent(item.keyword, brandTokens),
      words: item.keyword.split(/\s+/).filter(Boolean).length,
    }))
    .sort((a, b) => b.score - a.score || a.words - b.words)
    .slice(0, options.limit ?? 60);

  if (ideas.length === 0) {
    return { ok: false, error: "The search engines returned no suggestions for these keywords." };
  }
  return { ok: true, ideas, seeds: clean, ms: Date.now() - started };
}
