import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";

import { usefulHtml } from "./html.ts";
import { config } from "./config.ts";
import { diskCache, type CachedResponse } from "./disk-cache.server.ts";
import { guardUrl, guardUrlWithDns, isPrivateAddress } from "./ssrf.ts";
import { isAllowed, robotsFor } from "./robots.server.ts";

export const API_UA = config().apiUserAgent;
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** User agent for page fetches without an explicit one (RANKPROOF_CRAWLER_IDENTITY). */
export function crawlerUserAgent(): string {
  return config().crawlerIdentity === "rankproof" ? config().apiUserAgent : BROWSER_UA;
}

export type FetchResult = {
  status: number;
  text: string;
  finalUrl: string;
  headers: Headers | null;
  fromCache: boolean;
  /** Reading stopped at maxBytes; absence cannot be inferred from this body. */
  truncated?: boolean;
};

const CACHE = new Map<string, FetchResult>();
const CACHE_LIMIT = 400;

/**
 * A simple limiter: at most N parallel requests to a single host.
 *
 * Waiting for a slot is bounded by the request's own deadline and abort signal:
 * a waiter that gives up is removed from the queue, so a stalled host can no
 * longer pin callers forever. robots.txt is fetched with `skipHostLimit`,
 * because a page that holds the last slot may need that host's robots.txt
 * (e.g. after a redirect) — queueing it behind itself was a deadlock.
 */
const HOST_SLOTS = new Map<string, number>();
type HostWaiter = { grant: () => void };
const HOST_QUEUE = new Map<string, HostWaiter[]>();
const HOST_CONCURRENCY = config().hostConcurrency;

export class HostQueueTimeoutError extends Error {
  constructor(host: string) {
    super(`Timed out waiting for a free connection slot to ${host}.`);
    this.name = "HostQueueTimeoutError";
  }
}

export async function acquireHost(
  host: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<() => void> {
  const used = HOST_SLOTS.get(host) ?? 0;
  if (used < HOST_CONCURRENCY) {
    HOST_SLOTS.set(host, used + 1);
    return once(() => releaseHost(host));
  }
  if (opts.signal?.aborted) throw new Error("Request aborted.");
  await new Promise<void>((resolve, reject) => {
    const waiter: HostWaiter = {
      grant: () => {
        cleanup();
        resolve();
      },
    };
    const leave = (error: Error) => {
      const queue = HOST_QUEUE.get(host);
      const index = queue?.indexOf(waiter) ?? -1;
      if (queue && index >= 0) {
        queue.splice(index, 1);
        if (queue.length === 0) HOST_QUEUE.delete(host);
      }
      cleanup();
      reject(error);
    };
    const onAbort = () => leave(new Error("Request aborted."));
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => leave(new HostQueueTimeoutError(host)), Math.max(0, opts.timeoutMs))
        : null;
    function cleanup() {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const queue = HOST_QUEUE.get(host) ?? [];
    queue.push(waiter);
    HOST_QUEUE.set(host, queue);
  });
  // The slot was handed over by releaseHost without decrementing the count.
  return once(() => releaseHost(host));
}

function releaseHost(host: string) {
  const queue = HOST_QUEUE.get(host);
  if (queue && queue.length > 0) {
    const next = queue.shift();
    if (queue.length === 0) HOST_QUEUE.delete(host);
    next?.grant();
    return;
  }
  const used = HOST_SLOTS.get(host) ?? 1;
  if (used <= 1) HOST_SLOTS.delete(host);
  else HOST_SLOTS.set(host, used - 1);
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

/** Test hook: current slot usage and queue length for a host. */
export function hostQueueStateForTests(host: string): { used: number; waiting: number } {
  return { used: HOST_SLOTS.get(host) ?? 0, waiting: HOST_QUEUE.get(host)?.length ?? 0 };
}

/**
 * The cache key must include language and user-agent: the same SERP URL returns
 * different results for another market and for the mobile version.
 */
function cacheKey(url: string, method: string, opts: FetchOptions): string {
  return `${method} ${url} ${opts.acceptLanguage ?? ""} ${opts.ua ?? ""}`;
}

function remember(key: string, value: FetchResult) {
  if (CACHE.size >= CACHE_LIMIT) {
    const first = CACHE.keys().next().value;
    if (first) CACHE.delete(first);
  }
  CACHE.set(key, value);
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
  /** Bypasses the per-host limiter (robots.txt only — see acquireHost). */
  skipHostLimit?: boolean;
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
/** The same static + DNS policy as every crawler hop, for callers outside fetchText (the renderer). */
export async function checkPublicUrl(url: string): Promise<{ allowed: boolean; reason?: string }> {
  const verdict = await guardUrlWithDns(url, resolveHost);
  return verdict.allowed ? { allowed: true } : { allowed: false, reason: verdict.reason };
}

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
    body?: Buffer | null;
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
        // Without these two the promise never settles when the peer resets or
        // truncates after the headers: 'end' simply never fires, and neither
        // the request timeout nor the abort signal applies any more.
        res.on("error", reject);
        res.on("aborted", () => reject(new Error("Response aborted by the server.")));
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > init.maxBytes) {
            res.destroy(new Error("Response exceeds the verification size limit."));
          } else chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            const headerInit: [string, string][] = [];
            for (const [key, value] of Object.entries(res.headers)) {
              if (value === undefined) continue;
              if (Array.isArray(value)) {
                for (const item of value) headerInit.push([key, item]);
              } else headerInit.push([key, value]);
            }
            const status = res.statusCode ?? 0;
            const nullBody = status === 204 || status === 205 || status === 304;
            resolve(
              new Response(nullBody ? null : Buffer.concat(chunks), {
                status,
                statusText: res.statusMessage,
                headers: headerInit,
              }),
            );
          } catch (error) {
            // Event callbacks run outside the Promise executor. Construction
            // failures must reject this request, never crash the API process.
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(init.body && init.body.length > 0 ? init.body : undefined);
  });
}

