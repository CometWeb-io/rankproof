/**
 * Optional rendered verification in headless Chromium (Playwright).
 *
 * Why: fetched HTML cannot see links inserted by JavaScript, and cannot tell
 * that a link present in the HTML is hidden with CSS. The renderer answers
 * both, as a *second, separately labelled* observation — it never overwrites
 * what the fetched HTML said.
 *
 * Safety model:
 *   - Opt-in. `playwright` is an optional dependency; nothing launches unless a
 *     caller asks for rendering (CLI `--render`, or a server started with
 *     RANKPROOF_RENDER=1).
 *   - Every request the page makes — document, script, XHR, redirect hop — is
 *     intercepted and checked with the same public-URL policy as the crawler
 *     (scheme, private/metadata ranges, DNS). Failing requests are aborted.
 *     Images, media and fonts are never loaded. Service workers are blocked;
 *     WebSockets (which context.route does not see) are closed by a
 *     routeWebSocket handler before any connection to the server is made.
 *     No single response is buffered beyond 5 MB.
 *   - With RANKPROOF_PIN_DNS=1, Chromium makes no connections of its own:
 *     every allowed request is performed by Node (pinnedFetch — validated IP,
 *     Host/SNI preserved, one hop at a time) and handed to the browser with
 *     route.fulfill, closing the DNS-rebinding window. The browser is also
 *     launched behind a proxy that refuses every connection, so nothing that
 *     escapes the interceptor reaches the network. Without pinning the browser
 *     connects itself after the check; isolate its network then.
 *   - At most RANKPROOF_RENDER_CONCURRENCY browsers (default 1) run at once in
 *     the process; further render batches wait for a slot within their budget.
 *   - A page whose final URL lands on the target's own site is an internal
 *     link and an error, as in the fetched path.
 *   - Snapshot mode (replay, benchmark) serves the captured HTML for the source
 *     URL and aborts every other request: only inline scripts run, offline.
 *   - No challenge solving: bot-protection pages stay errors.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { LinkPlacement } from "./types.ts";
import { hostFromUrl, isTargetHost } from "./parse.ts";

export const RENDER_VERSION = "chromium-dom-v1";

export type RenderedAnchor = {
  resolved_href: string;
  anchor: string;
  rel: string;
  /** Laid out and not hidden by display, visibility, opacity, size or clipping. */
  visible: boolean;
  placement: LinkPlacement;
};

export type RenderedObservation = {
  status: "confirmed" | "not_found" | "error";
  method: "rendered_dom";
  render_version: typeof RENDER_VERSION;
  engine: string | null;
  rendered_at: string;
  final_url: string | null;
  http_status: number | null;
  /** SHA-256 of the serialised DOM after scripts ran. */
  dom_hash: string | null;
  reason: string | null;
  /** True when at least one matching anchor is visible to a visitor. */
  visible: boolean | null;
  matching_anchors: RenderedAnchor[];
  /** Requests the page tried that the URL policy refused (counts only). */
  blocked_requests: number;
  /** Of those, scripts, XHR/fetch and frames — content they would add is unknown. */
  blocked_script_requests: number;
};

export type RenderJob = {
  source_url: string;
  target_url: string;
  /** Snapshot mode: serve this HTML for the source URL and allow nothing else. */
  snapshot?: { html: string; status?: number; final_url?: string };
};

type UrlPolicy = (url: string) => Promise<{ allowed: boolean; reason?: string }>;

/** Answers one browser request from Node (see pinnedFetch). */
export type RenderFetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Buffer | null; timeoutMs: number },
) => Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;

/** RANKPROOF_PIN_DNS=1 routes rendering through the pinned network layer too. */
const MAX_RENDER_REDIRECTS = 5;
/** Same ceiling as pinnedFetch: no single browser response is buffered beyond it. */
export const MAX_RENDER_RESPONSE_BYTES = 5_000_000;
/**
 * Pinned mode gives Chromium a proxy that refuses every connection, so a
 * request that somehow escapes the interceptor (or a WebSocket) cannot reach
 * the network on its own. Fulfilled routes never touch the proxy.
 */
const DEAD_PROXY = "http://127.0.0.1:9";

type Route = Parameters<Parameters<Awaited<ReturnType<Browser["newContext"]>>["route"]>[1]>[0];

