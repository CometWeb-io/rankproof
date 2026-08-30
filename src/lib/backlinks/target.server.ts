import {
  decodeText,
  extractAlternateRss,
  extractDescription,
  extractJsonLdUrls,
  extractLang,
  extractCanonical,
  extractRelMe,
  extractRobotsMeta,
  extractTitle,
  isUsefulInternalPath,
  parseAnchors,
  rssItemLinks,
  scoreInternalPath,
  unwrapRedirect,
  usefulHtml,
} from "./html.ts";
import {
  hostFromUrl,
  isTargetHost,
  normalizeUrl,
  pageKey,
  registrableDomain,
  sld,
  stripWww,
} from "./parse.ts";
import { fetchJson, fetchText, fetchUsefulHtml, mapLimit, type Budget } from "./net.server.ts";
import {
  fetchSitemapUrls,
  isSkippableOutbound,
  scanCertSubdomains,
  scanCommonCrawl,
  waybackCdxUrls,
  type Candidate,
} from "./sources.server.ts";
import { mergeTerms } from "./topic.ts";
import { stripTags } from "./html.ts";
import { auditOnPage } from "./onpage.ts";
import { extractHeadings } from "./html.ts";
import type { OnPageAudit, SiteSnapshot } from "./types.ts";


const STOPWORDS = new Set(
  "the a an and or of for from with your official website home welcome blog kontakt o mnie oferta uslug usługa strony strona internetowych internetowa tworzenie fotografia fotograf portfolio projektow projekty poradnik sesja about contact privacy cookie cookies login signup shop store news sklep firma company group sp z oo"
    .split(" ")
    .filter(Boolean),
);

export const MAX_INTERNAL = 14;
export const MAX_GRAPH = 160;

export type TargetIntel = {
  snapshot: SiteSnapshot;
  outbound: Candidate[];
  tokens: string[];
  /** Terms describing the target's topic — the basis for link relevance scoring. */
  topicTerms: Map<string, number>;
  pagesCrawled: number;
  notes: string[];
  onPage: OnPageAudit | null;
  contentText: string;
  headings: { h1: string[]; h2: string[] };
};


function toIdentitySnapshot(archiveUrl: string): string {
  return archiveUrl.replace(/\/web\/(\d{8,14})\//i, "/web/$1id_/");
}

function parseTimemapSnapshots(text: string): { ts: string; url: string }[] {
  const out: { ts: string; url: string }[] = [];
  const re = /<(https?:\/\/web\.archive\.org\/web\/(\d{8,14})\/https?:\/\/[^>]+)>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const url = match[1] ?? "";
    const ts = match[2] ?? "";
    if (url && ts) out.push({ ts, url });
  }
  return out;
}

async function waybackClosest(url: string, budget: Budget): Promise<string | null> {
  try {
    const avail = await fetchJson<{
      archived_snapshots?: {
        closest?: { available?: boolean; url?: string; timestamp?: string };
      };
    }>(
      `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
      budget.timeout(6000),
      undefined,
      budget.signal,
    );
    const closest = avail.archived_snapshots?.closest;
    if (closest?.available && closest.url) return toIdentitySnapshot(closest.url);
  } catch {
    /* optional */
  }
  return null;
}

function pushCandidate(list: Candidate[], item: Candidate) {
  const key = pageKey(item.url);
  if (list.some((c) => pageKey(c.url) === key)) return;
  list.push(item);
}

function collectOutbound(
  html: string,
  baseUrl: string,
  host: string,
  outbound: Candidate[],
  internal: string[],
) {
  const anchors = html ? parseAnchors(html, baseUrl, { withPlacement: false }) : [];
  for (const a of anchors) {
    const h = hostFromUrl(a.href);
    if (!h) continue;
    if (isTargetHost(h, host)) {
      try {
        const path = new URL(a.href).pathname;
        if (isUsefulInternalPath(path)) internal.push(a.href);
      } catch {
        /* ignore */
      }
      continue;
    }
    if (isSkippableOutbound(a.href, h)) continue;
    pushCandidate(outbound, { url: a.href, title: a.text || h, via: "graph" });
  }
  for (const href of [...extractRelMe(html), ...extractJsonLdUrls(html)]) {
    let absolute = href;
    try {
      absolute = unwrapRedirect(new URL(href, baseUrl).href);
    } catch {
      continue;
    }
    const h = hostFromUrl(absolute);
    if (!h || isTargetHost(h, host) || isSkippableOutbound(absolute, h)) continue;
    pushCandidate(outbound, { url: absolute, title: h, via: "graph", boost: 1 });
  }
}

function pickInternalUrls(urls: string[], host: string, limit: number): string[] {
  const best = new Map<string, { url: string; score: number }>();
  for (const raw of urls) {
    try {
      const parsed = new URL(unwrapRedirect(raw));
      if (!isTargetHost(parsed.hostname, host)) continue;
      const path = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
      if (!isUsefulInternalPath(path)) continue;
      const canonical = `${parsed.protocol}//${parsed.hostname}${path}`;
      const score =
        scoreInternalPath(path) + (stripWww(parsed.hostname) === stripWww(host) ? 1 : 0);
      const key = `${stripWww(parsed.hostname)}${path}`;
      const prev = best.get(key);
      if (!prev || score > prev.score) best.set(key, { url: canonical, score });
    } catch {
      /* ignore */
    }
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.url);
}