/** Request headers the network layer sets itself; never copied from the browser. */
const HOP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "keep-alive",
  "proxy-connection",
  "upgrade",
]);

/**
 * One request, no redirects followed, connected to an address that passed the
 * static + DNS policy (Host/SNI preserved). The renderer uses this to answer
 * every browser request itself, so Chromium never resolves or connects on its
 * own and a DNS answer cannot change between the check and the connection.
 * Redirects are returned to the caller (the browser), whose next request comes
 * back through here and is checked again.
 */
export async function pinnedFetch(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer | null;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const addresses = await assertFetchable(url);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(init.headers ?? {})) {
    if (!HOP_HEADERS.has(key.toLowerCase()) && !key.startsWith(":")) headers[key] = value;
  }
  // Uncompressed bodies: the browser receives exactly the bytes we read.
  headers["Accept-Encoding"] = "identity";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000);
  try {
    const response = await pinnedRequest(url, addresses, {
      method: init.method ?? "GET",
      headers,
      body: init.body ?? null,
      signal: controller.signal,
      maxBytes: init.maxBytes ?? 5_000_000,
    });
    const out: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (key === "content-encoding" || key === "content-length" || key === "transfer-encoding") {
        return;
      }
      out[key] = value;
    });
    return {
      status: response.status,
      headers: out,
      body: Buffer.from(await response.arrayBuffer()),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Delays imposed by a host's Crawl-delay directive, tracked per origin. */
const NEXT_ALLOWED_AT = new Map<string, number>();

const MAX_CRAWL_DELAY_WAIT_MS = 10_000;

async function respectCrawlDelay(origin: string, delaySeconds: number | null): Promise<void> {
  if (!delaySeconds || delaySeconds <= 0) return;
  const now = Date.now();
  const earliest = NEXT_ALLOWED_AT.get(origin) ?? 0;
  // The wait is capped so one hostile Crawl-delay cannot stall a whole scan —
  // but then the reservation has to advance by what we actually waited, not by
  // the full delay. Otherwise every queued request after the first fires early
  // and the site is hit harder than its robots.txt asked for.
  const requested = Math.max(0, earliest - now);
  const wait = Math.min(requested, MAX_CRAWL_DELAY_WAIT_MS);
  const step = Math.min(delaySeconds * 1000, MAX_CRAWL_DELAY_WAIT_MS);
  NEXT_ALLOWED_AT.set(origin, now + wait + step);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

export async function fetchText(url: string, opts: FetchOptions): Promise<FetchResult> {
  const method = opts.method ?? "GET";
  const key = cacheKey(url, method, opts);
  if (opts.cache !== false) {
    const hit = CACHE.get(key);
    if (hit) return { ...hit, fromCache: true };
  }

  // Fail closed: an unparseable or non-public URL never reaches the network.
  const staticVerdict = guardUrl(url);
  if (!staticVerdict.allowed) throw new BlockedUrlError(staticVerdict.reason);

  let host = "";
  let origin = "";
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    origin = parsed.origin;
  } catch {
    throw new BlockedUrlError("Malformed source URL.");
  }

  // robots.txt applies to pages we crawl, not to SERP or API lookups.
  let crawlDelay: number | null = null;
  if (!opts.skipRobots && opts.budget) {
    const rules = await robotsFor(origin, opts.budget);
    if (!isAllowed(rules, new URL(url).pathname + new URL(url).search))
      throw new RobotsDisallowedError(url);
    crawlDelay = rules.crawlDelay;
  }

  const cache = diskCache();
  const cacheable = method === "GET" && opts.cache !== false && cache.enabled;
  const stored: CachedResponse | null = cacheable ? await cache.get(key) : null;

  const queuedAt = Date.now();
  const release = opts.skipHostLimit
    ? () => {}
    : await acquireHost(host, { signal: opts.signal, timeoutMs: opts.timeoutMs });
  await respectCrawlDelay(origin, crawlDelay);

  const controller = new AbortController();
  // Time spent queueing for a slot counts against the request deadline.
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, opts.timeoutMs - (Date.now() - queuedAt)),
  );
  const onOuterAbort = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort);

  try {
    let current = url;
    let res: Response | null = null;

    // Manual redirect handling so the guard sees every hop. Set
    // RANKPROOF_PIN_DNS=1 to connect via the validated IP (Host/SNI preserved)
    // and close the DNS-rebinding TOCTOU window; default uses fetch so test
    // doubles that stub globalThis.fetch keep working.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (controller.signal.aborted) throw new Error("Request aborted.");
      const addresses = await assertFetchable(current);
      if (hop > 0 && !opts.skipRobots && opts.budget) {
        const redirected = new URL(current);
        const rules = await robotsFor(redirected.origin, opts.budget);
        if (!isAllowed(rules, redirected.pathname + redirected.search)) {
          throw new RobotsDisallowedError(current);
        }
        await respectCrawlDelay(redirected.origin, rules.crawlDelay);
      }
      const headers = {
        "User-Agent": opts.ua ?? crawlerUserAgent(),
        Accept: opts.accept ?? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": opts.acceptLanguage ?? "en,pl;q=0.8",
        ...cache.conditionalHeaders(stored),
        ...opts.headers,
      };
      const response =
        process.env.RANKPROOF_PIN_DNS === "1" || process.env.SERPRADAR_PIN_DNS === "1"
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
        current = new URL(location, current).href;
        continue;
      }
      res = response;
      break;
    }

    if (!res) throw new Error("No response received.");

    // 304: the stored body is still valid, so nothing crosses the wire.
    if (res.status === 304 && stored) {
      const result: FetchResult = {
        status: stored.status,
        text: stored.text,
        finalUrl: stored.finalUrl,
        headers: res.headers,
        fromCache: true,
      };
      if (opts.cache !== false) remember(key, result);
      return result;
    }

    if (method === "HEAD") {
      const result: FetchResult = {
        status: res.status,
        text: "",
        finalUrl: res.url || current,
        headers: res.headers,
        fromCache: false,
      };
      if (opts.cache !== false) remember(key, result);
      return result;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (/^(image|video|audio|font)\//i.test(contentType)) {
      const result: FetchResult = {
        status: res.status,
        text: "",
        finalUrl: res.url || current,
        headers: res.headers,
        fromCache: false,
      };
      if (opts.cache !== false) remember(key, result);
      return result;
    }

    const reader = res.body?.getReader();
    let text = "";
    let truncated = false;
    if (!reader) {
      const full = await res.text();
      truncated = Buffer.byteLength(full) >= opts.maxBytes;
      text = full.slice(0, opts.maxBytes);
    } else {
      const decoder = new TextDecoder("utf-8", { fatal: false });
      let received = 0;
      while (received < opts.maxBytes) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        received += value.byteLength;
        text += decoder.decode(value, { stream: true });
        if (
          opts.usefulMax &&
          received > 60_000 &&
          usefulHtml(text, opts.usefulMax).length >= opts.usefulMax
        ) {
          break;
        }
      }
      truncated = received >= opts.maxBytes;
      text += decoder.decode();
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }

    if (opts.usefulMax) text = usefulHtml(text, opts.usefulMax);
    else if (text.length > opts.maxBytes) text = text.slice(0, opts.maxBytes);

    const finalUrl = res.url || current;
    const result: FetchResult = {
      status: res.status,
      text,
      truncated,
      finalUrl,
      headers: res.headers,
      fromCache: false,
    };
    if (opts.cache !== false) remember(key, result);
    if (cacheable) {
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
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
    release();
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
  if (res.status >= 500 && url.startsWith("https://")) {
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

  constructor(totalMs: number) {
    this.totalMs = totalMs;
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
