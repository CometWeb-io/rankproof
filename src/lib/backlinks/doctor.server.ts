import { Budget, BROWSER_UA, fetchText } from "./net.server.ts";
import { config } from "./config.ts";
import { diskCache } from "./disk-cache.server.ts";
import { acceptLanguage, marketParams } from "./market.ts";
import {
  detectSerpBlock,
  parseBingOrganic,
  parseBraveOrganic,
  parseDdgOrganic,
  parseMojeekOrganic,
  parseRelatedSearches,
} from "./serp.ts";
import { BUILTIN_SCRAPE_ENGINES, googleProviderBaseUrl, isEngineConfigured } from "./serp-providers.ts";
import type { SerpEngine, SerpStatus } from "./types.ts";

/**
 * Self-diagnosis.
 *
 * Search engines change their markup without notice. When that happens the
 * parser silently returns nothing and every scan quietly reports "no
 * visibility" — the worst possible failure mode, because it looks like data.
 *
 * `doctor` probes each engine with a known query and reports, per engine,
 * whether we are getting results, being blocked, or looking at markup our
 * parser no longer understands.
 */

export type EngineDiagnosis = {
  engine: SerpEngine;
  status: SerpStatus;
  httpStatus: number | null;
  hits: number;
  related: number;
  bytes: number;
  ms: number;
  hint: string;
};

export type Diagnosis = {
  engines: EngineDiagnosis[];
  environment: { key: string; value: string; ok: boolean; hint: string }[];
  healthy: boolean;
};

const PARSERS: Record<Exclude<SerpEngine, "google">, (html: string) => { url: string }[]> = {
  bing: parseBingOrganic,
  duckduckgo: parseDdgOrganic,
  mojeek: parseMojeekOrganic,
  brave: parseBraveOrganic,
};