/** One request through Playwright's network stack, redirects not followed. */
async function viaPlaywright(
  route: Route,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer | null,
  timeoutMs: number,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const response = await route.fetch({
    url,
    method,
    headers,
    postData: body ?? undefined,
    maxRedirects: 0,
    timeout: timeoutMs,
  });
  try {
    // Playwright's driver has already read the body; refuse it before it is
    // copied into this process, and never hand an oversized body to the page.
    const declared = Number(response.headers()["content-length"] ?? "");
    if (Number.isFinite(declared) && declared > MAX_RENDER_RESPONSE_BYTES) {
      throw new Error("Response exceeds the verification size limit.");
    }
    const payload = await response.body();
    if (payload.length > MAX_RENDER_RESPONSE_BYTES) {
      throw new Error("Response exceeds the verification size limit.");
    }
    return { status: response.status(), headers: responseHeaders(response), body: payload };
  } finally {
    await response.dispose().catch(() => {});
  }
}

function responseHeaders(response: {
  headersArray(): { name: string; value: string }[];
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of response.headersArray()) {
    const key = name.toLowerCase();
    if (key === "content-encoding" || key === "content-length" || key === "transfer-encoding") {
      continue;
    }
    out[key] = out[key] ? `${out[key]}\n${value}` : value;
  }
  return out;
}

export function pinnedRenderingEnabled(): boolean {
  return process.env.RANKPROOF_PIN_DNS === "1" || process.env.SERPRADAR_PIN_DNS === "1";
}

const SYSTEM_BROWSERS = [
  process.env.RANKPROOF_CHROMIUM_PATH,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter((path): path is string => Boolean(path));

type Playwright = typeof import("playwright");
type Browser = Awaited<ReturnType<Playwright["chromium"]["launch"]>>;

async function loadPlaywright(): Promise<Playwright> {
  try {
    return await import("playwright");
  } catch {
    throw new RenderUnavailableError(
      "Rendering needs the optional `playwright` package: npm install playwright && npx playwright install chromium",
    );
  }
}

export class RenderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderUnavailableError";
  }
}

/** Launch Playwright's own Chromium, or fall back to a system Chrome/Chromium. */
export async function launchBrowser(options: { pinned?: boolean } = {}): Promise<Browser> {
  const { chromium } = await loadPlaywright();
  const args = [
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    // No speculative DNS lookups or preconnects outside the request interceptor.
    "--dns-prefetch-disable",
    "--disable-features=NetworkPrediction",
  ];
  const errors: string[] = [];
  const candidates: (string | undefined)[] = process.env.RANKPROOF_CHROMIUM_PATH
    ? SYSTEM_BROWSERS
    : [undefined, ...SYSTEM_BROWSERS];
  for (const executablePath of candidates) {
    if (executablePath && !existsSync(executablePath)) continue;
    try {
      return await chromium.launch({
        headless: true,
        executablePath,
        args,
        // Playwright also proxies loopback when a proxy is set, so nothing bypasses it.
        proxy: options.pinned ? { server: DEAD_PROXY } : undefined,
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message.split("\n")[0]! : String(error));
    }
  }
  throw new RenderUnavailableError(
    `No usable Chromium. Run \`npx playwright install chromium\` or set RANKPROOF_CHROMIUM_PATH. (${errors[0] ?? "not found"})`,
  );
}

/** Simple FIFO semaphore: at most `limit` callers run `fn` at the same time. */
export function createLimiter(limit: number) {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active < max) active += 1;
    // A released slot is handed straight to the next waiter (active unchanged).
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

/** RANKPROOF_RENDER_CONCURRENCY: Chromium instances allowed at once (default 1, max 8). */
export function readRenderConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RANKPROOF_RENDER_CONCURRENCY?.trim();
  if (!raw) return 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, 8);
}

let browserSlots: ReturnType<typeof createLimiter> | null = null;
/** Process-wide: every render batch launches its browser inside one of these slots. */
function withBrowserSlot<T>(fn: () => Promise<T>): Promise<T> {
  browserSlots ??= createLimiter(readRenderConcurrency());
  return browserSlots(fn);
}

/** Cheap capability probe for /health and the UI. Cached for the process. */
let availability: Promise<{ ok: boolean; engine: string | null; reason: string | null }> | null =
  null;
