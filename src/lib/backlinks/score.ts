import { pageKey, registrableDomain, stripWww, tldOf } from "./parse.ts";
import { computeUrlRating } from "./graph.ts";
import type {
  Analytics,
  AnchorStat,
  Backlink,
  CountStat,
  DiscoverySource,
  HealthScore,
  Issue,
  Mention,
  OutboundDomain,
  ReferringDomain,
  SiteSnapshot,
  TargetPageStat,
} from "./types.ts";
import { plural } from "./text.ts";

const AUTHORITY_TLD = new Set([
  "gov",
  "edu",
  "mil",
  "int",
  "gov.pl",
  "edu.pl",
  "gov.uk",
  "ac.uk",
  "edu.au",
  "gov.au",
  "gov.br",
  "edu.br",
  "go.jp",
  "ac.jp",
  "gouv.fr",
  "gov.it",
]);

const TRUSTED_DOMAINS = new Set([
  "wikipedia.org",
  "wikimedia.org",
  "wikidata.org",
  "github.com",
  "ycombinator.com",
  "stackoverflow.com",
  "stackexchange.com",
  "mozilla.org",
  "w3.org",
  "arxiv.org",
  "nature.com",
  "who.int",
  "europa.eu",
  "un.org",
  "bbc.co.uk",
  "nytimes.com",
  "reuters.com",
  "gov.pl",
  "nasa.gov",
]);

const RISKY_TLD = new Set([
  "xyz",
  "top",
  "icu",
  "click",
  "link",
  "buzz",
  "loan",
  "work",
  "gq",
  "cf",
  "tk",
  "ml",
  "ga",
  "rest",
  "bar",
  "cam",
  "monster",
  "quest",
  "sbs",
  "cyou",
]);

const SPAM_WORD_RE =
  /(casino|kasyno|bet(ting)?|poker|slot|viagra|cialis|porn|xxx|escort|sex(shop)?|replica|payday|loan|kredyt-?chwilowka|forex|crypto-?signal|pozycjonowanie-?tanio|katalog-?stron|seo-?katalog|link-?building-?cheap|essay-?writing|dofollow-?links)/i;

const DIRECTORY_RE =
  /(katalog|directory|dir\.|linki|links?24|spis-?firm|firmy-?katalog|wizytowk|baza-?firm|dodaj-?firme|free-?listing)/i;

/* ------------------------------------------------------------------ */
/* Identyfikatory                                                      */
/* ------------------------------------------------------------------ */

export function backlinkId(input: {
  sourceUrl: string;
  targetUrl: string;
  anchor: string;
}): string {
  const source = pageKey(input.sourceUrl);
  const target = pageKey(input.targetUrl);
  const anchor = input.anchor.trim().toLowerCase().slice(0, 60);
  return `${source}»${target}»${anchor}`;
}

/* ------------------------------------------------------------------ */
/* Domain score                                                        */
/* ------------------------------------------------------------------ */

export type DomainSignals = {
  host: string;
  firstSeen?: string | null;
  wikipedia?: boolean;
  linkingPages?: number;
  https?: boolean;
  lang?: string | null;
  discoveredVia?: DiscoverySource;
};

/**
 * A domain authority proxy (0–100). Without paid APIs there is no way to compute DR,
 * so we combine public signals: TLD, age in the archive, presence in Wikipedia,
 * the number of linking pages and the structure of the name.
 */
export function domainScore(signals: DomainSignals): number {
  const host = stripWww(signals.host);
  const domain = registrableDomain(host);
  const tld = tldOf(host);
  let score = 38;

  if (TRUSTED_DOMAINS.has(domain)) score += 34;
  if (AUTHORITY_TLD.has(tld)) score += 26;
  else if (tld === "org" || tld === "int") score += 8;
  else if (tld === "com" || tld === "net" || tld === "pl" || tld === "io") score += 4;
  if (RISKY_TLD.has(tld)) score -= 18;

  if (signals.wikipedia) score += 10;
  if (signals.https) score += 3;

  const year = Number((signals.firstSeen ?? "").slice(0, 4));
  if (Number.isFinite(year) && year > 1990) {
    const age = new Date().getFullYear() - year;
    score += Math.max(0, Math.min(18, Math.round(age * 1.2)));
  }

  const pages = signals.linkingPages ?? 1;
  score += Math.min(8, Math.round(Math.log2(pages + 1) * 3));

  const label = domain.split(".")[0] ?? "";
  const hyphens = (label.match(/-/g) ?? []).length;
  if (hyphens >= 3) score -= 12;
  else if (hyphens === 2) score -= 5;
  if (/\d{3,}/.test(label)) score -= 8;
  if (label.length > 22) score -= 6;
  const subdepth = host.split(".").length - domain.split(".").length;
  if (subdepth >= 2) score -= 6;

  return clamp(Math.round(score), 1, 100);
}

