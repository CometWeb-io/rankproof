import {
  classifyAnchor,
  extractCanonical,
  extractLang,
  extractRobotsMeta,
  extractTitle,
  isSocialHost,
  isUsefulInternalPath,
  parseAnchors,
  parseXRobotsTag,
  scoreInternalPath,
  snippetAround,
} from "./html.ts";
import {
  hostFromUrl,
  isTargetHost,
  normalizeUrl,
  pageKey,
  pathOf,
  registrableDomain,
  stripWww,
} from "./parse.ts";
import { backlinkId } from "./score.ts";
import { fetchUsefulHtml, mapLimit, probeStatus, type Budget } from "./net.server.ts";
import {
  isJunkHost,
  isSkippableOutbound,
  makeMention,
  waybackSnapshot,
  type Candidate,
} from "./sources.server.ts";
import type { DomainEdge } from "./graph.ts";
import { relevanceScore } from "./topic.ts";
import { stripTags } from "./html.ts";
import type { Backlink, DiscoverySource, LinkFlag, LinkRel, Mention } from "./types.ts";

const VIA_RANK: Record<DiscoverySource, number> = {
  graph: 0,
  page: 1,
  github: 2,
  bing: 3,
  duckduckgo: 3,
  mojeek: 4,
  stackexchange: 5,
  news: 6,
  wikipedia: 7,
  "hacker-news": 7,
  reddit: 8,
  bluesky: 9,
  commoncrawl: 9,
  urlscan: 10,
  sitemap: 11,
  archive: 11,
  lookup: 12,
};

export function classifyRel(rel: string | undefined): LinkRel {
  const tokens = (rel ?? "").toLowerCase().split(/\s+/);
  if (tokens.includes("sponsored")) return "sponsored";
  if (tokens.includes("ugc")) return "ugc";
  if (tokens.includes("nofollow")) return "nofollow";
  return "dofollow";
}

function candidateRank(page: Candidate): number {
  let rank = VIA_RANK[page.via] ?? 8;
  rank -= page.boost ?? 0;
  const host = stripWww(hostFromUrl(page.url));
  if (isSocialHost(host) && host !== "github.com") rank += 20;
  return rank;
}

export type VerifyOptions = {
  host: string;
  brandTokens: string[];
  /** Terms describing the target's topic (used to score link relevance). */
  topicTerms?: Map<string, number>;
  limit: number;
  budget: Budget;
  /** How many pages of one domain may be checked in this wave. */
  perDomain?: number;
  concurrency?: number;
  seen?: Set<string>;
};

export type VerifyOutput = {
  backlinks: Backlink[];
  mentions: Mention[];
  deeper: Candidate[];
  checked: number;
  /** Edges of the domain graph — the basis for PageRank. */
  edges: DomainEdge[];
  /** Pages mentioning the target without linking (lost-link candidates). */
  unlinkedPages: string[];
};

/** Selects candidates to verify: deduplicated, with a per-domain cap. */
export function selectCandidates(
  pages: Candidate[],
  opts: { host: string; limit: number; perDomain: number; seen: Set<string> },
): Candidate[] {
  const ranked = [...pages].sort((a, b) => candidateRank(a) - candidateRank(b));
  const perDomain = new Map<string, number>();
  const out: Candidate[] = [];
  for (const page of ranked) {
    const key = pageKey(page.url);
    if (opts.seen.has(key)) continue;
    const host = hostFromUrl(page.url);
    if (!host || isTargetHost(host, opts.host) || isJunkHost(host)) continue;
    if (isSkippableOutbound(page.url, host)) continue;
    const domain = registrableDomain(host);
    const used = perDomain.get(domain) ?? 0;
    if (used >= opts.perDomain) continue;
    perDomain.set(domain, used + 1);
    opts.seen.add(key);
    out.push(page);
    if (out.length >= opts.limit) break;
  }
  return out;
}

/**
 * Opens candidate pages and confirms an `<a href>` pointing at the target
 * exists. Along the way it collects context: document section, language,
 * meta robots and the actual surrounding text for mentions.
 */