export function renderAvailability() {
  availability ??= (async () => {
    try {
      const browser = await launchBrowser();
      const engine = `chromium ${browser.version()}`;
      await browser.close();
      return { ok: true, engine, reason: null };
    } catch (error) {
      return {
        ok: false,
        engine: null,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  })();
  return availability;
}

function exactUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  return url.href;
}

/** Runs in the page: every anchor with its resolved href, text, rel, visibility and region. */
function collectAnchors(): {
  href: string;
  text: string;
  rel: string;
  visible: boolean;
  placement: string;
}[] {
  const regionOf = (el: Element): string => {
    if (el.closest("[class*='comment' i], [id*='comment' i]")) return "comment";
    if (el.closest("footer, [role='contentinfo'], .footer, #footer")) return "footer";
    if (el.closest("nav, header, [role='navigation'], [role='banner'], .menu, .navbar"))
      return "navigation";
    if (el.closest("aside, [role='complementary'], .sidebar, .widget")) return "sidebar";
    if (el.closest("article, main, [role='main'], .entry-content, .post-content")) return "content";
    return "unknown";
  };
  const isVisible = (el: HTMLElement): boolean => {
    const check = (el as HTMLElement & { checkVisibility?: (o: object) => boolean })
      .checkVisibility;
    if (check && !check.call(el, { checkOpacity: true, checkVisibilityCSS: true })) return false;
    const rects = el.getClientRects();
    if (rects.length === 0) return false;
    let area = 0;
    for (const rect of Array.from(rects)) area += rect.width * rect.height;
    if (area < 1) {
      // An image link's area lives on the child.
      const media = el.querySelector("img, svg");
      if (!media) return false;
      const r = media.getBoundingClientRect();
      if (r.width * r.height < 1) return false;
    }
    const style = getComputedStyle(el);
    if (parseFloat(style.fontSize) === 0 && !el.querySelector("img, svg")) return false;
    // Pushed far off-screen is a classic hiding trick.
    const box = el.getBoundingClientRect();
    if (box.right < -1000 || box.bottom < -1000) return false;
    return true;
  };
  return Array.from(document.querySelectorAll("a[href]")).map((node) => {
    const a = node as HTMLAnchorElement;
    const img = a.querySelector("img[alt]") as HTMLImageElement | null;
    const text = (
      a.innerText ||
      a.textContent ||
      img?.alt ||
      a.getAttribute("aria-label") ||
      a.title ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    return {
      href: a.href,
      text,
      rel: a.getAttribute("rel") ?? "",
      visible: isVisible(a),
      placement: regionOf(a),
    };
  });
}

const CHALLENGE =
  /just a moment|attention required|verify (?:that )?you are (?:a )?human|cf-chl-|challenge-platform/i;

async function renderOne(
  browser: Browser,
  job: RenderJob,
  policy: UrlPolicy,
  timeoutMs: number,
  fetcher: RenderFetcher | null = null,
): Promise<RenderedObservation> {
  const result: RenderedObservation = {
    status: "error",
    method: "rendered_dom",
    render_version: RENDER_VERSION,
    engine: `chromium ${browser.version()}`,
    rendered_at: new Date().toISOString(),
    final_url: null,
    http_status: null,
    dom_hash: null,
    reason: null,
    visible: null,
    matching_anchors: [],
    blocked_requests: 0,
    blocked_script_requests: 0,
  };
  const SCRIPTED = new Set(["script", "xhr", "fetch", "document", "eventsource"]);
  const block = (type: string) => {
    result.blocked_requests += 1;
    if (SCRIPTED.has(type)) result.blocked_script_requests += 1;
  };
  let navigationRefused: string | null = null;
  let pendingRedirect: string | null = null;
  const context = await browser.newContext({
    javaScriptEnabled: true,
    serviceWorkers: "block",
    acceptDownloads: false,
    viewport: { width: 1366, height: 900 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 RankProof-render",
  });
  try {
    const source = exactUrl(job.source_url);
    // context.route never sees WebSockets: refuse them here, without ever
    // connecting to the server (no connectToServer()).
    await context.routeWebSocket(/.*/, (ws) => {
      block("websocket");
      ws.close();
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = request.url();
      const type = request.resourceType();
      if (type === "image" || type === "media" || type === "font" || type === "websocket") {
        return route.abort();
      }
      if (job.snapshot) {
        if (request.isNavigationRequest() && exactUrl(url) === source) {
          return route.fulfill({
            status: job.snapshot.status ?? 200,
            contentType: "text/html; charset=utf-8",
            body: job.snapshot.html,
          });
        }
        block(type);
        return route.abort();
      }
      if (!/^https?:/i.test(url)) {
        block(type);
        return route.abort();
      }
      const isMainNavigation =
        request.isNavigationRequest() && request.frame() === request.frame().page().mainFrame();
      const refuse = (reason: string) => {
        block(type);
        if (isMainNavigation) navigationRefused = reason;
        return route.abort();
      };
      const allowed = async (candidate: string) =>
        (await policy(candidate).catch(() => ({
          allowed: false,
          reason: "policy check failed",
        }))) as {
          allowed: boolean;
          reason?: string;
        };
      const first = await allowed(url);
      if (!first.allowed) return refuse(first.reason ?? "address not allowed");
      // Chromium never follows a redirect on its own: a followed hop would
      // skip this check (Playwright does not route it again). A main-frame
      // redirect is re-navigated by renderOne, so the next hop comes back here;
      // subresource redirects are followed here, each hop checked.
      let hopUrl = url;
      let method = request.method();
      let body = request.postDataBuffer();
      const headers = await request.allHeaders();
      try {
        for (let hop = 0; ; hop++) {
          const answer = fetcher
            ? await fetcher(hopUrl, { method, headers, body, timeoutMs })
            : await viaPlaywright(route, hopUrl, method, headers, body, timeoutMs);
          const location =
            answer.status >= 300 && answer.status < 400 ? answer.headers["location"] : undefined;
          if (!location) {
            return route.fulfill({
              status: answer.status,
              headers: answer.headers,
              body: answer.body,
            });
          }
          const next = new URL(location, hopUrl).href;
          if (isMainNavigation) {
            // 204 leaves the page where it is (no error page); renderOne
            // then navigates to the next hop, which comes back through here.
            pendingRedirect = next;
            return route.fulfill({ status: 204, body: "" });
          }
          if (hop >= MAX_RENDER_REDIRECTS) return refuse("too many redirects");
          const verdict = await allowed(next);
          if (!verdict.allowed) return refuse(verdict.reason ?? "redirect target not allowed");
          if (
            answer.status === 303 ||
            ((answer.status === 301 || answer.status === 302) && method === "POST")
          ) {
            method = "GET";
            body = null;
          }
          hopUrl = next;
        }
      } catch (error) {
        return refuse(
          `${fetcher ? "pinned request failed" : "request failed"}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
        );
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    let navigateTo = job.source_url;
    let response: Awaited<ReturnType<typeof page.goto>> = null;
    for (let hop = 0; ; hop++) {
      pendingRedirect = null;
      try {
        response = await page.goto(navigateTo, { waitUntil: "load", timeout: timeoutMs });
      } catch (error) {
        // The 204 answer to a redirect aborts this goto; anything else is real.
        if (!pendingRedirect || navigationRefused) throw error;
      }
      if (!pendingRedirect) break;
      if (hop >= MAX_RENDER_REDIRECTS) {
        navigationRefused = "too many redirects";
        throw new Error("too many redirects");
      }
      navigateTo = pendingRedirect;
    }
    // Give late scripts a short, bounded window to insert content.
    await page
      .waitForLoadState("networkidle", { timeout: Math.min(3000, timeoutMs) })
      .catch(() => {});
    result.final_url = page.url();
    result.http_status = response?.status() ?? null;
    // Same rule as the fetched path: a page on the target's own site is an
    // internal link, whatever anchors it carries.
    if (isTargetHost(hostFromUrl(result.final_url), hostFromUrl(job.target_url))) {
      result.reason = "Source redirected into the target site; this is an internal link.";
      return result;
    }
    const title = await page.title().catch(() => "");
    const html = await page.content();
    result.dom_hash = createHash("sha256").update(html).digest("hex");
    if (result.http_status !== null && (result.http_status < 200 || result.http_status >= 300)) {
      result.reason = `Rendered page returned HTTP ${result.http_status}.`;
      return result;
    }
    if (CHALLENGE.test(title) || CHALLENGE.test(html.slice(0, 20_000))) {
      result.reason = "The rendered page is a bot challenge; RankProof does not solve challenges.";
      return result;
    }
    const target = exactUrl(job.target_url);
    const anchors = (await page.evaluate(collectAnchors)).filter((a) => {
      try {
        return exactUrl(a.href) === target;
      } catch {
        return false;
      }
    });
    result.matching_anchors = anchors.slice(0, 50).map((a) => ({
      resolved_href: a.href.slice(0, 2048),
      anchor: a.text,
      rel: a.rel.slice(0, 512),
      visible: a.visible,
      placement: a.placement as LinkPlacement,
    }));
    if (result.matching_anchors.length > 0) {
      result.status = "confirmed";
      result.visible = result.matching_anchors.some((a) => a.visible);
    } else {
      // An empty page after rendering means scripts failed or were blocked:
      // that cannot establish absence.
      const readable = await page
        .evaluate(() => (document.body?.innerText ?? "").trim().length)
        .catch(() => 0);
      if (readable === 0) {
        result.reason =
          "The rendered page has no readable content (its scripts failed or were blocked).";
        return result;
      }
      result.status = "not_found";
      result.reason = "No anchor to the exact target URL in the rendered DOM.";
    }
    return result;
  } catch (error) {
    result.reason = navigationRefused
      ? `The URL policy refused the page or one of its redirects: ${navigationRefused}`
      : `Rendering failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
    return result;
  } finally {
    result.rendered_at = new Date().toISOString();
    await context.close().catch(() => {});
  }
}

export function skipped(reason: string): RenderedObservation {
  return {
    status: "error",
    method: "rendered_dom",
    render_version: RENDER_VERSION,
    engine: null,
    rendered_at: new Date().toISOString(),
    final_url: null,
    http_status: null,
    dom_hash: null,
    reason,
    visible: null,
    matching_anchors: [],
    blocked_requests: 0,
    blocked_script_requests: 0,
  };
}

/** Renders jobs with a small worker pool on one browser. */
export async function renderObserve(
  jobs: RenderJob[],
  options: {
    policy?: UrlPolicy;
    timeoutMs?: number;
    concurrency?: number;
    /** Whole-batch ceiling; jobs not started in time become errors, never absences. */
    budgetMs?: number;
    /**
     * Answers browser requests from Node instead of letting Chromium connect.
     * Default: pinnedFetch when RANKPROOF_PIN_DNS=1, otherwise none.
     */
    fetcher?: RenderFetcher | null;
  } = {},
): Promise<RenderedObservation[]> {
  const deadline = Date.now() + (options.budgetMs ?? 90_000);
  if (jobs.length === 0) return [];
  const policy =
    options.policy ??
    (async (url: string) => {
      const { checkPublicUrl } = await import("./net.server.ts");
      return checkPublicUrl(url);
    });
  let fetcher = options.fetcher ?? null;
  if (options.fetcher === undefined && pinnedRenderingEnabled()) {
    const { pinnedFetch } = await import("./net.server.ts");
    fetcher = (url, init) => pinnedFetch(url, init);
  }
  return withBrowserSlot(async () => {
    if (Date.now() > deadline - 2000) {
      return jobs.map(() => skipped("Render time budget exhausted while waiting for a browser."));
    }
    const browser = await launchBrowser({ pinned: fetcher !== null });
    try {
      return await renderJobs(browser, jobs, policy, fetcher, deadline, options);
    } finally {
      await browser.close().catch(() => {});
    }
  });
}

async function renderJobs(
  browser: Browser,
  jobs: RenderJob[],
  policy: UrlPolicy,
  fetcher: RenderFetcher | null,
  deadline: number,
  options: { timeoutMs?: number; concurrency?: number },
): Promise<RenderedObservation[]> {
  const out: RenderedObservation[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(options.concurrency ?? 2, jobs.length) },
    async () => {
      while (next < jobs.length) {
        const index = next++;
        const left = deadline - Date.now();
        if (left < 2000) {
          out[index] = skipped("Render time budget exhausted before this page was opened.");
          continue;
        }
        out[index] = await renderOne(
          browser,
          jobs[index]!,
          policy,
          Math.min(options.timeoutMs ?? 15_000, left),
          fetcher,
        );
      }
    },
  );
  await Promise.all(workers);
  return out;
}
