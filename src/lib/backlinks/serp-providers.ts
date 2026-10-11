/**
 * SERP provider registry.
 *
 * Built-in scrapers cover Bing / DuckDuckGo / Mojeek / Brave. Google organic
 * competitor SERP is intentionally not scraped from this process — use Search
 * Console for owned properties, or point `RANKPROOF_GOOGLE_PROVIDER_URL` at a
 * self-hosted OpenSERP-compatible JSON endpoint.
 */

import { lookup } from "node:dns/promises";

import type { SerpEngine } from "./types.ts";
import type { OrganicHit } from "./serp.ts";
import { guardUrl, guardUrlWithDns, type Resolver } from "./ssrf.ts";
import { fetchPinnedProviderJson } from "./net.server.ts";

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
 * Reject provider URLs that point at localhost, metadata, or other non-public
 * targets — same policy as crawl (`guardUrl` / `guardUrlWithDns`).
 */
export async function assertProviderUrlAllowed(raw: string, resolve?: Resolver): Promise<void> {
  // Deliberately restricted to an operator-configured loopback provider.
  // Never apply this exception to site URLs, redirects or caller-supplied hosts.
  const configured = new URL(raw);
  const localHostname = configured.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    process.env.RANKPROOF_GOOGLE_ALLOW_LOOPBACK === "1" &&
    configured.protocol === "http:" &&
    (localHostname === "127.0.0.1" || localHostname === "::1")
  ) {
    return;
  }

  const staticVerdict = guardUrl(raw);
  if (!staticVerdict.allowed) {
    throw new Error(`Google provider URL blocked: ${staticVerdict.reason}`);
  }

  // Prefer DNS validation when a resolver is available (tests inject one;
  // production uses node:dns). Literal IPs already passed through guardUrl.
  const hostname = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLiteral = /^[\d.]+$/.test(hostname) || hostname.includes(":");
  if (isLiteral) return;

  const resolver =
    resolve ??
    (async (host: string) => {
      const records = await lookup(host, { all: true, verbatim: true });
      return records.map((record) => record.address);
    });
  const verdict = await guardUrlWithDns(raw, resolver);
  if (!verdict.allowed) {
    throw new Error(`Google provider URL blocked: ${verdict.reason}`);
  }
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
    /** Test-only DNS resolver; production uses node:dns. */
    resolve?: Resolver;
  },
): Promise<{ hits: OrganicHit[]; html: string }> {
  const base = options.baseUrl.replace(/\/$/, "");
  const page = options.page ?? 0;
  const url = new URL(`${base}/google/search`);
  // OpenSERP v2 uses text/lang/region/start, not Google HTML parameters q/gl.
  url.searchParams.set("text", keyword);
  const languages: Record<string, string> = {
    pl: "pl",
    us: "en",
    gb: "en",
    de: "de",
    fr: "fr",
    es: "es",
  };
  if (options.market) {
    url.searchParams.set("region", options.market);
    url.searchParams.set("lang", languages[options.market] ?? "en");
  }
  if (page > 0) url.searchParams.set("start", String(page * 10));
  url.searchParams.set("limit", "10");

  // Fail closed before any network I/O — env-configured provider URLs are as
  // dangerous as crawl targets when they point at metadata or loopback.
  await assertProviderUrlAllowed(url.href, options.resolve);

  // The deadline covers headers AND body. Native fetch is used only for the
  // explicitly configured loopback provider or injected test doubles. Public
  // providers use a pinned TCP connection to prevent DNS rebinding.
  const deadline = AbortSignal.timeout(Math.max(500, options.timeoutMs ?? 10_000));
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const localHost = url.hostname.replace(/^\[|\]$/g, "");
  const localProvider =
    process.env.RANKPROOF_GOOGLE_ALLOW_LOOPBACK === "1" &&
    url.protocol === "http:" &&
    (localHost === "127.0.0.1" || localHost === "::1");
  const res =
    options.fetchImpl || localProvider
      ? await (options.fetchImpl ?? fetch)(url.href, {
          headers: { Accept: "application/json", "User-Agent": "RankProof/google-provider" },
          signal,
          redirect: "manual",
        })
      : await fetchPinnedProviderJson(url.href, signal);
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error("Google provider redirects are not allowed");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Google provider HTTP ${res.status}`);
  }
  if (!(res.headers.get("content-type") ?? "").includes("json")) {
    throw new Error("Google provider returned non-JSON content-type");
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Google provider response is empty");
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Google provider response exceeds 2 MB limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Google provider returned non-JSON");
  }
  const rows = extractProviderRows(data);
  const hits: OrganicHit[] = [];
  for (const row of rows) {
    if (typeof row.type === "string" && row.type !== "organic") continue;
    const href = String(row.link ?? row.url ?? "").trim();
    if (!/^https?:\/\//i.test(href)) continue;
    const positionRecord = isRecord(row.position) ? row.position : null;
    const explicitPosition = Number(positionRecord?.absolute ?? row.rank);
    hits.push({
      position:
        Number.isInteger(explicitPosition) && explicitPosition > 0
          ? explicitPosition
          : page * 10 + hits.length + 1,
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