export async function verifyPages(pages: Candidate[], opts: VerifyOptions): Promise<VerifyOutput> {
  const seen = opts.seen ?? new Set<string>();
  const unique = selectCandidates(pages, {
    host: opts.host,
    limit: opts.limit,
    perDomain: opts.perDomain ?? 3,
    seen,
  });

  const backlinks: Backlink[] = [];
  const mentions: Mention[] = [];
  const deeper: Candidate[] = [];
  const edges: DomainEdge[] = [];
  const unlinkedPages: string[] = [];
  let checked = 0;

  await mapLimit(unique, opts.concurrency ?? 8, async (page) => {
    if (opts.budget.left() < 2500) return;
    try {
      const res = await fetchUsefulHtml(page.url, opts.budget.timeout(7000), opts.budget.signal, opts.budget);
      checked += 1;
      if (res.status >= 400 || !res.text) return;

      const sourceUrl = normalizeUrl(res.finalUrl || page.url);
      const sourceHost = hostFromUrl(sourceUrl);
      if (!sourceHost || isJunkHost(sourceHost) || isTargetHost(sourceHost, opts.host)) {
        return;
      }
      const sourceDomain = registrableDomain(sourceHost);
      const title = extractTitle(res.text) || page.title || sourceHost;
      const lang = extractLang(res.text);
      const metaRobots = extractRobotsMeta(res.text);
      const headerRobots = parseXRobotsTag(res.headers?.get("x-robots-tag") ?? null);
      const noindex = metaRobots.noindex || headerRobots.noindex;
      const pageNofollow = metaRobots.nofollow || headerRobots.nofollow;
      const canonical = extractCanonical(res.text);
      const canonicalMismatch =
        canonical && pageKey(canonical) !== pageKey(sourceUrl) ? canonical : null;

      const pageText = opts.topicTerms?.size ? stripTags(res.text).slice(0, 24_000) : "";
      const anchors = parseAnchors(res.text, sourceUrl);
      const external = anchors.filter(
        (a) => registrableDomain(hostFromUrl(a.href)) !== sourceDomain,
      );
      const outboundHeavy = external.length > 150;

      // Domain graph: who links to whom around the audited site.
      const outboundDomains = new Map<string, number>();
      for (const a of external) {
        const domain = registrableDomain(hostFromUrl(a.href));
        if (!domain || domain === sourceDomain) continue;
        outboundDomains.set(domain, (outboundDomains.get(domain) ?? 0) + 1);
      }
      for (const [domain, count] of outboundDomains) {
        edges.push({ from: sourceDomain, to: domain, weight: Math.min(count, 5) });
      }

      const matching = anchors.filter((a) => isTargetHost(hostFromUrl(a.href), opts.host));

      if (matching.length > 0) {
        const cap = page.via === "urlscan" || page.via === "lookup" ? 3 : 8;
        const localSeen = new Set<string>();
        for (const anchor of matching.slice(0, cap)) {
          const targetUrl = normalizeUrl(anchor.href);
          const rel = classifyRel(anchor.rel);
          const anchorText = anchor.text.trim();
          const id = backlinkId({ sourceUrl, targetUrl, anchor: anchorText });
          if (localSeen.has(id)) continue;
          localSeen.add(id);

          const relevance = opts.topicTerms?.size
            ? relevanceScore(pageText, opts.topicTerms, {
                anchor: anchorText,
                brandTokens: opts.brandTokens,
              })
            : 50;

          const flags: LinkFlag[] = [];
          if (relevance < 18) flags.push("off-topic");
          if (noindex) flags.push("noindex-source");
          if (pageNofollow) flags.push("page-level-nofollow");
          if (anchor.placement === "footer" || anchor.placement === "navigation") {
            flags.push("boilerplate");
          }
          if (anchor.isImage) flags.push("image-link");

          backlinks.push({
            id,
            sourceUrl,
            sourceHost,
            sourceDomain,
            sourceTitle: title,
            sourceLang: lang,
            targetUrl,
            targetPath: pathOf(targetUrl),
            anchor: anchorText,
            anchorType: classifyAnchor(anchorText, opts.host, opts.brandTokens, anchor.isImage),
            rel,
            effectiveFollow: rel === "dofollow" && !pageNofollow && !noindex,
            placement: anchor.placement,
            sitewide: false,
            discoveredVia: page.via,
            verified: true,
            firstSeen: null,
            httpStatus: res.status,
            targetStatus: null,
            domainScore: 0,
            spamScore: outboundHeavy ? 10 : 0,
            relevance,
            targetFinalUrl: null,
            state: "live",
            lastSeen: null,
            flags,
          });
        }

        // The domain already links — its home page and neighbouring posts are worth a look.
        try {
          const origin = new URL(sourceUrl);
          if (origin.pathname !== "/" && origin.pathname !== "") {
            deeper.push({
              url: `${origin.protocol}//${origin.host}/`,
              title: sourceHost,
              via: "page",
              boost: 2,
            });
          }
        } catch {
          /* ignore */
        }
        if (canonicalMismatch) {
          deeper.push({ url: canonicalMismatch, title, via: "page", boost: 1 });
        }
        for (const a of anchors) {
          if (registrableDomain(hostFromUrl(a.href)) !== sourceDomain) continue;
          if (pageKey(a.href) === pageKey(sourceUrl)) continue;
          let path = "";
          try {
            path = new URL(a.href).pathname;
          } catch {
            continue;
          }
          if (!isUsefulInternalPath(path) || scoreInternalPath(path) < 5) continue;
          deeper.push({
            url: a.href,
            title: a.text || title,
            via: "page",
          });
        }
      } else if (res.text.toLowerCase().includes(opts.host.toLowerCase())) {
        const snippet =
          snippetAround(res.text, opts.host) ??
          `The page mentions ${opts.host} but no hyperlink was found`;
        unlinkedPages.push(sourceUrl);
        mentions.push({
          ...makeMention(sourceUrl, title, snippet, page.via, true),
          sourceDomain,
        });
      }
    } catch {
      /* a single page must never break the scan */
    }
  });

  return { backlinks, mentions, deeper, checked, edges, unlinkedPages };
}

