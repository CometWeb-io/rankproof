import type { SerpDevice, SerpEngine, SerpMarket } from "./types.ts";

/**
 * Runtime configuration — everything a self-hoster might want to change
 * without touching code. Values are read from ENV once, on first use.
 *
 * The default limits are deliberately cautious: this tool queries other
 * people's servers, so aggressive concurrency hurts them and you (bans) alike.
 */
export type RuntimeConfig = {
  /** Total time budget for a full scan, in ms. */
  scanBudgetMs: number;
  /** Budget for a secondary scan (a competitor during gap analysis). */
  lightBudgetMs: number;
  /** How many parallel requests to a single host. */
  hostConcurrency: number;
  /** Maximum number of backlinks in the report. */
  maxBacklinks: number;
  /** How many candidate pages are verified in the first wave. */
  maxVerify: number;
  /** Engines used in an automatic scan. */
  engines: SerpEngine[];
  market: SerpMarket;
  device: SerpDevice;
  /** SERP depth: 10 = one page, 20 = two. */
  serpDepth: number;
  /** User-agent for APIs and JSON endpoints. */
  apiUserAgent: string;
  /** Disables writing history to the database (e.g. in CLI mode). */
  persistHistory: boolean;
};

const ALL_ENGINES: SerpEngine[] = ["bing", "duckduckgo", "mojeek", "brave", "google"];
const ALL_MARKETS: SerpMarket[] = ["pl", "us", "gb", "de", "fr", "es"];

function env(key: string, ...aliases: string[]): string | undefined {
  const keys = [key, ...aliases];
  if (key.startsWith("RANKPROOF_")) {
    keys.push(key.replace(/^RANKPROOF_/, "OPENVIS_"));
    keys.push(key.replace(/^RANKPROOF_/, "SERPRADAR_"));
  }
  for (const name of keys) {
    const value = typeof process !== "undefined" ? process.env?.[name] : undefined;
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

function num(key: string, fallback: number, min: number, max: number): number {
  const raw = env(key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function bool(key: string, fallback: boolean): boolean {
  const raw = env(key)?.toLowerCase();
  if (raw === undefined) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function parseEngines(raw: string | undefined, fallback: SerpEngine[]): SerpEngine[] {
  if (!raw) return fallback;
  const list = raw
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item): item is SerpEngine => ALL_ENGINES.includes(item as SerpEngine));
  return list.length > 0 ? [...new Set(list)] : fallback;
}

export function parseMarket(raw: string | undefined, fallback: SerpMarket): SerpMarket {
  const value = raw?.trim().toLowerCase();
  return value && ALL_MARKETS.includes(value as SerpMarket) ? (value as SerpMarket) : fallback;
}

export function parseDevice(raw: string | undefined, fallback: SerpDevice): SerpDevice {
  const value = raw?.trim().toLowerCase();
  return value === "mobile" || value === "desktop" ? value : fallback;
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  scanBudgetMs: 58_000,
  lightBudgetMs: 20_000,
  hostConcurrency: 3,
  maxBacklinks: 400,
  maxVerify: 64,
  engines: ["bing", "duckduckgo", "mojeek"],
  market: "pl",
  device: "desktop",
  serpDepth: 10,
  apiUserAgent: "RankProof/8.1 (+https://github.com/MaciejZet/rankproof)",
  persistHistory: true,
};

let cached: RuntimeConfig | null = null;

/** Configuration from ENV, with sensible defaults. */
export function config(): RuntimeConfig {
  if (cached) return cached;
  cached = {
    scanBudgetMs: num("RANKPROOF_SCAN_BUDGET_MS", DEFAULT_CONFIG.scanBudgetMs, 8_000, 300_000),
    lightBudgetMs: num("RANKPROOF_LIGHT_BUDGET_MS", DEFAULT_CONFIG.lightBudgetMs, 5_000, 120_000),
    hostConcurrency: num("RANKPROOF_HOST_CONCURRENCY", DEFAULT_CONFIG.hostConcurrency, 1, 8),
    maxBacklinks: num("RANKPROOF_MAX_BACKLINKS", DEFAULT_CONFIG.maxBacklinks, 20, 5_000),
    maxVerify: num("RANKPROOF_MAX_VERIFY", DEFAULT_CONFIG.maxVerify, 8, 400),
    engines: parseEngines(env("RANKPROOF_ENGINES"), DEFAULT_CONFIG.engines),
    market: parseMarket(env("RANKPROOF_MARKET"), DEFAULT_CONFIG.market),
    device: parseDevice(env("RANKPROOF_DEVICE"), DEFAULT_CONFIG.device),
    serpDepth: num("RANKPROOF_SERP_DEPTH", DEFAULT_CONFIG.serpDepth, 10, 20) > 15 ? 20 : 10,
    apiUserAgent: env("RANKPROOF_USER_AGENT") ?? DEFAULT_CONFIG.apiUserAgent,
    persistHistory: bool("RANKPROOF_PERSIST_HISTORY", DEFAULT_CONFIG.persistHistory),
  };
  return cached;
}

/** Test-only — allows reloading configuration after ENV changes. */
export function resetConfig(): void {
  cached = null;
}
