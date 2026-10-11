import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import { usefulHtml } from "./html.ts";
import { config } from "./config.ts";
import { createHostLimiter } from "./host-limiter.ts";
import { diskCache, type CachedResponse } from "./disk-cache.server.ts";
import { guardUrl, guardUrlWithDns, isPrivateAddress } from "./ssrf.ts";
import { isAllowed, robotsFor } from "./robots.server.ts";

export const API_UA = config().apiUserAgent;
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export type FetchResult = {
  status: number;
  text: string;
  finalUrl: string;
  headers: Headers | null;
  fromCache: boolean;
  /** True when byte or useful-HTML limits stopped reading before EOF. */
  truncated?: boolean;
};

const CACHE = new Map<string, { value: FetchResult; storedAt: number }>();
const CACHE_LIMIT = 64; // predictable memory budget on small local machines
// Short lifetime: backlink verification must reflect changes within a session.
const CACHE_TTL_MS = 60_000;

/** A simple limiter: at most N parallel requests to a single host. */
const acquireHost = createHostLimiter(config().hostConcurrency);

/**
 * The cache key must include language and user-agent: the same SERP URL returns
 * different results for another market and for the mobile version.
 */
function cacheKey(url: string, method: string, opts: FetchOptions): string {
  // Different byte limits, representations and request headers cannot share a
  // cached body. Never cache authorization-bearing requests at all.
  const headers = Object.entries(opts.headers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([
    method,
    url,
    opts.acceptLanguage,
    opts.ua,
    opts.accept,
    opts.maxBytes,
    opts.usefulMax,
    opts.skipRobots,
    headers,
  ]);
}

/** Respect response-level cache privacy and variant semantics. */
export function isResponseCacheable(res: Response): boolean {
  if (res.status < 200 || res.status >= 300) return false;
  if (res.headers.has("set-cookie")) return false;
  const policy = res.headers.get("cache-control") ?? "";
  if (/(?:^|,)\s*(?:private|no-store)\b/i.test(policy)) return false;
  const allowedVary = new Set(["accept", "accept-language", "user-agent"]);
  for (const name of (res.headers.get("vary") ?? "").split(",")) {
    const header = name.trim().toLowerCase();
    if (header && !allowedVary.has(header)) return false;
  }
  return true;
}

function remember(key: string, value: FetchResult) {
  if (CACHE.size >= CACHE_LIMIT) {
    const first = CACHE.keys().next().value;
    if (first) CACHE.delete(first);
  }
  CACHE.set(key, { value, storedAt: Date.now() });
}

export type FetchOptions = {
  timeoutMs: number;
  maxBytes: number;
  ua?: string;
  accept?: string;
  usefulMax?: number;
  method?: "GET" | "HEAD";
  /** Overrides Accept-Language — SERP positions depend on the query language. */
  acceptLanguage?: string;
  cache?: boolean;
  signal?: AbortSignal;
  /** Skips robots.txt (used for robots.txt itself and for SERP endpoints). */
  skipRobots?: boolean;
  /** Extra request headers, e.g. conditional revalidation. */
  headers?: Record<string, string>;
  /** Budget used when robots.txt has to be fetched first. */
  budget?: Budget;
};

/** Raised when a URL is refused before any connection is made. */
export class BlockedUrlError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "BlockedUrlError";
    this.reason = reason;
  }
}

/** Raised when robots.txt forbids the path. */
export class RobotsDisallowedError extends Error {
  constructor(url: string) {
    super(`robots.txt disallows ${url}`);
    this.name = "RobotsDisallowedError";
  }
}

const MAX_REDIRECTS = 5;

async function resolveHost(hostname: string): Promise<string[]> {
  return hostResolver(hostname);
}

type HostResolver = (hostname: string) => Promise<string[]>;

