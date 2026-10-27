import { captureSafeUrl } from "./evidence-capture.ts";
import { assertUtf8HtmlEncoding } from "./evidence-response.ts";
import { createHash } from "node:crypto";
import {
  extractCanonical,
  extractRobotsMeta,
  extractTitle,
  parseAnchors,
  parseRobotsSitemaps,
  parseSitemap,
  parseXRobotsTag,
  isSitemapIndex,
  decodeAttribute,
  documentBase,
  stripTags,
} from "./html.ts";
import { tokenizeHtml } from "./html-tokenizer.ts";
import {
  buildTechnicalGraph,
  type GraphInventory,
  type GraphRedirect,
  type GraphObservation,
  type TechnicalGraphReport,
} from "./technical-graph.ts";
import { hostFromUrl, isTargetHost, normalizeUrl, pathOf } from "./parse.ts";
import { Budget, fetchUsefulHtml, fetchText, mapLimit } from "./net.server.ts";
import { isAllowed, robotsFor } from "./robots.server.ts";
import type { Backlink, InternalPage, SiteAudit, SiteIssue } from "./types.ts";

/**
 * Audit of the site itself.
 *
 * Crawl discovers reachability and depth from the homepage. Orphan detection
 * needs a separate inventory (sitemap + optional known URLs from GSC/CMS):
 * pages that exist in the inventory but are never reached by the internal
 * link graph are orphan *candidates*. A page discovered only via crawl can
 * never be a true orphan — something linked to it.
 */

const MAX_PAGES = 120;
const SKIP_EXT = /\.(?:jpg|jpeg|png|gif|webp|svg|ico|css|js|pdf|zip|mp4|mp3|woff2?)$/i;

type CrawlPage = {
  url: string;
  requestedUrl?: string;
  path: string;
  status: number;
  finalUrl: string;
  title: string | null;
  canonical: string | null;
  noindex: boolean;
  nofollow: boolean;
  internalLinks: string[];
  crawlLinks?: string[];
  externalLinks: number;
  depth: number;
  /** Number of hops the server made before serving this page. */
  redirected: boolean;
  bytes: number;
  observation?: GraphObservation;
};

export type SiteAuditOptions = {
  /** Extra known URLs (GSC pages, CMS export). Merged into orphan inventory. */
  knownUrls?: string[];
  /** Inventory provenance for graph analysis; legacy knownUrls remain 'supplied'. */
  inventories?: GraphInventory[];
};

type CrawlCoverage = {
  frontierExhausted: boolean;
  blockedUrls: string[];
  failedUrls: string[];
  redactedUrlCount?: number;
  redirects?: GraphRedirect[];
  effectiveRootUrl?: string;
};

function shouldCrawl(url: string, origin: string): boolean {
  if (new URL(url).origin !== origin || !captureSafeUrl(normalizeUrl(url))) return false;
  const path = new URL(url).pathname;
  if (SKIP_EXT.test(path)) return false;
  if (/\/(wp-admin|wp-json|cart|checkout|koszyk|login|logout|signin)\b/i.test(path)) return false;
  return true;
}

/**
 * Breadth-first crawl from the home page. Breadth-first matters: it gives
 * each page its true click depth, which a depth-first walk would distort.
 */