function brandTokens(
  host: string,
  title: string | null,
  siteName: string | null,
  urls: string[],
): string[] {
  const tokens = new Set<string>();
  const base = sld(host);
  if (base.length >= 4) tokens.add(base);
  for (const raw of [siteName, title]) {
    if (!raw) continue;
    const cleaned = raw.replace(/\s*[|\-–—•·].*$/, "").trim();
    if (cleaned.length >= 4 && cleaned.length <= 40 && !STOPWORDS.has(cleaned.toLowerCase())) {
      tokens.add(cleaned);
    }
    const proper = cleaned.match(
      /[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]{3,}(?:\s+[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]{2,}){0,3}/g,
    );
    for (const phrase of proper ?? []) {
      if (!STOPWORDS.has(phrase.toLowerCase()) && phrase.length >= 5) {
        tokens.add(phrase);
      }
    }
  }
  for (const url of urls) {
    try {
      const u = new URL(url);
      const h = stripWww(u.hostname);
      if (
        !/facebook\.com|instagram\.com|linkedin\.com|github\.com|x\.com|twitter\.com|youtube\.com|tiktok\.com/.test(
          h,
        )
      ) {
        continue;
      }
      const bits = u.pathname.split("/").filter(Boolean);
      const slug =
        (bits[0] === "in" || bits[0] === "company" || bits[0] === "c" ? bits[1] : bits[0]) ?? "";
      const clean = slug.replace(/^@/, "");
      if (clean.length >= 4 && clean.length <= 40) tokens.add(clean);
    } catch {
      /* ignore */
    }
  }
  return [...tokens].slice(0, 8);
}

function extractSiteName(html: string): string | null {
  const og = html.match(
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{2,80})["']/i,
  );
  if (og?.[1]) return decodeText(og[1]).trim();
  const ld = html.match(/"name"\s*:\s*"([^"]{2,80})"/);
  return ld?.[1] ? decodeText(ld[1]).trim() : null;
}

function looksParked(
  html: string,
  title: string | null,
  finalHost: string,
  target: string,
): boolean {
  if (!isTargetHost(finalHost, target)) return true;
  const blob = `${title ?? ""} ${html.slice(0, 4000)}`.toLowerCase();
  if (
    /aftermarket|sprzedaży domeny|domain is for sale|buy this domain|sedo\.com|godaddy parking|hugedomains|parked domain|this domain may be for sale/.test(
      blob,
    )
  ) {
    return true;
  }
  return html.length < 1800;
}

/**
 * Builds a complete picture of the target: the live site, the archive,
 * subdomains, the sitemap, Common Crawl and the most informative pages. From
 * that we derive the outbound link graph — the best source of partner candidates.
 */