export type SpamSignals = {
  host: string;
  anchors: string[];
  placement?: string;
  sitewide?: boolean;
  outboundHeavy?: boolean;
  title?: string;
};

/** Spam risk / low-quality link risk (0–100). */
export function spamScore(signals: SpamSignals): number {
  const host = stripWww(signals.host);
  const domain = registrableDomain(host);
  const tld = tldOf(host);
  const label = domain.split(".")[0] ?? "";
  let score = 4;

  const blob = `${host} ${signals.title ?? ""} ${signals.anchors.join(" ")}`;
  if (SPAM_WORD_RE.test(blob)) score += 55;
  if (DIRECTORY_RE.test(`${host} ${signals.title ?? ""}`)) score += 22;
  if (RISKY_TLD.has(tld)) score += 22;
  const hyphens = (label.match(/-/g) ?? []).length;
  if (hyphens >= 3) score += 18;
  else if (hyphens === 2) score += 8;
  if (/\d{4,}/.test(label)) score += 12;
  if (label.length > 25) score += 8;
  if (signals.sitewide && (signals.placement === "footer" || signals.placement === "sidebar")) {
    score += 18;
  }
  if (signals.outboundHeavy) score += 10;
  if (TRUSTED_DOMAINS.has(domain) || AUTHORITY_TLD.has(tld)) score = Math.min(score, 8);

  return clamp(Math.round(score), 0, 100);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

const VIA_WEIGHT: Record<DiscoverySource, number> = {
  graph: 900,
  page: 720,
  wikipedia: 700,
  github: 600,
  "hacker-news": 560,
  bing: 520,
  duckduckgo: 510,
  mojeek: 500,
  stackexchange: 460,
  reddit: 440,
  news: 380,
  bluesky: 300,
  urlscan: 240,
  commoncrawl: 220,
  sitemap: 200,
  archive: 180,
  lookup: 80,
};

const PLACEMENT_WEIGHT: Record<string, number> = {
  content: 260,
  comment: 60,
  sidebar: 40,
  navigation: 30,
  footer: 20,
  unknown: 80,
};

function isLowQualityWikiTitle(title: string): boolean {
  return /^(Talk|User|User talk|Wikipedia|File|Template|Help|Draft|Kategoria|Dyskusja|Wikipedysta|Wikipedystka|Benutzer|Diskussion|Fichier|Discussion|Usuario|Spezial|Portal|Szablon|Plik):/i.test(
    title,
  );
}

/** The combined value of a link — it drives report ordering and trimming. */
export function scoreBacklink(item: Backlink): number {
  let score = VIA_WEIGHT[item.discoveredVia] ?? 200;
  score += PLACEMENT_WEIGHT[item.placement] ?? 60;
  score += item.domainScore * 4;
  score -= item.spamScore * 5;
  if (item.effectiveFollow) score += 180;
  if (item.rel === "sponsored" || item.rel === "ugc") score -= 60;
  if (item.sitewide) score -= 90;
  if (item.flags.includes("broken-target")) score -= 220;
  if (item.flags.includes("noindex-source")) score -= 260;
  score += (item.relevance - 50) * 2.5;
  if (item.flags.includes("off-topic")) score -= 120;
  if (item.flags.includes("redirected-target")) score -= 40;
  if (item.state === "lost") score -= 500;
  if (item.anchorType === "brand" || item.anchorType === "long-tail") score += 60;
  if (item.anchorType === "empty") score -= 40;
  if (item.discoveredVia === "wikipedia" && isLowQualityWikiTitle(item.sourceTitle)) {
    score -= 400;
  }
  if (item.verified) score += 120;
  if (item.flags.includes("serp-coranker")) score += 90;
  return score;
}

export function sortBacklinks(items: Backlink[]): Backlink[] {
  return [...items].sort((a, b) => {
    const s = scoreBacklink(b) - scoreBacklink(a);
    if (s !== 0) return s;
    const host = a.sourceDomain.localeCompare(b.sourceDomain);
    if (host !== 0) return host;
    return a.sourceUrl.localeCompare(b.sourceUrl);
  });
}

/** A per-domain link cap — one site must not dominate the report. */
export function capPerDomain(items: Backlink[], perDomain: number): Backlink[] {
  const counts = new Map<string, number>();
  const out: Backlink[] = [];
  for (const item of items) {
    const domain = item.sourceDomain || stripWww(item.sourceHost);
    const limit =
      item.discoveredVia === "wikipedia" || item.discoveredVia === "hacker-news"
        ? perDomain
        : Math.min(6, perDomain);
    const n = counts.get(domain) ?? 0;
    if (n >= limit) continue;
    counts.set(domain, n + 1);
    out.push(item);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Profile analytics                                                   */
/* ------------------------------------------------------------------ */

function toCountStats(map: Map<string, number>, total: number, limit = 12): CountStat[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({
      key,
      count,
      share: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    }));
}

function bump(map: Map<string, number>, key: string, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

export type DomainExtras = {
  ranks?: Map<string, number>;
  ips?: Map<string, string[]>;
  lostByDomain?: Map<string, number>;
  reciprocal?: Set<string>;
};

export function buildReferringDomains(
  items: Backlink[],
  extras: DomainExtras = {},
): ReferringDomain[] {
  const map = new Map<string, ReferringDomain & { pageSet: Set<string> }>();
  for (const item of items) {
    const domain = item.sourceDomain || stripWww(item.sourceHost);
    const current = map.get(domain);
    if (!current) {
      map.set(domain, {
        domain,
        links: 1,
        pages: 1,
        pageSet: new Set([pageKey(item.sourceUrl)]),
        dofollow: item.effectiveFollow ? 1 : 0,
        contentLinks: item.placement === "content" ? 1 : 0,
        domainScore: item.domainScore,
        spamScore: item.spamScore,
        tld: tldOf(item.sourceHost),
        firstSeen: item.firstSeen,
        sources: [item.discoveredVia],
        sampleUrl: item.sourceUrl,
        sampleAnchor: item.anchor,
        sitewide: item.sitewide,
        rank: 0,
        ips: [],
        subnet: null,
        lostLinks: 0,
        reciprocal: false,
        relevance: item.relevance,
      });
      continue;
    }
    current.links += 1;
    current.pageSet.add(pageKey(item.sourceUrl));
    current.pages = current.pageSet.size;
    if (item.effectiveFollow) current.dofollow += 1;
    if (item.placement === "content") current.contentLinks += 1;
    current.domainScore = Math.max(current.domainScore, item.domainScore);
    current.spamScore = Math.max(current.spamScore, item.spamScore);
    current.sitewide = current.sitewide || item.sitewide;
    current.relevance = Math.round((current.relevance + item.relevance) / 2);
    if (!current.sources.includes(item.discoveredVia)) {
      current.sources.push(item.discoveredVia);
    }
    if (!current.firstSeen && item.firstSeen) current.firstSeen = item.firstSeen;
    if (!current.sampleAnchor && item.anchor) current.sampleAnchor = item.anchor;
  }

  return [...map.values()]
    .map(({ pageSet: _pageSet, ...rest }) => {
      const ips = extras.ips?.get(rest.domain) ?? [];
      const first = ips[0];
      return {
        ...rest,
        rank: extras.ranks?.get(rest.domain) ?? 0,
        ips,
        subnet: first ? subnetOf(first) : null,
        lostLinks: extras.lostByDomain?.get(rest.domain) ?? 0,
        reciprocal: extras.reciprocal?.has(rest.domain) ?? false,
      };
    })
    .sort(
      (a, b) =>
        b.domainScore + b.rank / 2 - (a.domainScore + a.rank / 2) ||
        b.dofollow - a.dofollow ||
        b.links - a.links,
    );
}

function subnetOf(ip: string): string | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

/** The target's strongest pages — the equivalent of a "best by links" report. */
export function buildTargetPages(
  items: Backlink[],
  target: SiteSnapshot,
  statuses?: Map<string, number>,
): TargetPageStat[] {
  const map = new Map<string, { links: Backlink[]; domains: Set<string> }>();
  for (const item of items) {
    const path = item.targetPath || "/";
    const entry = map.get(path) ?? { links: [], domains: new Set<string>() };
    entry.links.push(item);
    entry.domains.add(item.sourceDomain);
    map.set(path, entry);
  }
  return [...map.entries()]
    .map(([path, entry]) => ({
      path,
      url: `https://${target.host}${path === "/" ? "/" : path}`,
      links: entry.links.length,
      domains: entry.domains.size,
      dofollow: entry.links.filter((l) => l.effectiveFollow).length,
      bestDomainScore: Math.max(...entry.links.map((l) => l.domainScore), 0),
      urlRating: computeUrlRating(entry.links),
      status: statuses?.get(path) ?? entry.links[0]?.targetStatus ?? null,
    }))
    .sort((a, b) => b.urlRating - a.urlRating || b.domains - a.domains)
    .slice(0, 25);
}

export type AnalyticsExtras = DomainExtras & {
  outbound?: OutboundDomain[];
  lostLinks?: Backlink[];
  visibility?: number;
  rankedKeywords?: number;
  keywordCount?: number;
  onPageIssues?: Issue[];
};


export function buildAnalytics(
  backlinks: Backlink[],
  mentions: Mention[],
  target: SiteSnapshot,
  extras: AnalyticsExtras = {},
): Analytics {
  const total = backlinks.length;
  const referringDomains = buildReferringDomains(backlinks, extras);

  const anchorMap = new Map<string, { count: number; domains: Set<string>; type: string }>();
  const anchorTypes = new Map<string, number>();
  const placements = new Map<string, number>();
  const rels = new Map<string, number>();
  const tlds = new Map<string, number>();
  const languages = new Map<string, number>();
  const sources = new Map<string, number>();
  const targetPages = new Map<string, number>();

  for (const item of backlinks) {
    const anchorKey = (item.anchor || "(no anchor text)").trim().slice(0, 70);
    const anchor = anchorMap.get(anchorKey);
    if (anchor) {
      anchor.count += 1;
      anchor.domains.add(item.sourceDomain);
    } else {
      anchorMap.set(anchorKey, {
        count: 1,
        domains: new Set([item.sourceDomain]),
        type: item.anchorType,
      });
    }
    bump(anchorTypes, item.anchorType);
    bump(placements, item.placement);
    bump(rels, item.effectiveFollow ? "dofollow" : item.rel);
    bump(tlds, tldOf(item.sourceHost) || "?");
    bump(languages, item.sourceLang ?? "?");
    bump(sources, item.discoveredVia);
    bump(targetPages, item.targetPath || "/");
  }

  const anchors: AnchorStat[] = [...anchorMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20)
    .map(([text, value]) => ({
      text,
      type: value.type as AnchorStat["type"],
      count: value.count,
      domains: value.domains.size,
      share: total > 0 ? Math.round((value.count / total) * 1000) / 10 : 0,
    }));

  const growth = new Map<string, number>();
  for (const domain of referringDomains) {
    growth.set(
      domain.firstSeen ? domain.firstSeen.slice(0, 4) : "nieznany",
      (growth.get(domain.firstSeen ? domain.firstSeen.slice(0, 4) : "nieznany") ?? 0) + 1,
    );
  }
  const growthStats = [...growth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, count]) => ({
      key,
      count,
      share:
        referringDomains.length > 0 ? Math.round((count / referringDomains.length) * 1000) / 10 : 0,
    }));

  const issues = buildIssues(
    backlinks,
    mentions,
    referringDomains,
    target,
    extras.lostLinks ?? [],
    extras,
  );
  const health = buildHealth(backlinks, referringDomains, anchors, issues, extras);


  return {
    referringDomains,
    anchors,
    anchorTypes: toCountStats(anchorTypes, total),
    placements: toCountStats(placements, total),
    rels: toCountStats(rels, total),
    tlds: toCountStats(tlds, total),
    languages: toCountStats(languages, total),
    sources: toCountStats(sources, total, 16),
    topTargetPages: toCountStats(targetPages, total, 10),
    growth: growthStats,
    targetPages: buildTargetPages(backlinks, target),
    outbound: extras.outbound ?? [],
    issues,
    health,
  };
}

function buildIssues(
  backlinks: Backlink[],
  mentions: Mention[],
  domains: ReferringDomain[],
  target: SiteSnapshot,
  lostLinks: Backlink[] = [],
  extras: AnalyticsExtras = {},
): Issue[] {
  const issues: Issue[] = [];
  const total = backlinks.length || 1;

  const broken = backlinks.filter((b) => b.flags.includes("broken-target"));
  if (broken.length > 0) {
    issues.push({
      id: "broken",
      severity: "high",
      title: "Broken backlinks",
      detail:
        "Someone links to a URL that returns an error. A 301 redirect to a working page recovers the full value of those links.",
      count: broken.length,
      samples: broken.slice(0, 5).map((b) => `${b.sourceHost} → ${b.targetPath}`),
    });
  }

  const noindex = backlinks.filter((b) => b.flags.includes("noindex-source"));
  if (noindex.length > 0) {
    issues.push({
      id: "noindex",
      severity: "medium",
      title: "Links from noindex pages",
      detail:
        "The source page is excluded from the index, so the link passes virtually no value to the search engine.",
      count: noindex.length,
      samples: noindex.slice(0, 5).map((b) => b.sourceUrl),
    });
  }

  const spam = domains.filter((d) => d.spamScore >= 55);
  if (spam.length > 0) {
    issues.push({
      id: "spam",
      severity: spam.length > 3 ? "high" : "medium",
      title: "High spam-risk domains",
      detail:
        "The domain name, anchors or site type point to a directory or link farm. Consider disavowing after manual review.",
      count: spam.length,
      samples: spam.slice(0, 5).map((d) => `${d.domain} (${d.spamScore}/100)`),
    });
  }

  const boiler = backlinks.filter((b) => b.placement === "footer" || b.placement === "navigation");
  if (boiler.length / total > 0.5 && backlinks.length >= 6) {
    issues.push({
      id: "boilerplate",
      severity: "medium",
      title: "Template links dominate",
      detail:
        "Most links sit in a footer or menu. Search engines weigh those far less than links inside article content.",
      count: boiler.length,
      samples: boiler.slice(0, 5).map((b) => `${b.sourceHost} · ${b.placement}`),
    });
  }

  const exact = backlinks.filter((b) => b.anchorType === "exact-match");
  if (exact.length / total > 0.35 && backlinks.length >= 8) {
    issues.push({
      id: "anchor-overopt",
      severity: "medium",
      title: "Unnatural anchor distribution",
      detail:
        "Too large a share of exact-match anchors looks like bought links. A healthy profile rests on the brand name and the URL.",
      count: exact.length,
      samples: [...new Set(exact.map((b) => b.anchor))].slice(0, 5),
    });
  }

  const offTopic = backlinks.filter((b) => b.relevance < 20);
  if (offTopic.length / total > 0.4 && backlinks.length >= 6) {
    issues.push({
      id: "off-topic",
      severity: "medium",
      title: "Off-topic links",
      detail:
        "Most linking pages write about something entirely different from the target. Links from topically aligned sites are worth much more and carry less filter risk.",
      count: offTopic.length,
      samples: offTopic.slice(0, 5).map((b) => `${b.sourceHost} (${b.relevance}/100)`),
    });
  }

  const redirected = backlinks.filter((b) => b.flags.includes("redirected-target"));
  if (redirected.length > 0) {
    issues.push({
      id: "redirected",
      severity: "low",
      title: "Links land on a redirect",
      detail:
        "The linked URL redirects elsewhere. Every hop loses some value and slows the visit — it is worth asking for the link to be updated.",
      count: redirected.length,
      samples: redirected.slice(0, 5).map((b) => `${b.targetPath} → ${b.targetFinalUrl ?? "?"}`),
    });
  }

  const dofollow = backlinks.filter((b) => b.effectiveFollow).length;
  if (backlinks.length >= 5 && dofollow / total < 0.2) {
    issues.push({
      id: "nofollow-heavy",
      severity: "low",
      title: "Profile dominated by nofollow",
      detail:
        "The links bring traffic and visibility but pass almost no PageRank. Editorial mentions inside content are worth pursuing.",
      count: total - dofollow,
      samples: [],
    });
  }

  const opportunities = mentions.filter((m) => m.linkOpportunity);
  if (opportunities.length > 0) {
    issues.push({
      id: "unlinked",
      severity: "info",
      title: "Unlinked mentions",
      detail:
        "These pages write about the brand without linking. A short request to add a link is the cheapest way to a new backlink.",
      count: opportunities.length,
      samples: opportunities.slice(0, 5).map((m) => m.sourceHost),
    });
  }

  if (lostLinks.length > 0) {
    issues.push({
      id: "lost",
      severity: "high",
      title: "Lost backlinks",
      detail:
        "These pages linked to the target in an archived version and no longer do. One email to the editors is usually enough to get it back.",
      count: lostLinks.length,
      samples: lostLinks.slice(0, 5).map((l) => `${l.sourceHost} (ostatnio ${l.lastSeen ?? "?"})`),
    });
  }

  const subnets = new Map<string, number>();
  for (const domain of domains) {
    if (!domain.subnet) continue;
    subnets.set(domain.subnet, (subnets.get(domain.subnet) ?? 0) + 1);
  }
  const crowded = [...subnets.entries()].filter(([, count]) => count >= 4);
  if (crowded.length > 0) {
    issues.push({
      id: "subnet",
      severity: "medium",
      title: "Domains in the same subnet",
      detail:
        "Several referring domains share a single /24 IP range. That is the usual trace of a private blog network or a single host — worth checking by hand.",
      count: crowded.reduce((sum, [, count]) => sum + count, 0),
      samples: crowded.slice(0, 5).map(([subnet, count]) => `${subnet} · ${plural(count, "domain")}`),
    });
  }

  const reciprocal = domains.filter((d) => d.reciprocal);
  if (reciprocal.length >= 3 && reciprocal.length / Math.max(domains.length, 1) > 0.3) {
    issues.push({
      id: "reciprocal",
      severity: "low",
      title: "Many reciprocal links",
      detail:
        "More than a third of referring domains get a link back from you. Large-scale link exchange is devalued by search engines.",
      count: reciprocal.length,
      samples: reciprocal.slice(0, 5).map((d) => d.domain),
    });
  }

  if (target.robotsNoindex) {
    issues.push({
      id: "target-noindex",
      severity: "high",
      title: "The target has meta robots noindex",
      detail:
        "The scanned page blocks indexing itself — no backlink will improve its position until that is removed.",
      count: 1,
      samples: [target.url],
    });
  }

  if (target.parked) {
    issues.push({
      id: "parked",
      severity: "high",
      title: "The domain looks parked",
      detail:
        "No real content at this address. The report is based on an archived copy and the historical link graph.",
      count: 1,
      samples: [target.url],
    });
  }

  const keywordCount = extras.keywordCount ?? 0;
  const ranked = extras.rankedKeywords ?? 0;
  if (keywordCount >= 2 && ranked === 0) {
    issues.push({
      id: "serp-invisible",
      severity: "medium",
      title: "No top-10 positions",
      detail:
        "For keywords taken from the page and its anchors, the target does not appear in organic results. Content backlinks and on-page fixes (title, H1) are the fastest route to visibility.",
      count: keywordCount,
      samples: [],
    });
  }

  for (const issue of extras.onPageIssues ?? []) {
    if (issue.severity === "info") continue;
    if (
      issues.some(
        (existing) =>
          existing.id === issue.id || (existing.id === "target-noindex" && issue.id === "seo-noindex"),
      )
    ) {
      continue;
    }
    issues.push(issue);
  }

  return issues.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

function severityRank(severity: Issue["severity"]): number {
  return severity === "high" ? 0 : severity === "medium" ? 1 : severity === "low" ? 2 : 3;
}

function buildHealth(
  backlinks: Backlink[],
  domains: ReferringDomain[],
  anchors: AnchorStat[],
  issues: Issue[],
  extras: AnalyticsExtras = {},
): HealthScore {
  const total = backlinks.length;
  const parts: HealthScore["parts"] = [];

  const domainScorePart = Math.min(24, Math.round(Math.log2(domains.length + 1) * 7));
  parts.push({
    key: "domains",
    label: "Domain reach",
    score: domainScorePart,
    max: 24,
    hint: `${domains.length} referring domains`,
  });

  const dofollow = backlinks.filter((b) => b.effectiveFollow).length;
  const followRatio = total > 0 ? dofollow / total : 0;
  const followPart = Math.round(Math.min(1, followRatio / 0.45) * 18);
  parts.push({
    key: "follow",
    label: "Dofollow share",
    score: followPart,
    max: 18,
    hint: `${Math.round(followRatio * 100)}% of links pass value`,
  });

  const avgAuthority =
    domains.length > 0 ? domains.reduce((sum, d) => sum + d.domainScore, 0) / domains.length : 0;
  const authorityPart = Math.round((avgAuthority / 100) * 18);
  parts.push({
    key: "authority",
    label: "Domain quality",
    score: authorityPart,
    max: 18,
    hint: `Average score ${Math.round(avgAuthority)}/100`,
  });

  const contentLinks = backlinks.filter((b) => b.placement === "content").length;
  const contentPart = Math.round(Math.min(1, total > 0 ? contentLinks / total / 0.4 : 0) * 15);
  parts.push({
    key: "placement",
    label: "Links in content",
    score: contentPart,
    max: 15,
    hint: `${contentLinks} of ${total} links sit in content`,
  });

  const avgRelevance = total > 0 ? backlinks.reduce((sum, b) => sum + b.relevance, 0) / total : 0;
  const relevancePart = Math.round(Math.min(1, avgRelevance / 55) * 12);
  parts.push({
    key: "relevance",
    label: "Topical match",
    score: relevancePart,
    max: 12,
    hint: `Average topical match ${Math.round(avgRelevance)}/100`,
  });

  const topShare = anchors[0]?.share ?? 0;
  const diversityPart = Math.round(Math.max(0, Math.min(1, (100 - topShare) / 70)) * 8);
  parts.push({
    key: "anchors",
    label: "Anchor diversity",
    score: diversityPart,
    max: 8,
    hint: anchors[0] ? `The most common anchor is ${topShare}% of the profile` : "No anchor data",
  });

  const spamDomains = domains.filter((d) => d.spamScore >= 55).length;
  const riskPart = Math.max(
    0,
    6 - spamDomains * 2 - issues.filter((i) => i.severity === "high").length,
  );
  parts.push({
    key: "risk",
    label: "Profile safety",
    score: riskPart,
    max: 6,
    hint: spamDomains > 0 ? `${plural(spamDomains, "risky domain")}` : "No spam signals",
  });

  const vis = extras.visibility ?? 0;
  const ranked = extras.rankedKeywords ?? 0;
  const visPart = Math.round(Math.min(1, vis / 70) * 10);
  parts.push({
    key: "serp",
    label: "SERP visibility",
    score: visPart,
    max: 10,
    hint:
      ranked > 0
        ? `${plural(ranked, "keyword")} in the top 10 · visibility ${vis}/100`
        : vis > 0
          ? `Visibility ${vis}/100`
          : "No positions in the checked keywords",
  });

  const totalScore = clamp(
    parts.reduce((sum, part) => sum + part.score, 0),
    0,
    100,
  );
  const grade: HealthScore["grade"] =
    totalScore >= 80
      ? "A"
      : totalScore >= 62
        ? "B"
        : totalScore >= 45
          ? "C"
          : totalScore >= 28
            ? "D"
            : "E";

  return { total: totalScore, grade, parts };
}
