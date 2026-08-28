import type { SerpEngine, SerpMarket, SerpDevice } from "./types.ts";

/**
 * Market parameters for each search engine. Without them every measurement runs
 * z serwera aplikacji, czyli z przypadkowego kraju — a pozycje w Polsce i w
 * the United States can differ by several places. This is the most common cause
 * of strange readings in free rank-tracking tools.
 */
export const MARKETS: Record<
  SerpMarket,
  { label: string; bing: string; ddg: string; language: string; country: string }
> = {
  pl: { label: "Poland", bing: "pl-PL", ddg: "pl-pl", language: "pl", country: "PL" },
  us: { label: "USA", bing: "en-US", ddg: "us-en", language: "en", country: "US" },
  gb: { label: "United Kingdom", bing: "en-GB", ddg: "uk-en", language: "en", country: "GB" },
  de: { label: "Germany", bing: "de-DE", ddg: "de-de", language: "de", country: "DE" },
  fr: { label: "France", bing: "fr-FR", ddg: "fr-fr", language: "fr", country: "FR" },
  es: { label: "Spain", bing: "es-ES", ddg: "es-es", language: "es", country: "ES" },
};

export const DEFAULT_MARKET: SerpMarket = "pl";

export const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

export function isMarket(value: string): value is SerpMarket {
  return value in MARKETS;
}

/** An Accept-Language header matched to the market — engines do respect it. */
export function acceptLanguage(market: SerpMarket): string {
  const config = MARKETS[market];
  return `${config.language}-${config.country},${config.language};q=0.9,en;q=0.6`;
}

/** Appends country, language and device parameters to a SERP URL. */
export function marketParams(
  engine: SerpEngine,
  market: SerpMarket,
  device: SerpDevice,
): string {
  const config = MARKETS[market];
  const parts: string[] = [];

  if (engine === "bing") {
    parts.push(`mkt=${config.bing}`, `setlang=${config.language}`, `cc=${config.country}`);
  } else if (engine === "duckduckgo") {
    parts.push(`kl=${config.ddg}`);
  } else if (engine === "mojeek") {
    parts.push(`arc=${config.country.toLowerCase()}`, `lb=${config.language}`);
  } else if (engine === "brave") {
    parts.push(`country=${config.country.toLowerCase()}`, `search_lang=${config.language}`);
  } else if (engine === "google") {
    parts.push(`gl=${config.country.toLowerCase()}`, `hl=${config.language}`);
  }

  // The mobile SERP can differ — Bing supports an explicit switch.
  if (device === "mobile" && engine === "bing") parts.push("form=MOBS");

  return parts.length > 0 ? `&${parts.join("&")}` : "";
}
