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

const MEDIA = /(gazeta|wyborcza|onet|wp\.pl|interia|rp\.pl|money|forbes|businessinsider|newsweek|reuters|bbc|guardian|nytimes|press|news|dziennik|radio|tvn|polsatnews)/i;
const FORUM = /(reddit|forum|quora|stackexchange|stackoverflow|discourse|wykop|elektroda|4programmers)/i;
const SOCIAL = /(facebook|twitter|^x\.com|instagram|linkedin|youtube|tiktok|pinterest|bsky|mastodon|medium|substack)/i;
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
export function buildSegments(
  domains: ReferringDomain[],
  backlinks: Backlink[],
): SegmentStat[] {
  const titleByDomain = new Map<string, string>();
  for (const link of backlinks) {
    if (!titleByDomain.has(link.sourceDomain)) titleByDomain.set(link.sourceDomain, link.sourceTitle);
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

/**
 * The pace at which referring domains are gained. We rely on when a domain was
 * first seen in the archive (`firstSeen`) — the only free date signal available.
 * The trend compares the last 12 months with the 12 before; a sudden jump often
 * signals bought links, and a fall to zero signals abandoned marketing.
 */
export function buildVelocity(
  domains: ReferringDomain[],
  trend: TrendPoint[] = [],
): LinkVelocity {
  const now = Date.now();
  const year = 365 * 24 * 3600 * 1000;
  let last12 = 0;
  let previous12 = 0;
  let dated = 0;

  for (const domain of domains) {
    if (!domain.firstSeen) continue;
    const time = Date.parse(domain.firstSeen);
    if (!Number.isFinite(time)) continue;
    dated += 1;
    const age = now - time;
    if (age <= year) last12 += 1;
    else if (age <= year * 2) previous12 += 1;
  }

  const lostLinks = domains.reduce((sum, domain) => sum + domain.lostLinks, 0);
  const totalLinks = Math.max(1, domains.reduce((sum, domain) => sum + domain.links, 0));
  const lostRatio = Math.round((lostLinks / (totalLinks + lostLinks)) * 100);

  if (dated < 3) {
    // Without archive dates, try to read the pace from scan history.
    if (trend.length >= 2) {
      const first = trend[0]!;
      const last = trend[trend.length - 1]!;
      const delta = last.referringDomains - first.referringDomains;
      return {
        last12m: Math.max(0, delta),
        perMonth: Math.round(Math.max(0, delta) * 10) / 10,
        trend: 0,
        lostRatio,
        verdict: delta > 0 ? "growing" : delta < 0 ? "declining" : "stable",
        hint: "Velocity computed from scan history — the archive does not know the age of most domains.",
      };
    }
    return {
      last12m: 0,
      perMonth: 0,
      trend: 0,
      lostRatio,
      verdict: "unknown",
      hint: "Too few first-seen dates to compute velocity. Repeat the scan in a few weeks.",
    };
  }

  const perMonth = Math.round((last12 / 12) * 10) / 10;
  const change =
    previous12 > 0 ? Math.round(((last12 - previous12) / previous12) * 100) : last12 > 0 ? 100 : 0;
  const verdict: LinkVelocity["verdict"] =
    change >= 20 ? "growing" : change <= -20 ? "declining" : "stable";

  let hint: string;
  if (verdict === "growing" && change > 200) {
    hint = `A sharp jump (${change}%) — make sure the new domains are natural, because growth like this often signals bought links.`;
  } else if (verdict === "growing") {
    hint = `Healthy pace: ${perMonth} new domains per month, ${change}% more than a year earlier.`;
  } else if (verdict === "declining") {
    hint = `The pace fell by ${Math.abs(change)}%. Competitors who did not slow down will start to pass you.`;
  } else {
    hint = `Steady at ${perMonth} new domains per month.`;
  }

  return { last12m: last12, perMonth, trend: change, lostRatio, verdict, hint };
}