async function defaultHostResolver(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

let hostResolver: HostResolver = defaultHostResolver;

/** Test-only: replace DNS lookup so crawler suites stay hermetic. */
export function setHostResolverForTests(resolver: HostResolver | null): void {
  hostResolver = resolver ?? defaultHostResolver;
}

/**
 * Validates a URL before every hop and returns the public IPs that passed the
 * check. The connection must pin to one of those addresses so a later DNS
 * answer cannot rebind into private space.
 */
async function assertFetchable(url: string): Promise<string[]> {
  const verdict = await guardUrlWithDns(url, resolveHost);
  if (!verdict.allowed) throw new BlockedUrlError(verdict.reason);
  return verdict.addresses;
}

function pickPinnedAddress(addresses: string[]): string {
  const publicAddr = addresses.find((address) => !isPrivateAddress(address));
  if (!publicAddr) throw new BlockedUrlError("No public address available to pin.");
  return publicAddr;
}

/**
 * HTTP(S) request that connects to a previously validated IP while preserving
 * Host / SNI for the original hostname.
 */
function pinnedRequest(
  url: string,
  addresses: string[],
  init: {
    method: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
    maxBytes: number;
  },
): Promise<Response> {
  const parsed = new URL(url);
  const ip = pickPinnedAddress(addresses).replace(/^\[|\]$/g, "");
  const isHttps = parsed.protocol === "https:";
  const lib = isHttps ? https : http;
  const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: ip,
        port,
        path: `${parsed.pathname}${parsed.search}`,
        method: init.method,
        headers: {
          ...init.headers,
          Host: parsed.host,
        },
        servername: isHttps ? parsed.hostname : undefined,
        signal: init.signal,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("error", reject);
        res.on("aborted", () => reject(new Error("Response aborted by the server.")));
        res.on("data", (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > init.maxBytes) {
            res.destroy(new Error("Response exceeded configured byte limit."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const headerInit: [string, string][] = [];
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const item of value) headerInit.push([key, item]);
            } else {
              headerInit.push([key, value]);
            }
          }
          resolve(
            new Response(
              init.method === "HEAD" || [204, 205, 304].includes(res.statusCode ?? 0)
                ? null
                : Buffer.concat(chunks),
              {
                status: res.statusCode ?? 200,
                statusText: res.statusMessage,
                headers: headerInit,
              },
            ),
          );
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Per-origin reservations for robots.txt Crawl-delay. */
const NEXT_ALLOWED_AT = new Map<string, number>();
const MAX_CRAWL_DELAY_WAIT_MS = 10_000;
const MAX_DELAY_ORIGINS = 512;

/** A delay larger than the local scan's wait budget must refuse a fetch,
 * never silently compress the website operator's requested spacing. */
export function planCrawlDelay(
  now: number,
  priorNextAt: number,
  delaySeconds: number,
  maxWaitMs = MAX_CRAWL_DELAY_WAIT_MS,
): { waitMs: number; nextAt: number } | null {
  const waitMs = Math.max(0, priorNextAt - now);
  if (waitMs > maxWaitMs) return null;
  return { waitMs, nextAt: now + waitMs + delaySeconds * 1000 };
}

async function respectCrawlDelay(
  origin: string,
  delaySeconds: number | null,
  signal?: AbortSignal,
): Promise<void> {
  if (!delaySeconds || delaySeconds <= 0) return;
  signal?.throwIfAborted();
  const now = Date.now();
  for (const [key, until] of NEXT_ALLOWED_AT) {
    if (until <= now) NEXT_ALLOWED_AT.delete(key);
  }
  if (!NEXT_ALLOWED_AT.has(origin) && NEXT_ALLOWED_AT.size >= MAX_DELAY_ORIGINS) {
    throw new Error("Crawl-delay reservation capacity exhausted.");
  }
  const slot = planCrawlDelay(now, NEXT_ALLOWED_AT.get(origin) ?? 0, delaySeconds);
  if (!slot) {
    throw new Error("Crawl-delay exceeds the permitted scan wait budget.");
  }
  NEXT_ALLOWED_AT.set(origin, slot.nextAt);
  if (slot.waitMs > 0) await sleep(slot.waitMs, undefined, { signal });
}

export async function fetchText(url: string, opts: FetchOptions): Promise<FetchResult> {
  const method = opts.method ?? "GET";
  // Validate input and client cancellation BEFORE reading any cached result:
  // cached crawl evidence must not bypass the active security policy.
  opts.signal?.throwIfAborted();
  const staticVerdict = guardUrl(url);
  if (!staticVerdict.allowed) throw new BlockedUrlError(staticVerdict.reason);

  const key = cacheKey(url, method, opts);
  const cacheAllowed =
    opts.cache !== false &&
    !Object.keys(opts.headers ?? {}).some((key) =>
      /^(authorization|cookie|proxy-authorization)$/i.test(key),
    );
  if (cacheAllowed) {
    const hit = CACHE.get(key);
    if (hit && Date.now() - hit.storedAt < CACHE_TTL_MS) {
      // Robots rules may have changed since this page was cached. Recheck the
      // requested URL and the final redirect destination before reusing it.
      if (!opts.skipRobots && opts.budget) {
        const urls = new Set([url, hit.value.finalUrl]);
        for (const checkedUrl of urls) {
          const parsed = new URL(checkedUrl);
          const rules = await robotsFor(parsed.origin, opts.budget);
          if (!isAllowed(rules, parsed.pathname + parsed.search)) {
            throw new RobotsDisallowedError(checkedUrl);
          }
        }
      }
      opts.signal?.throwIfAborted();
      return { ...hit.value, fromCache: true };
    }
    if (hit) CACHE.delete(key);
  }

  // Crawl rules must be enforced for every redirect destination.
  const cache = diskCache();
  const cacheable = method === "GET" && cacheAllowed && cache.enabled;
  const stored: CachedResponse | null = cacheable ? await cache.get(key) : null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  if (opts.signal?.aborted) controller.abort();
  let releaseHost: (() => void) | null = null;

  try {
    let current = url;
    let res: Response | null = null;
    const initialOrigin = new URL(url).origin;

    // Production pins validated IPs; development allows fetch-based test doubles.
    // RANKPROOF_PIN_DNS=0 is an unsafe explicit override for local debugging only.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const addresses = await assertFetchable(current);
      const hopUrl = new URL(current);
      if (!opts.skipRobots && opts.budget) {
        const rules = await robotsFor(hopUrl.origin, opts.budget);
        if (!isAllowed(rules, hopUrl.pathname + hopUrl.search)) {
          throw new RobotsDisallowedError(current);
        }
        await respectCrawlDelay(hopUrl.origin, rules.crawlDelay, controller.signal);
      }
      // Conditional validators belong to the exact cached URL. Do not send
      // operator/API credentials or cookies to an unrelated redirect host.
      const sameOrigin = hopUrl.origin === initialOrigin;
      const extraHeaders = Object.fromEntries(
        Object.entries(opts.headers ?? {}).filter(
          ([name]) =>
            !/^(host|connection|proxy-authorization)$/i.test(name) &&
            (sameOrigin || !/^(authorization|cookie)$/i.test(name)),
        ),
      );
      const headers = {
        "User-Agent": opts.ua ?? BROWSER_UA,
        Accept: opts.accept ?? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": opts.acceptLanguage ?? "en,pl;q=0.8",
        ...(current === url ? cache.conditionalHeaders(stored) : {}),
        ...extraHeaders,
      };
      // The slot is held until the response BODY is read or cancelled, not
      // merely until headers arrive. Otherwise slow peers bypass concurrency.
      releaseHost = await acquireHost(hopUrl.hostname, controller.signal);
      const pin =
        process.env.RANKPROOF_PIN_DNS === "1" ||
        (process.env.NODE_ENV === "production" && process.env.RANKPROOF_PIN_DNS !== "0");
      const response = pin
        ? await pinnedRequest(current, addresses, {
            method,
            signal: controller.signal,
            headers,
            maxBytes: opts.maxBytes,
          })
        : await fetch(current, {
            method,
            signal: controller.signal,
            redirect: "manual",
            headers,
          });

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        if (hop === MAX_REDIRECTS) {
          res = response;
          break;
        }
        // Release the unused redirect body and the previous host's slot.
        // The next hop will be revalidated before connecting.
        await response.body?.cancel().catch(() => undefined);
        releaseHost();
        releaseHost = null;
        current = new URL(location, current).href;
        continue;
      }
      res = response;
      break;
    }

    if (!res) throw new Error("No response received.");

    // 304: the stored body is still valid, so nothing crosses the wire.
    if (res.status === 304 && stored) {
      if (!opts.skipRobots && opts.budget) {
        const prior = new URL(stored.finalUrl);
        const rules = await robotsFor(prior.origin, opts.budget);
        if (!isAllowed(rules, prior.pathname + prior.search)) {
          throw new RobotsDisallowedError(stored.finalUrl);
        }
      }
      const result: FetchResult = {
        status: stored.status,
        text: stored.text,
        finalUrl: stored.finalUrl,
        headers: res.headers,
        fromCache: true,
      };
      if (cacheAllowed && isResponseCacheable(res)) remember(key, result);
      return result;
    }

    if (method === "HEAD") {
      await res.body?.cancel().catch(() => undefined);
      const result: FetchResult = {
        status: res.status,
        text: "",
        finalUrl: res.url || current,
        headers: res.headers,
        fromCache: false,
      };
      if (cacheAllowed && isResponseCacheable(res)) remember(key, result);
      return result;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (/^(image|video|audio|font)\//i.test(contentType)) {
      await res.body?.cancel().catch(() => undefined);
      const result: FetchResult = {
        status: res.status,
        text: "",
        finalUrl: res.url || current,
        headers: res.headers,
        fromCache: false,
      };
      if (cacheAllowed && isResponseCacheable(res)) remember(key, result);
      return result;
    }

    const reader = res.body?.getReader();
    let text = "";
    let truncated = false;
    if (!reader) {
      text = await res.text();
      truncated = Buffer.byteLength(text, "utf8") > opts.maxBytes;
      if (truncated) text = text.slice(0, opts.maxBytes);
    } else {
      const decoder = new TextDecoder("utf-8", { fatal: false });
      let received = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          // Decode at most the remaining byte budget, even when a server
          // returns an unexpectedly large single stream chunk.
          const remaining = Math.max(0, opts.maxBytes - received);
          if (value.byteLength > remaining) {
            text += decoder.decode(value.subarray(0, remaining), { stream: true });
            truncated = true;
            break;
          }
          received += value.byteLength;
          text += decoder.decode(value, { stream: true });
          if (
            opts.usefulMax &&
            received > 60_000 &&
            usefulHtml(text, opts.usefulMax).length >= opts.usefulMax
          ) {
            truncated = true;
            break;
          }
        }
        text += decoder.decode();
      } finally {
        try {
          await reader.cancel();
        } catch {
          /* stream reached EOF or was already cancelled */
        }
        reader.releaseLock();
      }
    }

    if (opts.usefulMax) text = usefulHtml(text, opts.usefulMax);
    else if (text.length > opts.maxBytes) text = text.slice(0, opts.maxBytes);

    const finalUrl = res.url || current;
    const result: FetchResult = {
      status: res.status,
      text,
      finalUrl,
      headers: res.headers,
      fromCache: false,
      truncated,
    };
    if (!truncated && cacheAllowed && isResponseCacheable(res)) remember(key, result);
    if (!truncated && cacheable && isResponseCacheable(res)) {
      await cache.set(key, {
        url,
        status: res.status,
        text,
        finalUrl,
        etag: res.headers.get("etag"),
        lastModified: res.headers.get("last-modified"),
        storedAt: Date.now(),
      });
    }
    return result;
  } finally {
    releaseHost?.();
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

export async function fetchJson<T>(
  url: string,
  timeoutMs: number,
  ua = API_UA,
  signal?: AbortSignal,
): Promise<T> {
  const { status, text } = await fetchText(url, {
    timeoutMs,
    maxBytes: 900_000,
    ua,
    accept: "application/json, text/json;q=0.9, */*;q=0.8",
    signal,
  });
  if (status >= 400) throw new Error(`HTTP ${status}`);
  return JSON.parse(text) as T;
}

/**
 * Fetches a page we intend to read as content. This is the crawl path, so it
 * is the one that honours robots.txt — pass a budget to enable that check.
 */
export async function fetchUsefulHtml(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  budget?: Budget,
): Promise<FetchResult> {
  let res = await fetchText(url, {
    timeoutMs,
    maxBytes: 1_600_000,
    ua: BROWSER_UA,
    usefulMax: 260_000,
    signal,
    budget,
  });
  // HTTPS-to-HTTP downgrade is disabled by default. It can expose requests
  // and produces non-equivalent measurements when an HTTPS origin fails.
  if (
    process.env.RANKPROOF_ALLOW_HTTP_FALLBACK === "1" &&
    res.status >= 500 &&
    url.startsWith("https://")
  ) {
    const httpUrl = `http://${url.slice("https://".length)}`;
    try {
      const retry = await fetchText(httpUrl, {
        timeoutMs: Math.min(timeoutMs, 6000),
        maxBytes: 1_600_000,
        ua: BROWSER_UA,
        usefulMax: 260_000,
        signal,
        budget,
      });
      if (retry.status < 400 && retry.text.length > 800) res = retry;
    } catch {
      /* keep first response */
    }
  }
  return res;
}

/** Checks a URL's status without fetching the body (HEAD, falling back to GET). */
export async function probeStatus(
  url: string,
  timeoutMs = 6000,
  signal?: AbortSignal,
): Promise<{ status: number; finalUrl: string } | null> {
  try {
    const head = await fetchText(url, {
      timeoutMs,
      maxBytes: 1,
      method: "HEAD",
      ua: BROWSER_UA,
      signal,
    });
    if (head.status !== 405 && head.status !== 501 && head.status !== 403) {
      return { status: head.status, finalUrl: head.finalUrl };
    }
  } catch {
    /* fall through */
  }
  try {
    const get = await fetchText(url, {
      timeoutMs,
      maxBytes: 40_000,
      ua: BROWSER_UA,
      signal,
    });
    return { status: get.status, finalUrl: get.finalUrl };
  } catch {
    return null;
  }
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx]!, idx);
    }
  }
  const n = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

