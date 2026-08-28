import type {
  AnchorAudit,
  SearchConsoleInsights,
  SiteAudit,
  Analytics,
  Backlink,
  BrandSerp,
  FootprintRisk,
  LinkVelocity,
  OnPageAudit,
  ReferringDomain,
  Scorecard,
  SerpSnapshot,
  ToxicReport,
} from "./types.ts";
import { plural } from "./text.ts";

/* ------------------------------------------------------------------ */
/* Footprint — the trace of an artificially built profile                      */
/* ------------------------------------------------------------------ */

/**
 * Detects patterns that reveal a profile built at scale from one source:
 * domains in the same /24 subnet, sitewide links, repeated exact-match anchors
 * and domains linking from a single page.
 *
 * This is not a judgement about whether you will be penalised — it measures how far the profile
 * odbiega od naturalnego rozproszenia.
 */
export function buildFootprint(
  domains: ReferringDomain[],
  backlinks: Backlink[],
  anchorTypes: { key: string; share: number }[],
): FootprintRisk {
  const reasons: string[] = [];
  if (domains.length === 0) {
    return {
      score: 0,
      topSubnetShare: 0,
      subnetDiversity: 100,
      sitewideShare: 0,
      exactAnchorShare: 0,
      singlePageDomains: 0,
      reasons: ["No referring domains to assess."],
      verdict: "low",
    };
  }

  const subnets = new Map<string, number>();
  for (const domain of domains) {
    if (!domain.subnet) continue;
    subnets.set(domain.subnet, (subnets.get(domain.subnet) ?? 0) + 1);
  }
  const withSubnet = [...subnets.values()].reduce((sum, count) => sum + count, 0);
  const topSubnet = Math.max(0, ...subnets.values());
  const topSubnetShare = withSubnet > 0 ? Math.round((topSubnet / withSubnet) * 100) : 0;
  const subnetDiversity =
    withSubnet > 0 ? Math.round((subnets.size / withSubnet) * 100) : 100;

  const sitewide = domains.filter((domain) => domain.sitewide).length;
  const sitewideShare = Math.round((sitewide / domains.length) * 100);

  const exactAnchorShare = Math.round(
    anchorTypes.find((item) => item.key === "exact-match")?.share ?? 0,
  );

  const singlePageDomains = domains.filter(
    (domain) => domain.pages <= 1 && domain.links >= 5,
  ).length;

  let score = 0;
  if (topSubnetShare >= 30 && withSubnet >= 5) {
    score += Math.min(30, topSubnetShare - 10);
    reasons.push(`${topSubnetShare}% of domains sit in one /24 subnet`);
  }
  if (sitewideShare >= 25) {
    score += Math.min(22, sitewideShare - 10);
    reasons.push(`${sitewideShare}% of domains link sitewide`);
  }
  if (exactAnchorShare > 12) {
    score += Math.min(24, (exactAnchorShare - 12) * 1.5);
    reasons.push(`exact-match anchors are ${exactAnchorShare}% of the profile`);
  }
  if (singlePageDomains >= 3) {
    score += Math.min(14, singlePageDomains * 2);
    reasons.push(`${singlePageDomains} domains link from a single page only`);
  }
  const noFollowRatio =
    backlinks.length > 0
      ? backlinks.filter((link) => link.effectiveFollow).length / backlinks.length
      : 0;
  if (noFollowRatio > 0.95 && backlinks.length >= 20) {
    score += 10;
    reasons.push("almost no nofollow links — a natural profile always has some");
  }

  const rounded = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: rounded,
    topSubnetShare,
    subnetDiversity,
    sitewideShare,
    exactAnchorShare,
    singlePageDomains,
    reasons: reasons.length > 0 ? reasons : ["No typical patterns of an artificial profile detected."],
    verdict: rounded >= 55 ? "high" : rounded >= 30 ? "medium" : "low",
  };
}

/* ------------------------------------------------------------------ */
/* Visibility index                                                  */
/* ------------------------------------------------------------------ */

export type ScorecardInput = {
  analytics: Analytics;
  serp: SerpSnapshot;
  onPage: OnPageAudit | null;
  toxic: ToxicReport;
  anchorAudit: AnchorAudit;
  footprint: FootprintRisk;
  velocity: LinkVelocity;
  brandSerp: BrandSerp | null;
  domainRating: number;
  referringDomains: number;
  /** When present, internal structure is folded into the on-page score. */
  siteAudit?: SiteAudit | null;
  /** Real performance data upgrades the visibility component from estimate to fact. */
  searchConsole?: SearchConsoleInsights | null;
};

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(value)));
}