async function crawl(
  startUrl: string,
  host: string,
  budget: Budget,
  limit: number,
  coverage?: CrawlCoverage,
): Promise<CrawlPage[]> {
  if (!captureSafeUrl(normalizeUrl(startUrl))) throw new Error("Unsafe crawl root URL.");
  const seen = new Set<string>();
  const pages: CrawlPage[] = [];
  let frontier: { url: string; depth: number }[] = [{ url: normalizeUrl(startUrl), depth: 0 }];
  seen.add(normalizeUrl(startUrl));

  let origin = new URL(startUrl).origin;
  let rules = await robotsFor(origin, budget);

  while (frontier.length > 0 && pages.length < limit && !budget.spent(0.85)) {
    const wave = frontier.slice(0, Math.min(12, limit - pages.length));
    frontier = frontier.slice(wave.length);

    const results = await mapLimit(wave, 3, async (item) => {
      if (budget.left() < 3000) {
        coverage?.failedUrls.push(item.url);
        return null;
      }
      if (!isAllowed(rules, pathOf(item.url))) {
        coverage?.blockedUrls.push(item.url);
        return null;
      }
      try {
        const res = await fetchUsefulHtml(
          item.url,
          budget.timeout(7000),
          budget.signal,
          budget,
          (hop) => {
            const target = normalizeUrl(hop.to);
            if (!captureSafeUrl(target)) {
              if (coverage) coverage.redactedUrlCount = (coverage.redactedUrlCount ?? 0) + 1;
              throw new Error("Unsafe crawl redirect target.");
            }
            coverage?.redirects?.push({ ...hop, from: normalizeUrl(hop.from), to: target });
            const bootstrap = item.depth === 0 && item.url === normalizeUrl(startUrl);
            if (
              new URL(target).origin !== origin &&
              !(bootstrap && isTargetHost(hostFromUrl(target), hostFromUrl(startUrl)))
            )
              throw new Error("Crawl redirect exceeds origin scope.");
          },
        );
        const documentUrl = normalizeUrl(res.finalUrl);
        if (
          item.depth === 0 &&
          item.url === normalizeUrl(startUrl) &&
          captureSafeUrl(documentUrl) &&
          isTargetHost(hostFromUrl(documentUrl), hostFromUrl(startUrl))
        ) {
          origin = new URL(documentUrl).origin;
          rules = await robotsFor(origin, budget);
          if (coverage) coverage.effectiveRootUrl = documentUrl;
        }
        if (res.status >= 400) {
          coverage?.failedUrls.push(item.url);
          return {
            url: documentUrl,
            requestedUrl: item.url,
            path: pathOf(documentUrl),
            status: res.status,
            finalUrl: res.finalUrl,
            title: null,
            canonical: null,
            noindex: false,
            nofollow: false,
            internalLinks: [],
            externalLinks: 0,
            depth: item.depth,
            redirected: normalizeUrl(res.finalUrl) !== item.url,
            bytes: res.text.length,
          } satisfies CrawlPage;
        }

        if (
          new URL(res.finalUrl).origin !== origin ||
          !captureSafeUrl(normalizeUrl(res.finalUrl))
        ) {
          coverage?.failedUrls.push(item.url);
          return null;
        }
        const contentType = res.headers?.get("content-type") ?? "";
        if (
          res.status < 200 ||
          res.status >= 300 ||
          !res.text.trim() ||
          res.truncated ||
          !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)
        ) {
          coverage?.failedUrls.push(item.url);
          return null;
        }
        const document = tokenizeHtml(res.text, true);
        assertUtf8HtmlEncoding(res.text, contentType, document);
        if (
          /^(?:just a moment|access denied|attention required)/i.test(
            stripTags(document.title ?? "").trim(),
          ) ||
          /challenge-platform|cf-browser-verification|cf-chl-|verify (?:that )?you are (?:a )?human|please (?:enable|turn on) javascript/i.test(
            res.text,
          )
        ) {
          coverage?.blockedUrls.push(item.url);
          return null;
        }
        const base = documentBase(document, res.finalUrl);
        const anchors = parseAnchors(res.text, base, { exact: true, document });
        const internal: string[] = [];
        const crawlLinks: string[] = [];
        let external = 0;
        for (const anchor of anchors) {
          const parsed = new URL(anchor.href);
          if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) continue;
          const target = normalizeUrl(anchor.href);
          if (!captureSafeUrl(target)) {
            if (coverage) coverage.redactedUrlCount = (coverage.redactedUrlCount ?? 0) + 1;
            continue;
          }
          if (parsed.origin === origin) {
            internal.push(target);
            if (shouldCrawl(target, origin)) crawlLinks.push(target);
            else coverage?.blockedUrls.push(target);
          } else {
            external += 1;
          }
        }
        const metaRobots = extractRobotsMeta(res.text);
        const headerRobots = parseXRobotsTag(res.headers?.get("x-robots-tag") ?? null);
        const hreflang: NonNullable<GraphObservation["hreflang"]> = [];
        const pagination: NonNullable<GraphObservation["pagination"]> = [];
        for (const token of document.tokens) {
          if (token.closing || token.name !== "link" || !token.attrs.href) continue;
          const rel = decodeAttribute(token.attrs.rel ?? "")
            .toLowerCase()
            .split(/\s+/);
          let url: URL;
          try {
            url = new URL(decodeAttribute(token.attrs.href), base);
          } catch {
            continue;
          }
          if (!/^https?:$/.test(url.protocol) || url.username || url.password) continue;
          if (!captureSafeUrl(normalizeUrl(url.href))) {
            if (coverage) coverage.redactedUrlCount = (coverage.redactedUrlCount ?? 0) + 1;
            continue;
          }
          if (rel.includes("alternate") && token.attrs.hreflang)
            hreflang.push({ language: decodeAttribute(token.attrs.hreflang), url: url.href });
          for (const relation of ["next", "prev"] as const)
            if (rel.includes(relation)) pagination.push({ relation, url: url.href });
        }
        if (res.truncated || !document.complete || anchors.length >= 1200)
          coverage?.failedUrls.push(item.url);
        const declaredCanonical = extractCanonical(res.text, base);
        const canonical =
          declaredCanonical && captureSafeUrl(normalizeUrl(declaredCanonical))
            ? declaredCanonical
            : null;
        if (declaredCanonical && !canonical && coverage)
          coverage.redactedUrlCount = (coverage.redactedUrlCount ?? 0) + 1;
        return {
          url: documentUrl,
          requestedUrl: item.url,
          path: pathOf(documentUrl),
          status: res.status,
          finalUrl: res.finalUrl,
          title: extractTitle(res.text),
          canonical,
          noindex: metaRobots.noindex || headerRobots.noindex,
          nofollow: metaRobots.nofollow || headerRobots.nofollow,
          internalLinks: [...new Set(internal)],
          crawlLinks: [...new Set(crawlLinks)],
          externalLinks: external,
          depth: item.depth,
          redirected: normalizeUrl(res.finalUrl) !== item.url,
          bytes: res.text.length,
          observation: {
            url: documentUrl,
            resolvedUrl: documentUrl,
            requestedUrl: item.url,
            links: internal,
            hreflang,
            pagination,
            evidenceRef: `useful-html:sha256:${createHash("sha256").update(res.text).digest("hex")}`,
          },
        } satisfies CrawlPage;
      } catch {
        coverage?.failedUrls.push(item.url);
        return null;
      }
    });

    for (const page of results) {
      if (!page) continue;
      seen.add(page.url);
      if (pages.some((existing) => existing.url === page.url)) continue;
      pages.push(page);
      for (const link of page.crawlLinks ?? page.internalLinks) {
        if (seen.has(link)) continue;
        if (seen.size >= limit * 3) {
          coverage?.blockedUrls.push(link);
          continue;
        }
        seen.add(link);
        frontier.push({ url: link, depth: page.depth + 1 });
      }
    }
  }

  if (coverage) coverage.frontierExhausted = frontier.length === 0;
  return pages;
}

