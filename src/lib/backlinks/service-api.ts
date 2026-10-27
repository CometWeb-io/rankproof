/**
 * Request handling for the HTTP API when another service calls it — pure.
 *
 * `serve-api.mjs` stays a thin transport; the decisions it makes about a
 * request (is the caller allowed, which scan options does the body ask for,
 * which seed URLs are acceptable) live here so they can be tested without a
 * socket.
 */
import { guardUrl } from "./ssrf.ts";
import type { Candidate } from "./sources.server.ts";
import type { ScanOptions } from "./engine.server.ts";
import type { SerpDevice, SerpEngine, SerpMarket } from "./types.ts";
import { hostFromUrl, isTargetHost } from "./parse.ts";

/** At most this many seed URLs are accepted per scan; the rest are dropped. */
export const MAX_SEED_URLS = 150;

const MARKETS: readonly SerpMarket[] = ["pl", "us", "gb", "de", "fr", "es"];
const DEVICES: readonly SerpDevice[] = ["desktop", "mobile"];
const ENGINES: readonly SerpEngine[] = ["bing", "duckduckgo", "mojeek", "brave", "google"];

/** Comparison whose duration does not depend on where the strings differ. */
function sameSecret(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Whether a request may use the API. Without a configured token every caller
 * is allowed — the listener is bound to 127.0.0.1 by default. With one, the
 * request must carry `Authorization: Bearer <token>`.
 */
export function isAuthorized(header: string | undefined, token: string | undefined): boolean {
  const expected = token?.trim();
  if (!expected) return true;
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  return match !== null && sameSecret(match[1]!.trim(), expected);
}

/**
 * Pages the site owner's webmaster tools (Bing, Yandex…) report as linking to
 * the target. They are candidates like any other: nothing counts as a backlink
 * until its HTML has been fetched and the link confirmed.
 */
export function seedCandidates(urls: unknown, host: string, limit = MAX_SEED_URLS): Candidate[] {
  if (!Array.isArray(urls)) return [];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    if (out.length >= limit) break;
    if (typeof raw !== "string" || raw.length > 2048) continue;
    let protocol: string;
    try {
      protocol = new URL(raw.trim()).protocol;
    } catch {
      continue;
    }
    if (protocol !== "http:" && protocol !== "https:") continue;
    if (!guardUrl(raw.trim()).allowed) continue;
    const parsed = new URL(raw.trim());
    parsed.hash = "";
    const url = parsed.href;
    const sourceHost = hostFromUrl(url);
    // A page on the target itself is an internal link, not a backlink.
    if (!sourceHost || isTargetHost(sourceHost, host) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: "", via: "webmaster", boost: 2 });
  }
  return out;
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** `POST /scan` body → scan options; unknown or malformed fields are ignored. */
export function scanOptionsFromBody(body: Record<string, unknown>): ScanOptions {
  const engines = Array.isArray(body.engines)
    ? body.engines.map((e) => pick(e, ENGINES)).filter((e): e is SerpEngine => e !== undefined)
    : undefined;
  const budget =
    typeof body.budgetMs === "number" && Number.isFinite(body.budgetMs)
      ? Math.min(Math.max(Math.round(body.budgetMs), 8_000), 300_000)
      : undefined;
  return {
    includeWebmaster: false,
    profile: "quick",
    mode: pick(body.mode, ["full", "light"] as const),
    budgetMs: budget,
    market: pick(body.market, MARKETS),
    device: pick(body.device, DEVICES),
    engines: engines?.length ? engines : undefined,
    depth: body.depth === 10 || body.depth === 20 ? body.depth : undefined,
    skipSiteAudit: body.skipSiteAudit === true,
    seedUrls: Array.isArray(body.seedUrls)
      ? body.seedUrls.filter((u): u is string => typeof u === "string").slice(0, MAX_SEED_URLS)
      : undefined,
  };
}
