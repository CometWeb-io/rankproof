/**
 * SERP provider registry.
 *
 * Built-in scrapers cover Bing / DuckDuckGo / Mojeek / Brave. Google organic
 * competitor SERP is intentionally not scraped from this process — use Search
 * Console for owned properties, or point `RANKPROOF_GOOGLE_PROVIDER_URL` at a
 * self-hosted OpenSERP-compatible JSON endpoint.
 */

import type { SerpEngine } from "./types.ts";
import type { OrganicHit } from "./serp.ts";

export type ProviderKind = "builtin-scrape" | "owner-api" | "http-json" | "unimplemented";

export type SerpProviderMeta = {
  id: SerpEngine;
  label: string;
  kind: ProviderKind;
  defaultEnabled: boolean;
  description: string;
};

export const SERP_PROVIDERS: SerpProviderMeta[] = [
  {
    id: "bing",
    label: "Bing",
    kind: "builtin-scrape",
    defaultEnabled: true,
    description: "HTML scrape of Bing organic results.",
  },
  {
    id: "duckduckgo",
    label: "DuckDuckGo",
    kind: "builtin-scrape",
    defaultEnabled: true,
    description: "HTML scrape of DuckDuckGo html endpoint.",
  },
  {
    id: "mojeek",
    label: "Mojeek",
    kind: "builtin-scrape",
    defaultEnabled: true,
    description: "HTML scrape of Mojeek organic results.",
  },
  {
    id: "brave",
    label: "Brave",
    kind: "builtin-scrape",
    defaultEnabled: false,
    description: "HTML scrape of Brave Search (often challenged).",
  },
  {
    id: "google",
    label: "Google organic",
    kind: "http-json",
    defaultEnabled: false,
    description:
      "Competitor Google SERP via self-hosted JSON provider (OpenSERP-compatible). Owned-site Google metrics come from Search Console, not this engine.",
  },
];

export const BUILTIN_SCRAPE_ENGINES: SerpEngine[] = ["bing", "duckduckgo", "mojeek", "brave"];

export function googleProviderBaseUrl(): string | null {
  const value =
    process.env.RANKPROOF_GOOGLE_PROVIDER_URL?.trim() ||
    process.env.OPENVIS_GOOGLE_PROVIDER_URL?.trim() ||
    process.env.SERPRADAR_GOOGLE_PROVIDER_URL?.trim();
  return value || null;
}

export function isEngineConfigured(engine: SerpEngine): boolean {
  if (engine !== "google") return true;
  return Boolean(googleProviderBaseUrl());
}

/**
 * Fetch organic hits from an OpenSERP-style provider.
 * Expected shapes (first match wins):
 * - `{ organic: [{ link|url, title, snippet|description }] }`
 * - `{ results: [...] }`
 * - `[...]`
 */
export async function fetchGoogleOrganicViaProvider(
  keyword: string,
  options: {
    baseUrl: string;
    market?: string;
    device?: string;
    page?: number;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<{ hits: OrganicHit[]; html: string }> {
  const base = options.baseUrl.replace(/\/$/, "");
  const page = options.page ?? 0;
  const url = new URL(`${base}/google/search`);
  url.searchParams.set("q", keyword);
  if (options.market) url.searchParams.set("gl", options.market);
  if (options.device) url.searchParams.set("device", options.device);
  if (page > 0) url.searchParams.set("start", String(page * 10));

  const fetchImpl = options.fetchImpl ?? fetch;
  // Node's fetch has no default timeout: without this, one stalled provider
  // hangs `doctor` and every scan that includes the google engine.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 10_000);
  let res: Response;
  try {
    res = await fetchImpl(url.href, {
      headers: { Accept: "application/json", "User-Agent": "RankProof/google-provider" },
      signal: options.signal ?? abort.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Google provider HTTP ${res.status}`);
  const text = (await res.text()).slice(0, 2_000_000);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Google provider returned non-JSON");
  }
  const rows = extractProviderRows(data);
  const hits: OrganicHit[] = [];
  for (const row of rows) {
    const href = String(row.link ?? row.url ?? "").trim();
    if (!/^https?:\/\//i.test(href)) continue;
    hits.push({
      position: hits.length + 1,
      url: href,
      title: String(row.title ?? "").slice(0, 200),
      snippet: String(row.snippet ?? row.description ?? "").slice(0, 400),
    });
  }
  return { hits, html: text };
}

function extractProviderRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter(isRecord);
  if (!isRecord(data)) return [];
  for (const key of ["organic", "results", "organic_results", "items"]) {
    const value = data[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