export async function inspectTarget(host: string, budget: Budget): Promise<TargetIntel> {
  const notes: string[] = [];
  const domain = registrableDomain(host);
  const liveUrls = [`https://${host}`, `https://www.${host}`, `http://${host}`];

  let liveUrl = `https://${host}`;
  let liveHtml = "";
  let liveStatus: number | null = null;
  let liveTitle: string | null = null;
  let https = true;
  let redirectHost: string | null = null;
  let pagesCrawled = 0;
  let description: string | null = null;
  let lang: string | null = null;
  let canonical: string | null = null;
  let robotsNoindex = false;

  for (const candidate of liveUrls) {
    try {
      const res = await fetchUsefulHtml(candidate, budget.timeout(9000), budget.signal, budget);
      if (res.status >= 400 && !res.text) continue;
      liveUrl = normalizeUrl(res.finalUrl || candidate);
      liveStatus = res.status;
      liveHtml = res.text;
      liveTitle = extractTitle(res.text);
      description = extractDescription(res.text);
      lang = extractLang(res.text);
      canonical = extractCanonical(res.text);
      robotsNoindex = extractRobotsMeta(res.text).noindex;
      https = liveUrl.startsWith("https://");
      redirectHost = hostFromUrl(liveUrl) || null;
      pagesCrawled += 1;
      break;
    } catch {
      /* next */
    }
  }
  if (!liveHtml) notes.push("The live version of the site could not be fetched.");

  /* --- Archiwum ------------------------------------------------------- */
  let archivedAt: string | null = null;
  let archiveUrl: string | null = null;
  let archiveHtml = "";
  let archiveTitle: string | null = null;

  try {
    const tm = await fetchText(
      `https://web.archive.org/web/timemap/link?url=${encodeURIComponent(`https://${host}/`)}`,
      {
        timeoutMs: budget.timeout(7000),
        maxBytes: 60_000,
        signal: budget.signal,
      },
    );
    if (tm.status < 400) {
      const snaps = parseTimemapSnapshots(tm.text);
      const latest = snaps[snaps.length - 1];
      if (latest) {
        archivedAt = `${latest.ts.slice(0, 4)}-${latest.ts.slice(4, 6)}-${latest.ts.slice(6, 8)}`;
        archiveUrl = latest.url;
      }
    }
  } catch {
    /* fallback below */
  }
  if (!archiveUrl) {
    archiveUrl = await waybackClosest(`https://${host}/`, budget);
    const ts = archiveUrl?.match(/\/web\/(\d{8,14})/)?.[1];
    if (ts) archivedAt = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
  }

  const parked = looksParked(liveHtml, liveTitle, redirectHost || host, host);
  const usedArchive = parked || liveHtml.length < 2500;

  const archiveTargets: string[] = [];
  if (archiveUrl) archiveTargets.push(toIdentitySnapshot(archiveUrl));
  if (usedArchive && archiveUrl && !archiveTargets.includes(archiveUrl)) {
    archiveTargets.push(archiveUrl);
  }
  for (const snapUrl of archiveTargets) {
    try {
      const snap = await fetchUsefulHtml(snapUrl, budget.timeout(13_000), budget.signal, budget);
      if (snap.status < 400 && snap.text.length > 1200) {
        archiveHtml = snap.text;
        archiveTitle = extractTitle(snap.text);
        pagesCrawled += 1;
        break;
      }
    } catch {
      /* try next snapshot form */
    }
  }
  if (usedArchive && archiveHtml) {
    notes.push("The link graph was built partly from Internet Archive copies.");
  }

  /* --- Map of the site's own URLs ----------------------------------------- */
  const outbound: Candidate[] = [];
  const internalPool: string[] = [];

  if (liveHtml && !parked) collectOutbound(liveHtml, liveUrl, host, outbound, internalPool);
  if (archiveHtml) {
    collectOutbound(archiveHtml, archiveUrl || liveUrl, host, outbound, internalPool);
  }

  const [sitemapRes, cdxRes, ccRes, certRes] = await Promise.allSettled([
    parked ? Promise.resolve([] as string[]) : fetchSitemapUrls(`https://${host}`, budget.signal),
    waybackCdxUrls(host, 150, budget.signal),
    scanCommonCrawl(host, budget.signal),
    scanCertSubdomains(domain, budget.signal),
  ]);

  const sitemapUrls = sitemapRes.status === "fulfilled" ? sitemapRes.value : [];
  const cdxUrls = cdxRes.status === "fulfilled" ? cdxRes.value.urls : [];
  const archiveFirstSeen = cdxRes.status === "fulfilled" ? cdxRes.value.firstSeen : null;
  const ccUrls = ccRes.status === "fulfilled" ? ccRes.value : [];
  const subdomains =
    certRes.status === "fulfilled"
      ? certRes.value.filter((s) => stripWww(s) !== stripWww(host)).slice(0, 12)
      : [];

  internalPool.push(...sitemapUrls, ...cdxUrls, ...ccUrls);
  for (const sub of subdomains.slice(0, 4)) {
    internalPool.push(`https://${sub}/`);
  }
  if (sitemapUrls.length > 0) {
    notes.push(`Target sitemap: ${sitemapUrls.length} URLs.`);
  }
  if (subdomains.length > 0) {
    notes.push(`Certificate Transparency: ${subdomains.length} subdomains.`);
  }

  /* --- RSS ------------------------------------------------------------ */
  const graphHtml = usedArchive && archiveHtml ? archiveHtml : liveHtml || archiveHtml;
  for (const href of extractAlternateRss(graphHtml).slice(0, 2)) {
    if (budget.spent(0.5)) break;
    let rssUrl = href;
    try {
      rssUrl = unwrapRedirect(new URL(href, usedArchive ? archiveUrl || liveUrl : liveUrl).href);
    } catch {
      continue;
    }
    if (usedArchive && archiveUrl) {
      const ts = archiveUrl.match(/\/web\/(\d{8,14})/)?.[1];
      if (ts) rssUrl = `https://web.archive.org/web/${ts}id_/${rssUrl}`;
    }
    try {
      const rss = await fetchText(rssUrl, {
        timeoutMs: budget.timeout(7000),
        maxBytes: 200_000,
        accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        signal: budget.signal,
      });
      if (rss.status >= 400) continue;
      pagesCrawled += 1;
      for (const item of rssItemLinks(usefulHtml(rss.text, 120_000))) {
        const clean = unwrapRedirect(item);
        if (isTargetHost(hostFromUrl(clean), host)) internalPool.push(clean);
      }
    } catch {
      /* optional */
    }
  }

  /* --- Subpages ------------------------------------------------------- */
  const internalLimit = budget.scale(MAX_INTERNAL, 18_000);
  const internals = pickInternalUrls(internalPool, host, internalLimit);
  const internalFetches = await mapLimit(internals, 4, async (pageUrl) => {
    if (budget.spent(0.62)) return null;
    const urls: string[] = [];
    if (!parked) urls.push(pageUrl);
    if (usedArchive || parked) {
      const snap = await waybackClosest(pageUrl, budget);
      if (snap) urls.push(snap);
    } else if (archiveUrl) {
      const ts = archiveUrl.match(/\/web\/(\d{8,14})/)?.[1];
      if (ts) urls.push(`https://web.archive.org/web/${ts}id_/${pageUrl}`);
    }
    for (const url of urls.slice(0, 2)) {
      try {
        const res = await fetchUsefulHtml(url, budget.timeout(8000), budget.signal, budget);
        if (res.status >= 400 || res.text.length < 800) continue;
        return { html: res.text, base: res.finalUrl || url };
      } catch {
        /* next url */
      }
    }
    return null;
  });

  const textChunks: string[] = [];
  if (liveHtml) textChunks.push(stripTags(liveHtml).slice(0, 20_000));
  if (archiveHtml) textChunks.push(stripTags(archiveHtml).slice(0, 12_000));

  for (const page of internalFetches) {
    if (!page) continue;
    pagesCrawled += 1;
    collectOutbound(page.html, page.base, host, outbound, internalPool);
    textChunks.push(stripTags(page.html).slice(0, 12_000));
  }

  /* --- Brand tokens and fill-ins ------------------------------------ */
  const title = (usedArchive ? archiveTitle : liveTitle) || liveTitle || archiveTitle;
  const siteName = extractSiteName(graphHtml || "");
  const tokens = brandTokens(
    host,
    title,
    siteName,
    outbound.map((o) => o.url),
  );

  pushCandidate(outbound, {
    url: `https://sitereport.netcraft.com/?url=https://${host}`,
    title: `Netcraft · ${host}`,
    via: "lookup",
  });

  const hasGithub = outbound.some((o) => stripWww(hostFromUrl(o.url)).endsWith("github.com"));
  if (!hasGithub) {
    const slugs = tokens
      .map((t) =>
        t
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-")
          .replace(/^-|-$/g, ""),
      )
      .filter((s) => s.length >= 4 && s.length <= 32 && !s.includes("."));
    const slug = [...new Set(slugs)][0];
    if (slug) {
      pushCandidate(outbound, {
        url: `https://github.com/${slug}`,
        title: slug,
        via: "github",
      });
    }
  }

  const snapshot: SiteSnapshot = {
    host,
    domain,
    url: liveUrl,
    title,
    description,
    lang,
    status: liveStatus,
    https,
    canonical,
    robotsNoindex,
    archivedAt,
    archiveFirstSeen,
    archiveUrl,
    parked,
    redirectHost: redirectHost && !isTargetHost(redirectHost, host) ? redirectHost : null,
    usedArchive,
    subdomains,
    domainRating: 0,
    outboundDomains: new Set(
      outbound
        .filter((o) => o.via === "graph")
        .map((o) => registrableDomain(hostFromUrl(o.url)))
        .filter(Boolean),
    ).size,
    sitemapUrls: sitemapUrls.length,
    indexedPages: new Set([...sitemapUrls, ...cdxUrls, ...ccUrls].map((u) => pageKey(u))).size,
  };

  const topicTerms = mergeTerms(
    [...textChunks, title ?? "", description ?? "", tokens.join(" ")],
    36,
  );

  const pageHtml = usedArchive && archiveHtml ? archiveHtml : liveHtml || archiveHtml;
  const headings = {
    h1: extractHeadings(pageHtml, "h1", 6),
    h2: extractHeadings(pageHtml, "h2", 10),
  };
  const contentText = textChunks.join(" ").slice(0, 40_000);
  const onPage = pageHtml
    ? auditOnPage({
        html: pageHtml,
        url: liveUrl,
        host,
        https,
        title,
        description,
        canonical,
        robotsNoindex,
        lang,
        primaryKeyword: tokens[0] ?? sld(host),
      })
    : null;

  return {
    snapshot,
    outbound: outbound.slice(0, MAX_GRAPH),
    tokens,
    topicTerms,
    pagesCrawled,
    notes,
    onPage,
    contentText,
    headings,
  };
}

