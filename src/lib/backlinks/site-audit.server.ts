import {
  extractCanonical,
  extractRobotsMeta,
  extractTitle,
  parseAnchors,
  parseRobotsSitemaps,
  parseSitemap,
  parseXRobotsTag,
  isSitemapIndex,
} from "./html.ts";
import { hostFromUrl, isTargetHost, normalizeUrl, pathOf } from "./parse.ts";
import { Budget, fetchUsefulHtml, fetchText, mapLimit } from "./net.server.ts";
import { isAllowed, robotsFor } from "./robots.server.ts";
import type {
  Backlink,
  InternalPage,
  SiteAudit,
  SiteIssue,
} from "./types.ts";

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
  path: string;
  status: number;
  finalUrl: string;
  title: string | null;
  canonical: string | null;
  noindex: boolean;
  nofollow: boolean;
  internalLinks: string[];
  externalLinks: number;
  depth: number;
  /** Number of hops the server made before serving this page. */
  redirected: boolean;
  bytes: number;
};

export type SiteAuditOptions = {
  /** Extra known URLs (GSC pages, CMS export). Merged into orphan inventory. */
  knownUrls?: string[];
};

function shouldCrawl(url: string, host: string): boolean {
  if (!isTargetHost(hostFromUrl(url), host)) return false;
  const path = pathOf(url);
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
): Promise<CrawlPage[]> {
  const seen = new Set<string>();
  const pages: CrawlPage[] = [];
  let frontier: { url: string; depth: number }[] = [{ url: normalizeUrl(startUrl), depth: 0 }];
  seen.add(normalizeUrl(startUrl));

  const origin = new URL(startUrl).origin;
  const rules = await robotsFor(origin, budget);

  while (frontier.length > 0 && pages.length < limit && !budget.spent(0.85)) {
    const wave = frontier.slice(0, 12);
    frontier = frontier.slice(12);

    const results = await mapLimit(wave, 3, async (item) => {
      if (budget.left() < 3000) return null;
      if (!isAllowed(rules, pathOf(item.url))) return null;
      try {
        const res = await fetchUsefulHtml(item.url, budget.timeout(7000), budget.signal, budget);
        if (res.status >= 400 || res.text.length < 200) {
          return {
            url: item.url,
            path: pathOf(item.url),
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

        const anchors = parseAnchors(res.text, item.url);
        const internal: string[] = [];
        let external = 0;
        for (const anchor of anchors) {
          const target = hostFromUrl(anchor.href);
          if (isTargetHost(target, host)) {
            if (shouldCrawl(anchor.href, host)) internal.push(normalizeUrl(anchor.href));
          } else if (target) {
            external += 1;
          }
        }
        const metaRobots = extractRobotsMeta(res.text);
        const headerRobots = parseXRobotsTag(res.headers?.get("x-robots-tag") ?? null);
        return {
          url: item.url,
          path: pathOf(item.url),
          status: res.status,
          finalUrl: res.finalUrl,
          title: extractTitle(res.text),
          canonical: extractCanonical(res.text, item.url),
          noindex: metaRobots.noindex || headerRobots.noindex,
          nofollow: metaRobots.nofollow || headerRobots.nofollow,
          internalLinks: [...new Set(internal)],
          externalLinks: external,
          depth: item.depth,
          redirected: normalizeUrl(res.finalUrl) !== item.url,
          bytes: res.text.length,
        } satisfies CrawlPage;
      } catch {
        return null;
      }
    });

    for (const page of results) {
      if (!page) continue;
      pages.push(page);
      for (const link of page.internalLinks) {
        if (seen.has(link) || seen.size >= limit * 3) continue;
        seen.add(link);
        frontier.push({ url: link, depth: page.depth + 1 });
      }
    }
  }

  return pages;
}

async function loadSitemapInventory(
  startUrl: string,
  host: string,
  budget: Budget,
  limit = 400,
): Promise<string[]> {
  const origin = new URL(startUrl).origin;
  const candidates: string[] = [];
  try {
    const robots = await fetchText(`${origin}/robots.txt`, {
      timeoutMs: budget.timeout(4000),
      maxBytes: 64_000,
      skipRobots: true,
      cache: true,
      budget,
      accept: "text/plain,*/*;q=0.8",
    });
    if (robots.status < 400) candidates.push(...parseRobotsSitemaps(robots.text));
  } catch {
    /* ignore */
  }
  candidates.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`);

  const found: string[] = [];
  const seenMaps = new Set<string>();
  for (const mapUrl of candidates) {
    if (found.length >= limit || budget.spent(0.9)) break;
    const key = normalizeUrl(mapUrl);
    if (seenMaps.has(key)) continue;
    seenMaps.add(key);
    try {
      const res = await fetchText(mapUrl, {
        timeoutMs: budget.timeout(6000),
        maxBytes: 2_000_000,
        skipRobots: true,
        cache: true,
        budget,
        accept: "application/xml,text/xml,*/*;q=0.8",
      });
      if (res.status >= 400 || !res.text.includes("<loc")) continue;
      const locs = parseSitemap(res.text, limit);
      if (isSitemapIndex(res.text)) {
        for (const child of locs.slice(0, 8)) {
          if (seenMaps.has(normalizeUrl(child))) continue;
          candidates.push(child);
        }
        continue;
      }
      for (const loc of locs) {
        if (!isTargetHost(hostFromUrl(loc), host)) continue;
        if (!shouldCrawl(loc, host)) continue;
        found.push(normalizeUrl(loc));
        if (found.length >= limit) break;
      }
    } catch {
      /* ignore broken sitemaps */
    }
  }
  return [...new Set(found)];
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
    issues: [
      issue(
        "audit-failed",
        "high",
        "Site audit failed",
        message.slice(0, 400),
        [],
      ),
    ],
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
): Promise<SiteAudit> {
  try {
    const pages = await crawl(startUrl, host, budget, limit);
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

    const reachable = new Set(pages.map((page) => page.url));
    const inventory = new Set<string>();
    for (const url of await loadSitemapInventory(startUrl, host, budget, Math.max(limit * 3, 200))) {
      inventory.add(url);
    }
    for (const raw of options.knownUrls ?? []) {
      try {
        const url = normalizeUrl(raw);
        if (isTargetHost(hostFromUrl(url), host) && shouldCrawl(url, host)) inventory.add(url);
      } catch {
        /* ignore */
      }
    }

    // True orphans: known from inventory, never reached via internal links from home.
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
          "high",
          `${orphans.length} inventory URLs are unreachable from the homepage link graph`,
          "These URLs appear in the sitemap (or supplied inventory) but were not reached by crawling internal links from the home page. They are orphan candidates — confirm they should be linked, redirected, or removed from the sitemap. Crawl-only discovery cannot prove orphans on its own.",
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
      .filter((page) => page.backlinks >= 2 && page.inboundLinks <= 1 && !page.noindex && page.depth >= 0)
      .sort((a, b) => b.backlinks - a.backlinks);
    if (underlinked.length > 0) {
      issues.push(
        issue(
          "underlinked-money-pages",
          "high",
          `${underlinked.length} pages with backlinks are barely linked internally`,
          "Other sites consider these pages worth linking to, but your own site hardly does. Adding internal links from related content is the cheapest ranking gain available.",
          underlinked.map((page) => `${page.path} (${page.backlinks} backlinks, ${page.inboundLinks} internal)`),
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
        ? Math.round((pages.reduce((sum, page) => sum + (inbound.get(page.url) ?? 0), 0) / crawled) * 10) /
          10
        : 0;

    // Score: start from full marks, subtract for each structural problem.
    let score = 100;
    score -= Math.min(30, orphans.length * 4);
    score -= Math.min(15, deep.length * 2);
    score -= Math.min(20, broken.length * 5);
    score -= Math.min(15, wasted.length * 7);
    score -= Math.min(10, underlinked.length * 3);
    score -= Math.min(10, Math.max(0, redirected.length - 2) * 2);

    return {
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
  } catch (err) {
    return failedAudit(err instanceof Error ? err.message : String(err));
  }
}

export { crawl as crawlInternalPages };