export type Timed<T> = { ms: number; value?: T; error?: string };

export function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const start = Date.now();
  return fn()
    .then((value) => ({ ms: Date.now() - start, value }))
    .catch((err: unknown) => ({
      ms: Date.now() - start,
      error: normalizeError(err),
    }));
}

export function normalizeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError" || /aborted/i.test(err.message)) {
      return "Przekroczono limit czasu";
    }
    return err.message.slice(0, 160);
  }
  return "Source error";
}

/**
 * A time budget for the whole scan. Serverless platforms enforce hard limits,
 * so later phases shrink rather than break the entire report.
 */
export class Budget {
  readonly start = Date.now();
  private readonly controller = new AbortController();
  private readonly totalMs: number;

  constructor(totalMs: number, outerSignal?: AbortSignal) {
    this.totalMs = totalMs;
    if (outerSignal?.aborted) this.controller.abort();
    else outerSignal?.addEventListener("abort", () => this.controller.abort(), { once: true });
    const timer = setTimeout(() => this.controller.abort(), totalMs);
    if (typeof timer === "object" && timer && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  elapsed(): number {
    return Date.now() - this.start;
  }

  left(): number {
    return Math.max(0, this.totalMs - this.elapsed());
  }

  spent(fraction: number): boolean {
    return this.elapsed() > this.totalMs * fraction;
  }

  /** Scales a work limit to the time remaining. */
  scale(max: number, needMs: number): number {
    const ratio = this.left() / Math.max(needMs, 1);
    if (ratio >= 1) return max;
    return Math.max(0, Math.floor(max * ratio));
  }

  timeout(preferred: number): number {
    return Math.max(1500, Math.min(preferred, this.left()));
  }
}

export function clearNetCache() {
  CACHE.clear();
}