async function loadSitemapInventory(
  startUrl: string,
  budget: Budget,
  limit = 400,
): Promise<{ urls: string[]; inventories: GraphInventory[]; redactedUrlCount: number }> {
  const origin = new URL(startUrl).origin;
  const candidates: string[] = [];
  const inventories: GraphInventory[] = [];
  let redactedUrlCount = 0;
  const safe = (raw: string) => {
    try {
      const url = normalizeUrl(raw);
      if (!captureSafeUrl(url)) {
        redactedUrlCount++;
        return null;
      }
      return new URL(url).origin === origin ? url : null;
    } catch {
      return null;
    }
  };
  try {
    const robots = await fetchText(`${origin}/robots.txt`, {
      timeoutMs: budget.timeout(4000),
      maxBytes: 64_000,
      skipRobots: true,
      cache: true,
      budget,
      accept: "text/plain,*/*;q=0.8",
    });
    if (robots.status >= 200 && robots.status < 300 && !robots.truncated)
      candidates.push(...parseRobotsSitemaps(robots.text));
  } catch {
    /* Missing robots does not establish an exhaustive inventory. */
  }
  candidates.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`);
  const found = new Set<string>();
  const seenMaps = new Set<string>();
  for (const candidate of candidates) {
    if (found.size >= limit || seenMaps.size >= 32 || budget.spent(0.9)) break;
    const mapUrl = safe(candidate);
    if (!mapUrl || seenMaps.has(mapUrl)) continue;
    seenMaps.add(mapUrl);
    try {
      const res = await fetchText(mapUrl, {
        timeoutMs: budget.timeout(6000),
        maxBytes: 2_000_000,
        skipRobots: true,
        cache: true,
        budget,
        accept: "application/xml,text/xml,*/*;q=0.8",
        onRedirect: ({ to }) => {
          if (!safe(to)) throw new Error("Sitemap redirect exceeds inventory scope.");
        },
      });
      if (
        res.status < 200 ||
        res.status >= 300 ||
        !safe(res.finalUrl) ||
        !res.text.includes("<loc")
      )
        continue;
      const locs = parseSitemap(res.text, limit + 1);
      if (isSitemapIndex(res.text)) {
        for (const child of locs.slice(0, 32)) if (!seenMaps.has(child)) candidates.push(child);
        continue;
      }
      const urls: string[] = [];
      for (const loc of locs) {
        const url = safe(loc);
        if (!url) continue;
        urls.push(url);
        found.add(url);
        if (found.size >= limit) break;
      }
      inventories.push({
        source: "sitemap",
        urls,
        complete: false,
        documentUrl: normalizeUrl(res.finalUrl),
        evidenceRef: `sitemap:sha256:${createHash("sha256").update(res.text).digest("hex")}`,
      });
    } catch {
      /* Broken or bounded maps cannot certify exhaustive coverage. */
    }
  }
  return { urls: [...found], inventories, redactedUrlCount };
}

function issue(
  id: string,
  severity: SiteIssue["severity"],
  title: string,
  detail: string,
  samples: string[],
): SiteIssue {
  return { id, severity, title, detail, count: samples.length, samples: samples.slice(0, 6) };
}

function failedAudit(message: string): SiteAudit {
  return {
    status: "failed",
    crawled: 0,
    avgDepth: 0,
    avgInboundLinks: 0,
    maxDepth: 0,
    orphans: 0,
    brokenInternal: 0,
    redirectedInternal: 0,
    noindexPages: 0,
    pages: [],
    issues: [issue("audit-failed", "high", "Site audit failed", message.slice(0, 400), [])],
    score: 0,
  };
}

/**
 * Crawls the target and reports how it links to itself, plus the technical
 * problems that quietly waste link equity.
 */
export async function runSiteAudit(
  startUrl: string,
  host: string,
  budget: Budget,
  backlinks: Backlink[] = [],
  limit = MAX_PAGES,
  options: SiteAuditOptions = {},
): Promise<SiteAudit & { technicalGraph?: TechnicalGraphReport }> {
  try {
    const coverage: CrawlCoverage = {
      frontierExhausted: false,
      blockedUrls: [],
      failedUrls: [],
      redirects: [],
    };
    const pages = await crawl(startUrl, host, budget, limit, coverage);
    if (pages.length === 0) {
      return failedAudit("Crawl returned no pages (blocked, empty, or budget exhausted).");
    }

    const inbound = new Map<string, number>();
    const outboundCount = new Map<string, number>();

    for (const page of pages) {
      outboundCount.set(page.url, page.internalLinks.length);
      for (const link of page.internalLinks) {
        inbound.set(link, (inbound.get(link) ?? 0) + 1);
      }
    }

    const reachable = new Set(
      pages.flatMap((page) => [
        page.url,
        ...(page.requestedUrl ? [page.requestedUrl] : []),
        ...page.internalLinks,
      ]),
    );
    const inventory = new Set<string>();
    const effectiveRootUrl = coverage.effectiveRootUrl ?? startUrl;
    const sitemap = await loadSitemapInventory(effectiveRootUrl, budget, Math.max(limit * 3, 200));
    const sitemapUrls = sitemap.urls;
    coverage.redactedUrlCount = (coverage.redactedUrlCount ?? 0) + sitemap.redactedUrlCount;
    const origin = new URL(effectiveRootUrl).origin;
    const safeInventoryUrl = (raw: string) => {
      try {
        const url = normalizeUrl(raw);
        if (!captureSafeUrl(url)) {
          coverage.redactedUrlCount = (coverage.redactedUrlCount ?? 0) + 1;
          return null;
        }
        return new URL(url).origin === origin ? url : null;
      } catch {
        return null;
      }
    };
    for (const url of sitemapUrls) {
      inventory.add(url);
    }
    const suppliedInventories: GraphInventory[] = [
      ...(options.knownUrls?.length
        ? [
            {
              source: "supplied" as const,
              urls: options.knownUrls,
              complete: false,
              evidenceRef: "caller:knownUrls",
            },
          ]
        : []),
      ...(options.inventories ?? []),
    ].map((list) => ({
      ...list,
      urls: list.urls.flatMap((raw) => {
        const url = safeInventoryUrl(raw);
        return url ? [url] : [];
      }),
    }));
    for (const list of suppliedInventories) for (const url of list.urls) inventory.add(url);

    // Inventory absence from this bounded crawl identifies candidates, never proven orphans.
    const orphanUrls = [...inventory].filter((url) => !reachable.has(url));

    // Backlinks tell us which pages carry external authority worth spreading.
    const backlinksByPath = new Map<string, number>();
    for (const link of backlinks) {
      const path = link.targetPath || "/";
      backlinksByPath.set(path, (backlinksByPath.get(path) ?? 0) + 1);
    }

    const internalPages: InternalPage[] = pages.map((page) => ({
      url: page.url,
      path: page.path,
      title: page.title,
      status: page.status,
      depth: page.depth,
      inboundLinks: inbound.get(page.url) ?? 0,
      outboundLinks: outboundCount.get(page.url) ?? 0,
      externalLinks: page.externalLinks,
      noindex: page.noindex,
      canonical: page.canonical,
      backlinks: backlinksByPath.get(page.path) ?? 0,
      redirected: page.redirected,
    }));

    // Unreachable inventory URLs appear as synthetic orphan rows for reporting.
    for (const url of orphanUrls.slice(0, 80)) {
      if (internalPages.some((page) => page.url === url)) continue;
      internalPages.push({
        url,
        path: pathOf(url),
        title: null,
        status: 0,
        depth: -1,
        inboundLinks: 0,
        outboundLinks: 0,
        externalLinks: 0,
        noindex: false,
        canonical: null,
        backlinks: backlinksByPath.get(pathOf(url)) ?? 0,
        redirected: false,
      });
    }

    const issues: SiteIssue[] = [];
    const orphans = orphanUrls;

    if (orphans.length > 0) {
      issues.push(
        issue(
          "orphan-pages",
          "low",
          `${orphans.length} inventory URLs were not observed in the crawled link graph`,
          "These inventory URLs were not observed as pages or link targets in this bounded crawl. They are investigation candidates; incomplete coverage or unavailable pages can explain their absence. Confirm existence, intended indexability and crawl coverage before changing links or sitemaps.",
          orphans.map((url) => pathOf(url)),
        ),
      );
    }

    // Deep pages: every extra click dilutes the signal that reaches them.
    const deep = internalPages.filter((page) => page.depth >= 4);
    if (deep.length > 0) {
      issues.push(
        issue(
          "deep-pages",
          "medium",
          `${deep.length} pages sit four or more clicks from the home page`,
          "Depth costs authority and crawl frequency. Pull important pages up by linking them from hubs or navigation.",
          deep.map((page) => `${page.path} (depth ${page.depth})`),
        ),
      );
    }

    // Pages that earn backlinks but block indexing — pure waste.
    const wasted = internalPages.filter((page) => page.noindex && page.backlinks > 0);
    if (wasted.length > 0) {
      issues.push(
        issue(
          "noindex-with-backlinks",
          "high",
          `${wasted.length} noindex pages hold backlinks`,
          "External sites link to these pages, but they are excluded from the index, so that authority goes nowhere. Either allow indexing or redirect them to a page that is indexed.",
          wasted.map((page) => `${page.path} (${page.backlinks} backlinks)`),
        ),
      );
    }

    const broken = internalPages.filter((page) => page.status >= 400);
    if (broken.length > 0) {
      issues.push(
        issue(
          "broken-internal",
          "high",
          `${broken.length} internal links lead to errors`,
          "Pages linked from the site return 4xx or 5xx. Fix the link or restore the page.",
          broken.map((page) => `${page.path} (${page.status})`),
        ),
      );
    }

    const redirected = internalPages.filter((page) => page.redirected && page.status < 400);
    if (redirected.length >= 3) {
      issues.push(
        issue(
          "internal-redirects",
          "medium",
          `${redirected.length} internal links go through a redirect`,
          "Each hop wastes a little authority and slows crawling. Point internal links at the final URL.",
          redirected.map((page) => page.path),
        ),
      );
    }

    // Canonical pointing elsewhere while the page still collects internal links.
    const canonicalConflicts = pages.filter((page) => {
      if (!page.canonical) return false;
      const canonical = normalizeUrl(page.canonical);
      return canonical !== page.url && (inbound.get(page.url) ?? 0) >= 2;
    });
    if (canonicalConflicts.length > 0) {
      issues.push(
        issue(
          "canonical-conflict",
          "medium",
          `${canonicalConflicts.length} pages point their canonical elsewhere`,
          "These pages receive internal links but tell search engines to credit a different URL. Either link to the canonical target directly or fix the tag.",
          canonicalConflicts.map((page) => `${page.path} → ${pathOf(page.canonical ?? "")}`),
        ),
      );
    }

    // Money pages: strong externally, weak internally.
    const underlinked = internalPages
      .filter(
        (page) => page.backlinks >= 2 && page.inboundLinks <= 1 && !page.noindex && page.depth >= 0,
      )
      .sort((a, b) => b.backlinks - a.backlinks);
    if (underlinked.length > 0) {
      issues.push(
        issue(
          "underlinked-money-pages",
          "high",
          `${underlinked.length} pages with backlinks are barely linked internally`,
          "Other sites consider these pages worth linking to, but your own site hardly does. Adding internal links from related content is the cheapest ranking gain available.",
          underlinked.map(
            (page) => `${page.path} (${page.backlinks} backlinks, ${page.inboundLinks} internal)`,
          ),
        ),
      );
    }

    const crawled = pages.length;
    const avgDepth =
      crawled > 0
        ? Math.round((pages.reduce((sum, page) => sum + page.depth, 0) / crawled) * 10) / 10
        : 0;
    const avgInbound =
      crawled > 0
        ? Math.round(
            (pages.reduce((sum, page) => sum + (inbound.get(page.url) ?? 0), 0) / crawled) * 10,
          ) / 10
        : 0;

    // Score: start from full marks, subtract for each structural problem.
    let score = 100;
    score -= Math.min(15, deep.length * 2);
    score -= Math.min(20, broken.length * 5);
    score -= Math.min(15, wasted.length * 7);
    score -= Math.min(10, underlinked.length * 3);
    score -= Math.min(10, Math.max(0, redirected.length - 2) * 2);

    const audit: SiteAudit = {
      status: "ok",
      crawled,
      avgDepth,
      avgInboundLinks: avgInbound,
      maxDepth: Math.max(0, ...pages.map((page) => page.depth)),
      orphans: orphans.length,
      brokenInternal: broken.length,
      redirectedInternal: redirected.length,
      noindexPages: internalPages.filter((page) => page.noindex).length,
      pages: internalPages
        .sort((a, b) => b.inboundLinks - a.inboundLinks || a.depth - b.depth)
        .slice(0, 100),
      issues,
      score: Math.max(0, Math.min(100, Math.round(score))),
    };
    const inScope = (url: string) => {
      try {
        return new URL(url).origin === origin;
      } catch {
        return false;
      }
    };
    const inventories = [...sitemap.inventories, ...suppliedInventories];
    return {
      ...audit,
      technicalGraph: buildTechnicalGraph({
        rootUrl: effectiveRootUrl,
        requestedRootUrl: startUrl,
        audit: {
          ...audit,
          pages: internalPages
            .filter((page) => inScope(page.url))
            .map((page) => ({ ...page, redirected: false })),
        },
        observations: pages.flatMap((page) =>
          page.observation && inScope(page.url) ? [page.observation] : [],
        ),
        inventories,
        crawl: {
          ...coverage,
          blockedUrls: [...new Set(coverage.blockedUrls)],
          failedUrls: [...new Set(coverage.failedUrls)],
        },
      }),
    };
  } catch (err) {
    return failedAudit(err instanceof Error ? err.message : String(err));
  }
}

export { crawl as crawlInternalPages };
