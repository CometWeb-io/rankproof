import { registrableDomain, stripWww, tldOf } from "./parse.ts";
import type {
  Backlink,
  DomainSegment,
  LinkVelocity,
  ReferringDomain,
  SegmentStat,
  TrendPoint,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* Referring domain segmentation                                      */
/* ------------------------------------------------------------------ */

const MEDIA =
  /(gazeta|wyborcza|onet|wp\.pl|interia|rp\.pl|money|forbes|businessinsider|newsweek|reuters|bbc|guardian|nytimes|press|news|dziennik|radio|tvn|polsatnews)/i;
const FORUM =
  /(reddit|forum|quora|stackexchange|stackoverflow|discourse|wykop|elektroda|4programmers)/i;
const SOCIAL =
  /(facebook|twitter|^x\.com|instagram|linkedin|youtube|tiktok|pinterest|bsky|mastodon|medium|substack)/i;
const CODE = /(github|gitlab|bitbucket|npmjs|pypi|sourceforge|codeberg|dev\.to)/i;
const SHOP = /(allegro|amazon|ebay|shop|sklep|store|ceneo|olx|etsy)/i;
const DIRECTORY = /(katalog|directory|listing|wizytowk|firmy|panorama|yellowpages|spis|baza-firm)/i;
const BLOG = /(blog|wordpress|blogspot|weebly|wixsite|ghost\.io|hashnode)/i;

/** Guesses the site type from domain and title — no external classifiers. */
export function classifySegment(host: string, title = ""): DomainSegment {
  const domain = registrableDomain(stripWww(host));
  const tld = tldOf(host);
  const blob = `${domain} ${title}`;

  if (tld === "edu" || tld === "gov" || /\.(edu|gov)\.[a-z]{2}$/.test(domain)) return "edu-gov";
  if (domain === "wikipedia.org" || domain.endsWith("wikimedia.org")) return "edu-gov";
  if (CODE.test(domain)) return "code";
  if (SOCIAL.test(domain)) return "social";
  if (FORUM.test(blob)) return "forum";
  if (MEDIA.test(blob)) return "media";
  if (DIRECTORY.test(blob)) return "directory";
  if (SHOP.test(blob)) return "shop";
  if (BLOG.test(blob)) return "blog";
  if (tld === "com" || tld === "pl" || tld === "net" || tld === "io") return "company";
  return "other";
}

/** Target share of a segment within a healthy, diverse link profile. */
const SEGMENT_TARGET: Record<DomainSegment, { target: number; max: number }> = {
  media: { target: 15, max: 60 },
  blog: { target: 20, max: 60 },
  forum: { target: 10, max: 40 },
  "edu-gov": { target: 5, max: 40 },
  directory: { target: 5, max: 20 },
  social: { target: 10, max: 45 },
  shop: { target: 5, max: 35 },
  company: { target: 20, max: 65 },
  code: { target: 5, max: 40 },
  other: { target: 5, max: 40 },
};

const SEGMENT_ORDER: DomainSegment[] = [
  "media",
  "blog",
  "forum",
  "edu-gov",
  "company",
  "shop",
  "directory",
  "social",
  "code",
  "other",
];

/**
 * The profile broken down by site type. A profile made entirely of directories
 * or entirely of social media looks artificial — this breakdown shows it at once.
 */
export function buildSegments(domains: ReferringDomain[], backlinks: Backlink[]): SegmentStat[] {
  const titleByDomain = new Map<string, string>();
  for (const link of backlinks) {
    if (!titleByDomain.has(link.sourceDomain))
      titleByDomain.set(link.sourceDomain, link.sourceTitle);
  }

  const acc = new Map<DomainSegment, { domains: number; links: number; score: number }>();
  for (const domain of domains) {
    const segment = classifySegment(domain.domain, titleByDomain.get(domain.domain) ?? "");
    const current = acc.get(segment) ?? { domains: 0, links: 0, score: 0 };
    current.domains += 1;
    current.links += domain.links;
    current.score += domain.domainScore;
    acc.set(segment, current);
  }

  const totalDomains = Math.max(1, domains.length);
  return SEGMENT_ORDER.filter((segment) => acc.has(segment)).map((segment) => {
    const entry = acc.get(segment)!;
    const share = Math.round((entry.domains / totalDomains) * 100);
    const target = SEGMENT_TARGET[segment];
    return {
      segment,
      domains: entry.domains,
      links: entry.links,
      share,
      avgDomainScore: Math.round(entry.score / entry.domains),
      target: target.target,
      verdict: share > target.max ? "high" : share < target.target / 3 ? "low" : "ok",
    };
  });
}

/* ------------------------------------------------------------------ */
/* Link acquisition momentum                                        */
/* ------------------------------------------------------------------ */

/** Acquisition needs dated relation cohorts; archive age and sampled scan counts cannot supply it. */
export function buildVelocity(domains: ReferringDomain[], _trend: TrendPoint[] = []): LinkVelocity {
  const lostLinks = domains.reduce((sum, domain) => sum + domain.lostLinks, 0);
  const totalLinks = domains.reduce((sum, domain) => sum + domain.links, 0);
  return {
    last12m: 0,
    perMonth: 0,
    trend: 0,
    lostRatio: Math.round((lostLinks / Math.max(1, totalLinks + lostLinks)) * 100),
    verdict: "unknown",
    hint: "Acquisition velocity is unknown: domain archive dates and changing discovery samples are not dated link-observation cohorts.",
  };
}
