import { isTargetHost, registrableDomain, stripWww } from "./parse.ts";
import type { BrandSerp, BrandSerpResult, SerpQuery } from "./types.ts";

const PROFILE = /(facebook|linkedin|instagram|twitter|^x\.com|youtube|tiktok|pinterest|crunchbase|github|behance|goldenline)/i;
const REVIEW = /(opinie|opinions|reviews?|trustpilot|ceneo|google\.com\/maps|gowork|glassdoor|yelp|tripadvisor)/i;
const DIRECTORY = /(katalog|panorama|firmy|baza|aleo|rejestr|krs|bizin|yellowpages|directory|listing)/i;
const MEDIA = /(gazeta|onet|wp\.pl|interia|forbes|businessinsider|rp\.pl|money|news|press|dziennik)/i;

/** Signals of content that may damage reputation on the brand SERP. */
const NEGATIVE =
  /\b(oszust\w*|scam|fraud|pozew|sąd|sad |upadłość|upadlosc|skarga|reklamacj\w*|uwaga na|nie polecam|opinie negatywne|alert|ostrzeżeni\w*|ostrzezeni\w*)\b/i;

function classifyKind(domain: string, title: string): BrandSerpResult["kind"] {
  const blob = `${domain} ${title}`;
  if (PROFILE.test(domain)) return "profile";
  if (REVIEW.test(blob)) return "reviews";
  if (DIRECTORY.test(blob)) return "directory";
  if (MEDIA.test(blob)) return "media";
  return "other";
}

/**
 * An audit of the first ten results for the brand name. This is the SERP a
 * customer sees after a recommendation — unlike generic keywords, the goal here
 * is not traffic but control over what is visible.
 *
 * "Controlled" means results from the target's own domain plus its own social
 * profiles, provided the title contains the brand name.
 */
export function buildBrandSerp(
  queries: SerpQuery[],
  options: { host: string; brandTokens: string[]; competitors?: Set<string> },
): BrandSerp | null {
  const brand = options.brandTokens
    .map((token) => token.toLowerCase().trim())
    .filter((token) => token.length >= 3);
  if (brand.length === 0) return null;

  // Take the query closest to the brand name with the richest SERP.
  const candidates = queries
    .filter((query) => brand.some((token) => query.keyword.toLowerCase().includes(token)))
    .sort((a, b) => b.results.length - a.results.length);
  const query = candidates[0];
  if (!query || query.results.length === 0) return null;

  const results: BrandSerpResult[] = query.results.slice(0, 10).map((hit) => {
    const domain = registrableDomain(stripWww(hit.host));
    const mentionsBrand = brand.some((token) => hit.title.toLowerCase().includes(token));
    const kind = classifyKind(domain, hit.title);
    const owned =
      hit.isTarget ||
      isTargetHost(hit.host, options.host) ||
      (kind === "profile" && mentionsBrand);
    return {
      url: hit.url,
      domain,
      title: hit.title,
      position: hit.position,
      owned,
      kind: !owned && options.competitors?.has(domain) ? "competitor" : kind,
      risky: !owned && (NEGATIVE.test(hit.title) || NEGATIVE.test(hit.snippet)),
    };
  });

  const owned = results.filter((row) => row.owned).length;
  const risky = results.filter((row) => row.risky).length;
  // Higher positions weigh more — the first result shapes the first impression.
  const weighted = results.reduce(
    (sum, row) => sum + (row.owned ? 11 - row.position : 0),
    0,
  );
  const maxWeighted = results.reduce((sum, row) => sum + (11 - row.position), 0) || 1;
  const control = Math.round((weighted / maxWeighted) * 100);

  let hint: string;
  if (risky > 0) {
    hint = `Your brand SERP contains ${risky} results with negative sentiment. Build and rank your own pages (profiles, press material) to push them below the first ten.`;
  } else if (control >= 60) {
    hint = "You control most of the first ten results for your own brand — that is a good position.";
  } else if (owned <= 2) {
    hint =
      "Beyond the home page almost nothing here is yours. Fill in social profiles and business listings to take more slots.";
  } else {
    hint = "Some results belong to third parties — adding your own pages and profiles is worthwhile.";
  }

  return {
    keyword: query.keyword,
    engine: query.engine,
    control,
    owned,
    thirdParty: results.length - owned,
    risky,
    results,
    hint,
  };
}