const PROBE_URL: Record<Exclude<SerpEngine, "google">, (q: string) => string> = {
  bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  duckduckgo: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  mojeek: (q) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`,
  brave: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
};

const HINTS: Record<SerpStatus, string> = {
  ok: "Working.",
  "no-results": "Reached the engine, but the query returned nothing. Try another probe query.",
  blocked: "The engine served a CAPTCHA or bot challenge. Lower concurrency or change network.",
  "rate-limited": "Rate limited. Slow down (RANKPROOF_HOST_CONCURRENCY) and retry later.",
  "parser-failed":
    "A full page came back but the parser found nothing — the markup likely changed. This is a bug worth reporting.",
  "empty-response": "The engine returned an empty or truncated body.",
  "not-configured":
    "Optional engine — set RANKPROOF_GOOGLE_PROVIDER_URL for competitor Google SERP (Search Console covers owned sites).",
  error: "The request failed before a response arrived.",
};

/** Map hard HTTP failures to the status that operators should act on. */
function statusFromHttp(status: number): SerpStatus | null {
  if (status === 429) return "rate-limited";
  if (status === 403 || status === 401) return "blocked";
  if (status >= 400) return "error";
  return null;
}

async function probeEngine(engine: SerpEngine, query: string, budget: Budget): Promise<EngineDiagnosis> {
  const started = Date.now();
  if (engine === "google") {
    if (!isEngineConfigured("google")) {
      return {
        engine,
        status: "not-configured",
        httpStatus: null,
        hits: 0,
        related: 0,
        bytes: 0,
        ms: Date.now() - started,
        hint: HINTS["not-configured"],
      };
    }
    try {
      const { fetchGoogleOrganicViaProvider } = await import("./serp-providers.ts");
      const { hits, html } = await fetchGoogleOrganicViaProvider(query, {
        baseUrl: googleProviderBaseUrl()!,
      });
      return {
        engine,
        status: hits.length > 0 ? "ok" : "no-results",
        httpStatus: 200,
        hits: hits.length,
        related: 0,
        bytes: html.length,
        ms: Date.now() - started,
        hint: hits.length > 0 ? HINTS.ok : HINTS["no-results"],
      };
    } catch (error) {
      return {
        engine,
        status: "error",
        httpStatus: null,
        hits: 0,
        related: 0,
        bytes: 0,
        ms: Date.now() - started,
        hint: `${HINTS.error} ${error instanceof Error ? error.message : ""}`.trim(),
      };
    }
  }

  const runtime = config();
  const url = `${PROBE_URL[engine](query)}${marketParams(engine, runtime.market, "desktop")}`;
  try {
    const { status, text } = await fetchText(url, {
      timeoutMs: budget.timeout(9000),
      maxBytes: 360_000,
      ua: BROWSER_UA,
      acceptLanguage: acceptLanguage(runtime.market),
      signal: budget.signal,
      skipRobots: true,
      cache: false,
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        Referer:
          engine === "duckduckgo"
            ? "https://html.duckduckgo.com/"
            : engine === "mojeek"
              ? "https://www.mojeek.com/"
              : engine === "brave"
                ? "https://search.brave.com/"
                : "https://www.bing.com/",
      },
    });
    const httpMapped = statusFromHttp(status);
    const hits = httpMapped ? [] : PARSERS[engine](text);
    const serpStatus: SerpStatus = httpMapped ?? detectSerpBlock(text, hits.length, status);
    return {
      engine,
      status: serpStatus,
      httpStatus: status,
      hits: hits.length,
      related: httpMapped ? 0 : parseRelatedSearches(text, engine).length,
      bytes: text.length,
      ms: Date.now() - started,
      hint: httpMapped
        ? `HTTP ${status}. ${HINTS[serpStatus]}`
        : HINTS[serpStatus],
    };
  } catch (error) {
    return {
      engine,
      status: "error",
      httpStatus: null,
      hits: 0,
      related: 0,
      bytes: 0,
      ms: Date.now() - started,
      hint: `${HINTS.error} ${error instanceof Error ? error.message : ""}`.trim(),
    };
  }
}

/** Runs every engine probe plus a few environment checks. */
export async function runDoctor(query = "open source seo tools"): Promise<Diagnosis> {
  const runtime = config();
  const budget = new Budget(40_000);
  const engines: SerpEngine[] = [...BUILTIN_SCRAPE_ENGINES, "google"];

  const results: EngineDiagnosis[] = [];
  // Sequential on purpose: hammering four engines at once is what gets you blocked.
  for (const engine of engines) {
    results.push(await probeEngine(engine, query, budget));
  }

  const cache = diskCache();
  const environment = [
    {
      key: "node",
      value: typeof process !== "undefined" ? process.version : "unknown",
      ok: Number((process.version ?? "v0").slice(1).split(".")[0]) >= 22,
      hint: "Node 22+ is required for native TypeScript execution.",
    },
    {
      key: "database",
      value: process.env?.DATABASE_URL ? "postgres" : "pglite (local)",
      ok: true,
      hint: "Without DATABASE_URL history stays in the embedded PGLite database.",
    },
    {
      key: "disk-cache",
      value: cache.enabled ? "enabled" : "disabled",
      ok: true,
      hint: "Set RANKPROOF_CACHE_DIR to reuse bodies across runs and spare other people's servers.",
    },
    {
      key: "host-concurrency",
      value: String(runtime.hostConcurrency),
      ok: runtime.hostConcurrency <= 4,
      hint: "Above 4 parallel requests per host you are likely to be blocked — and rude.",
    },
    {
      key: "user-agent",
      value: runtime.apiUserAgent,
      ok: /https?:\/\//.test(runtime.apiUserAgent),
      hint: "Include a contact URL so administrators can reach you instead of banning you.",
    },
  ];

  // Optional engines that are simply not wired up do not count as failures.
  const healthy = results.some((item) => item.status === "ok");
  return { engines: results, environment, healthy };
}