/**
 * One metric instead of five tables. The weights reflect real influence on
 * visibility: link strength and quality make up half the score, SERP visibility
 * a quarter, and the rest covers page readiness, risk and momentum.
 *
 * The index is comparable between scans of the same domain — it is not an
 * equivalent of any commercial tool's Domain Rating.
 */
export function buildScorecard(input: ScorecardInput): Scorecard {
  const parts: Scorecard["parts"] = [];

  // 1. Link profile strength (25).
  const authority = clamp(
    input.domainRating * 0.18 + Math.min(12, Math.log2(input.referringDomains + 1) * 2.2),
    25,
  );
  parts.push({
    key: "authority",
    label: "Link strength",
    score: authority,
    max: 25,
    hint: `DR ${input.domainRating}, ${input.referringDomains} referring domains.`,
  });

  // 2. Profile quality — topic, placement, dofollow (15).
  const quality = clamp(
    (input.analytics.health.total / 100) * 10 + (input.anchorAudit.score / 100) * 5,
    15,
  );
  parts.push({
    key: "quality",
    label: "Profile quality",
    score: quality,
    max: 15,
    hint: `Profile health ${input.analytics.health.total}/100, anchors ${input.anchorAudit.score}/100.`,
  });

  // 3. Visibility in the results (25).
  const visibility = clamp(
    (input.serp.visibility / 100) * 16 + Math.min(9, input.serp.trafficScore / 4),
    25,
  );
  parts.push({
    key: "visibility",
    label: "SERP visibility",
    score: visibility,
    max: 25,
    hint: `Visibility ${input.serp.visibility}/100, ${plural(input.serp.top10, "keyword")} in the top 10.`,
  });

  // 4. On-page readiness (10). With an internal audit the score is the
  //    average of landing-page quality and internal structure — a perfect
  //    page inside a broken site is not worth full marks.
  const pageScore = input.onPage?.score ?? 50;
  const structureScore = input.siteAudit?.score ?? null;
  const combined = structureScore === null ? pageScore : (pageScore + structureScore) / 2;
  const onPage = clamp((combined / 100) * 10, 10);
  parts.push({
    key: "onpage",
    label: "On-page and structure",
    score: onPage,
    max: 10,
    hint:
      structureScore === null
        ? input.onPage
          ? `Landing page audit: ${input.onPage.score}/100.`
          : "Could not fetch the landing page — a neutral value was used."
        : `Landing page ${pageScore}/100, internal structure ${structureScore}/100 (${input.siteAudit?.crawled ?? 0} pages crawled).`,
  });

  // 5. Safety: toxicity and footprint (15).
  const risk = clamp(
    15 - (input.toxic.avgToxicity / 100) * 8 - (input.footprint.score / 100) * 7,
    15,
  );
  parts.push({
    key: "risk",
    label: "Safety",
    score: risk,
    max: 15,
    hint: `Toxicity ${input.toxic.avgToxicity}/100, footprint ${input.footprint.score}/100 (${input.footprint.verdict}).`,
  });

  // 6. Momentum and brand control (10).
  const velocityPoints =
    input.velocity.verdict === "growing" ? 6 : input.velocity.verdict === "stable" ? 4 : 2;
  const brandPoints = input.brandSerp ? (input.brandSerp.control / 100) * 4 : 2;
  const momentum = clamp(velocityPoints + brandPoints, 10);
  parts.push({
    key: "momentum",
    label: "Momentum and brand",
    score: momentum,
    max: 10,
    hint: input.brandSerp
      ? `Link velocity: ${input.velocity.verdict}, brand SERP control ${input.brandSerp.control}%.`
      : `Link velocity: ${input.velocity.verdict}.`,
  });

  const index = parts.reduce((sum, part) => sum + part.score, 0);
  const grade: Scorecard["grade"] =
    index >= 80 ? "A" : index >= 65 ? "B" : index >= 48 ? "C" : index >= 32 ? "D" : "E";

  const weakest = parts
    .slice()
    .sort((a, b) => a.score / a.max - b.score / b.max)[0]?.label ?? "";

  return { index: Math.round(index), grade, parts, weakest };
}
