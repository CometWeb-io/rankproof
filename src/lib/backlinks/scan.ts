import { createServerFn } from "@tanstack/react-start";
import type {
  GapResult,
  SerpDevice,
  SerpMarket,
  ScanResult,
  SerpCheckResult,
  SerpEngine,
  SuggestResult,
} from "./types.ts";

const ENGINES: SerpEngine[] = ["bing", "duckduckgo", "mojeek", "brave"];
const MARKET_IDS: SerpMarket[] = ["pl", "us", "gb", "de", "fr", "es"];

function readMarket(data: unknown): SerpMarket | undefined {
  const raw = (data as { market?: unknown }).market;
  return typeof raw === "string" && MARKET_IDS.includes(raw as SerpMarket)
    ? (raw as SerpMarket)
    : undefined;
}

function readDevice(data: unknown): SerpDevice | undefined {
  const raw = (data as { device?: unknown }).device;
  return raw === "mobile" ? "mobile" : raw === "desktop" ? "desktop" : undefined;
}

function readKeywords(data: unknown, max: number): string[] {
  const raw = (data as { keywords?: unknown }).keywords;
  if (!Array.isArray(raw)) throw new Error("Enter the keywords you want checked.");
  const keywords = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 80)
    .slice(0, max);
  if (keywords.length === 0) throw new Error("Enter at least one keyword.");
  return keywords;
}

function readUrl(data: unknown, key = "url"): string {
  if (
    typeof data !== "object" ||
    data === null ||
    !(key in data) ||
    typeof (data as Record<string, unknown>)[key] !== "string"
  ) {
    throw new Error("Enter a site address or domain.");
  }
  const url = ((data as Record<string, string>)[key] ?? "").trim();
  if (url.length < 3 || url.length > 400) {
    throw new Error("Invalid address.");
  }
  return url;
}

export const scanBacklinks = createServerFn({ method: "POST" })
  .validator((data: unknown) => ({
    url: readUrl(data),
    market: readMarket(data),
    device: readDevice(data),
  }))
  .handler(async ({ data }): Promise<ScanResult> => {
    const { runScan } = await import("./engine.server.ts");
    const result = await runScan(data.url, { market: data.market, device: data.device });
    if (!result.ok) return result;
    const { config } = await import("./config.ts");
    if (!config().persistHistory) return result;
    const { attachHistory } = await import("./store.server.ts");
    return { ok: true, report: await attachHistory(result.report) };
  });

export const scanLinkGap = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const url = readUrl(data);
    const raw = (data as { competitors?: unknown }).competitors;
    if (!Array.isArray(raw)) throw new Error("Enter competitor domains.");
    const competitors = raw
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length >= 3 && item.length <= 400)
      .slice(0, 5);
    if (competitors.length === 0) {
      throw new Error("Enter at least one competitor domain.");
    }
    return { url, competitors };
  })
  .handler(async ({ data }): Promise<GapResult> => {
    const { runLinkGap } = await import("./gap.server.ts");
    return runLinkGap(data.url, data.competitors);
  });

export const checkSerpKeywords = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const url = readUrl(data);
    const keywords = readKeywords(data, 10);
    const rawEngines = (data as { engines?: unknown }).engines;
    const engines = Array.isArray(rawEngines)
      ? (rawEngines.filter(
          (item): item is SerpEngine =>
            typeof item === "string" && ENGINES.includes(item as SerpEngine),
        ) as SerpEngine[])
      : undefined;
    const rawDepth = (data as { depth?: unknown }).depth;
    const depth = rawDepth === 20 ? 20 : 10;
    return { url, keywords, engines, depth, market: readMarket(data), device: readDevice(data) };
  })
  .handler(async ({ data }): Promise<SerpCheckResult> => {
    const { runKeywordSerp } = await import("./serp.server.ts");
    const { loadPreviousPositions } = await import("./store.server.ts");
    let previous: { keyword: string; engine: string; position: number | null }[] | undefined;
    try {
      const { parseTarget } = await import("./parse.ts");
      previous = await loadPreviousPositions(
        parseTarget(data.url).host,
        new Date().toISOString(),
      );
    } catch {
      previous = undefined;
    }
    return runKeywordSerp(data.url, data.keywords, {
      engines: data.engines,
      depth: data.depth,
      market: data.market,
      device: data.device,
      previous,
    });
  });

/** Keyword ideas from search-engine autocomplete — no API keys required. */
export const suggestKeywordIdeas = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const seeds = readKeywords(data, 5);
    const rawBrand = (data as { brandTokens?: unknown }).brandTokens;
    const brandTokens = Array.isArray(rawBrand)
      ? rawBrand.filter((item): item is string => typeof item === "string").slice(0, 5)
      : [];
    return { seeds, brandTokens };
  })
  .handler(async ({ data }): Promise<SuggestResult> => {
    const { suggestKeywords } = await import("./suggest.server.ts");
    return suggestKeywords(data.seeds, { brandTokens: data.brandTokens });
  });