/**
 * Lost backlinks: a page used to link (visible in the Internet Archive) and no
 * longer does. These are the best
 * lista do odzyskania jednym mailem.
 */
export async function findLostLinks(
  pages: string[],
  opts: { host: string; brandTokens: string[]; budget: Budget; limit?: number },
): Promise<Backlink[]> {
  const limit = opts.limit ?? 14;
  const unique = [...new Set(pages.map((url) => normalizeUrl(url)))].slice(0, limit);
  const out: Backlink[] = [];

  await mapLimit(unique, 4, async (pageUrl) => {
    if (opts.budget.left() < 4000) return;
    const snapshot = await waybackSnapshot(pageUrl, opts.budget.timeout(5000), opts.budget.signal);
    if (!snapshot) return;
    try {
      const res = await fetchUsefulHtml(
        snapshot.url,
        opts.budget.timeout(8000),
        opts.budget.signal,
      );
      if (res.status >= 400 || res.text.length < 500) return;
      const anchors = parseAnchors(res.text, pageUrl).filter((a) =>
        isTargetHost(hostFromUrl(a.href), opts.host),
      );
      if (anchors.length === 0) return;
      const anchor = anchors[0]!;
      const sourceHost = hostFromUrl(pageUrl);
      const targetUrl = normalizeUrl(anchor.href);
      const anchorText = anchor.text.trim();
      const title = extractTitle(res.text) || sourceHost;
      out.push({
        id: backlinkId({ sourceUrl: pageUrl, targetUrl, anchor: anchorText }),
        sourceUrl: pageUrl,
        sourceHost,
        sourceDomain: registrableDomain(sourceHost),
        sourceTitle: title,
        sourceLang: extractLang(res.text),
        targetUrl,
        targetPath: pathOf(targetUrl),
        anchor: anchorText,
        anchorType: classifyAnchor(anchorText, opts.host, opts.brandTokens, anchor.isImage),
        rel: classifyRel(anchor.rel),
        effectiveFollow: false,
        placement: anchor.placement,
        sitewide: false,
        discoveredVia: "archive",
        verified: true,
        firstSeen: null,
        httpStatus: null,
        targetStatus: null,
        domainScore: 0,
        spamScore: 0,
        relevance: 50,
        targetFinalUrl: null,
        state: "lost",
        lastSeen: snapshot.date,
        flags: ["lost"],
      });
    } catch {
      /* no snapshot, or an archive error */
    }
  });

  return out;
}

/**
 * Checks whether target URLs actually work — a broken backlink is the easiest
 * SEO gain there is to recover.
 */
export type ProbeResult = { status: number; finalUrl: string };

export async function probeTargets(
  urls: string[],
  budget: Budget,
  limit = 24,
): Promise<Map<string, ProbeResult>> {
  const unique = [...new Set(urls.map((u) => normalizeUrl(u)))].slice(0, limit);
  const out = new Map<string, ProbeResult>();
  await mapLimit(unique, 6, async (url) => {
    if (budget.left() < 2000) return;
    const result = await probeStatus(url, budget.timeout(5000), budget.signal);
    if (result) out.set(url, { status: result.status, finalUrl: normalizeUrl(result.finalUrl) });
  });
  return out;
}

/** Flags links that repeat across many pages of the same domain. */
export function markSitewide(items: Backlink[]): Backlink[] {
  const groups = new Map<string, Set<string>>();
  for (const item of items) {
    const key = `${item.sourceDomain}»${item.targetPath}»${item.anchor.toLowerCase()}`;
    const set = groups.get(key) ?? new Set<string>();
    set.add(pageKey(item.sourceUrl));
    groups.set(key, set);
  }
  return items.map((item) => {
    const key = `${item.sourceDomain}»${item.targetPath}»${item.anchor.toLowerCase()}`;
    const pages = groups.get(key)?.size ?? 1;
    const sitewide =
      pages >= 3 ||
      (pages >= 2 && (item.placement === "footer" || item.placement === "navigation"));
    if (!sitewide) return item;
    return {
      ...item,
      sitewide: true,
      flags: item.flags.includes("sitewide") ? item.flags : [...item.flags, "sitewide"],
    };
  });
}
