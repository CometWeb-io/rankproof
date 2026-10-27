import { isMeasuredSerp } from "./serp-intel.ts";
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

export const SCORECARD_METHOD_VERSION = "sample-scorecard-v2";
export const FOOTPRINT_METHOD_VERSION = "observed-link-patterns-v2";

/* ------------------------------------------------------------------ */
/* Concentration cues within the observed sample                        */
/* ------------------------------------------------------------------ */

/**
 * Describes concentration in the supplied sample:
 * domains in the same /24 subnet, sitewide links, repeated exact-match anchors
 * and domains linking from a single page.
 *
 * Rule thresholds are uncalibrated review cues, not a definition of a natural profile.
 */
export function buildFootprint(
  domains: ReferringDomain[],
  backlinks: Backlink[],
  anchorTypes: { key: string; share: number }[],
): FootprintRisk {
  const reasons: string[] = [];
  if (domains.length === 0) {
    return {
      methodVersion: FOOTPRINT_METHOD_VERSION,
      status: "unknown",
      coverage: {
        domains: 0,
        links: backlinks.length,
        subnetDomains: 0,
        assessedSignals: 0,
        totalSignals: 5,
      },
      score: 0,
      topSubnetShare: null,
      subnetDiversity: null,
      sitewideShare: null,
      exactAnchorShare: null,
      singlePageDomains: null,
      reasons: ["No referring domains to assess."],
      verdict: "unknown",
    };
  }

  const subnets = new Map<string, number>();
  for (const domain of domains) {
    if (!domain.subnet) continue;
    subnets.set(domain.subnet, (subnets.get(domain.subnet) ?? 0) + 1);
  }
  const withSubnet = [...subnets.values()].reduce((sum, count) => sum + count, 0);
  const topSubnet = Math.max(0, ...subnets.values());
  const topSubnetShare = withSubnet > 0 ? Math.round((topSubnet / withSubnet) * 100) : null;
  const subnetDiversity = withSubnet > 0 ? Math.round((subnets.size / withSubnet) * 100) : null;

  const sitewide = domains.filter((domain) => domain.sitewide).length;
  const sitewideShare = Math.round((sitewide / domains.length) * 100);

  const exactAnchorShare = anchorTypes.length
    ? Math.round(anchorTypes.find((item) => item.key === "exact-match")?.share ?? 0)
    : null;

  const singlePageDomains = domains.filter(
    (domain) => domain.pages <= 1 && domain.links >= 5,
  ).length;

  let score = 0;
  if (topSubnetShare !== null && topSubnetShare >= 30 && withSubnet >= 5) {
    score += Math.min(30, topSubnetShare - 10);
    reasons.push(`${topSubnetShare}% of domains sit in one /24 subnet`);
  }
  if (sitewideShare >= 25) {
    score += Math.min(22, sitewideShare - 10);
    reasons.push(`${sitewideShare}% of domains link sitewide`);
  }
  if (exactAnchorShare !== null && exactAnchorShare > 12) {
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
    reasons.push(
      "More than 95% of sampled links are followed; review the observed mix, not a universal natural-profile threshold",
    );
  }

  const rounded = Math.max(0, Math.min(100, Math.round(score)));
  const assessedSignals =
    2 +
    Number(withSubnet === domains.length) +
    Number(anchorTypes.length > 0) +
    Number(backlinks.length > 0);
  const status = assessedSignals === 5 ? "estimated" : "inconclusive";
  if (withSubnet < domains.length)
    reasons.push(
      `Subnet observations cover ${withSubnet}/${domains.length} domains; missing DNS is not evidence of diversity.`,
    );
  if (!anchorTypes.length) reasons.push("Anchor distribution unavailable.");
  if (!backlinks.length) reasons.push("Follow-attribute observations unavailable.");
  return {
    methodVersion: FOOTPRINT_METHOD_VERSION,
    status,
    coverage: {
      domains: domains.length,
      links: backlinks.length,
      subnetDomains: withSubnet,
      assessedSignals,
      totalSignals: 5,
    },
    score: rounded,
    topSubnetShare,
    subnetDiversity,
    sitewideShare,
    exactAnchorShare,
    singlePageDomains,
    reasons:
      reasons.length > 0
        ? reasons
        : [
            "No configured concentration rule triggered in the observed sample; this is not proof of safety.",
          ],
    verdict:
      status === "inconclusive"
        ? "inconclusive"
        : rounded >= 55
          ? "high"
          : rounded >= 30
            ? "medium"
            : "low",
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
  /** Owner data is retained separately; it does not calibrate this heuristic. */
  searchConsole?: SearchConsoleInsights | null;
};

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(value)));
}

/** Known credits from the supplied sample; missing components are never imputed or normalized. */
export function buildScorecard(input: ScorecardInput): Scorecard {
  const parts: Scorecard["parts"] = [];
  const domains = input.analytics.referringDomains ?? [];
  const currentDomains = domains.length;
  const finite = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);
  const add = (
    key: string,
    label: string,
    score: number,
    max: number,
    availableMax: number,
    hint: string,
  ) => {
    parts.push({
      key,
      label,
      score: availableMax ? clamp(score, availableMax) : 0,
      max,
      availableMax,
      status: availableMax === 0 ? "unknown" : availableMax < max ? "inconclusive" : "estimated",
      hint,
    });
  };
  const profileKnown = currentDomains > 0;
  add(
    "authority",
    "Link strength",
    profileKnown && finite(input.domainRating)
      ? input.domainRating * 0.18 + Math.min(12, Math.log2(currentDomains + 1) * 2.2)
      : 0,
    25,
    profileKnown && finite(input.domainRating) ? 25 : 0,
    profileKnown
      ? `Uncalibrated sample heuristic: ${currentDomains} observed current referring domains; link index ${input.domainRating}.`
      : "No current referring-domain observations; link strength is unknown.",
  );

  const healthKnown = profileKnown && finite(input.analytics.health.total);
  const anchorsKnown =
    profileKnown && (input.analytics.anchors?.length ?? 0) > 0 && finite(input.anchorAudit.score);
  add(
    "quality",
    "Profile quality",
    (healthKnown ? (input.analytics.health.total / 100) * 10 : 0) +
      (anchorsKnown ? (input.anchorAudit.score / 100) * 5 : 0),
    15,
    (healthKnown ? 10 : 0) + (anchorsKnown ? 5 : 0),
    `Uncalibrated sample heuristic. Profile health: ${healthKnown ? input.analytics.health.total + "/100" : "unknown"}; anchor distribution: ${anchorsKnown ? input.anchorAudit.score + "/100" : "unknown"}.`,
  );

  const queries = input.serp.queries ?? [];
  const successfulSerpAttempts = queries.filter(isMeasuredSerp).length;
  const ratio = queries.length ? successfulSerpAttempts / queries.length : 0;
  const visibilityKnown =
    successfulSerpAttempts > 0 && finite(input.serp.visibility) && finite(input.serp.trafficScore);
  add(
    "visibility",
    "SERP visibility",
    visibilityKnown
      ? ((input.serp.visibility / 100) * 16 + Math.min(9, input.serp.trafficScore / 4)) * ratio
      : 0,
    25,
    visibilityKnown ? 25 * ratio : 0,
    visibilityKnown
      ? `Successful SERP attempts ${successfulSerpAttempts}/${queries.length}; ${plural(input.serp.top10, "keyword")} in the top 10. CTR and points are modeled, not measured traffic. Failed attempts earn no credits.`
      : "No successful SERP attempts. This component is unavailable, not evidence of zero visibility.",
  );

  const landingKnown = input.onPage !== null && finite(input.onPage?.score);
  const structureKnown =
    !!input.siteAudit &&
    input.siteAudit.status !== "failed" &&
    input.siteAudit.crawled > 0 &&
    finite(input.siteAudit.score) &&
    (input.siteAudit.pages ?? []).some((page) => page.status >= 200 && page.status < 300);
  add(
    "onpage",
    "On-page and structure",
    (landingKnown ? (input.onPage!.score / 100) * 5 : 0) +
      (structureKnown ? (input.siteAudit!.score / 100) * 5 : 0),
    10,
    (landingKnown ? 5 : 0) + (structureKnown ? 5 : 0),
    `Landing page: ${landingKnown ? input.onPage!.score + "/100" : "unknown"}; internal structure: ${structureKnown ? input.siteAudit!.score + "/100" : "unknown"}. No neutral defaults; each observed audit supplies only its own half of this heuristic.`,
  );

  const toxicityKnown =
    profileKnown && (input.toxic.domains?.length ?? 0) > 0 && finite(input.toxic.avgToxicity);
  const footprintKnown =
    profileKnown &&
    input.footprint.methodVersion === FOOTPRINT_METHOD_VERSION &&
    input.footprint.status === "estimated";
  add(
    "risk",
    "Profile risk signals",
    (toxicityKnown ? 8 - (input.toxic.avgToxicity / 100) * 8 : 0) +
      (footprintKnown ? 7 - (input.footprint.score / 100) * 7 : 0),
    15,
    (toxicityKnown ? 8 : 0) + (footprintKnown ? 7 : 0),
    `Uncalibrated concentration/risk cues, not a safety or penalty assessment. Toxicity: ${toxicityKnown ? input.toxic.avgToxicity + "/100" : "unknown"}; footprint: ${footprintKnown ? input.footprint.score + "/100" : "inconclusive or unknown"}.`,
  );

  const velocityKnown = ["growing", "stable", "declining"].includes(input.velocity.verdict);
  const velocityPoints =
    input.velocity.verdict === "growing"
      ? 6
      : input.velocity.verdict === "stable"
        ? 4
        : input.velocity.verdict === "declining"
          ? 2
          : 0;
  const brand = input.brandSerp;
  const brandKnown =
    !!brand &&
    brand.results.length > 0 &&
    finite(brand.control) &&
    queries.some(
      (q) => isMeasuredSerp(q) && q.keyword === brand.keyword && q.engine === brand.engine,
    );
  add(
    "momentum",
    "Momentum and brand",
    velocityPoints + (brandKnown ? (brand!.control / 100) * 4 : 0),
    10,
    (velocityKnown ? 6 : 0) + (brandKnown ? 4 : 0),
    `Link velocity: ${velocityKnown ? input.velocity.verdict : "unknown"}; sampled brand SERP: ${brandKnown ? brand!.control + "% (ownership heuristic)" : "unknown"}. Missing inputs earn no neutral credits.`,
  );

  const index = parts.reduce((sum, part) => sum + part.score, 0);
  const availableMax = parts.reduce((sum, part) => sum + part.availableMax, 0);
  const status = availableMax === 0 ? "unknown" : availableMax < 100 ? "inconclusive" : "estimated";
  const grade: Scorecard["grade"] =
    index >= 80 ? "A" : index >= 65 ? "B" : index >= 48 ? "C" : index >= 32 ? "D" : "E";
  const weakest =
    parts
      .filter((part) => part.status === "estimated")
      .sort((a, b) => a.score / a.max - b.score / b.max)[0]?.label ??
    "Unknown — insufficient component coverage";
  return {
    methodVersion: SCORECARD_METHOD_VERSION,
    status,
    index,
    grade,
    parts,
    weakest,
    provisional: status !== "estimated",
    measuredMax: availableMax,
    coverage: {
      availableMax,
      totalMax: 100,
      currentDomains,
      successfulSerpAttempts,
      attemptedSerp: queries.length,
    },
  };
}

/** Shared presentation boundary: old stored reports have no qualified coverage. */
export function qualifiedScorecard(card: Scorecard): boolean {
  const available = card.coverage?.availableMax;
  return (
    card.methodVersion === SCORECARD_METHOD_VERSION &&
    card.coverage?.totalMax === 100 &&
    Number.isFinite(available) &&
    ((card.status === "estimated" && available === 100) ||
      (card.status === "unknown" && available === 0) ||
      (card.status === "inconclusive" && available > 0 && available < 100))
  );
}
export function scorecardLabel(card: Scorecard): string {
  if (!qualifiedScorecard(card)) return "Unknown (legacy report; rescan for evidence coverage)";
  if (card.status === "unknown") return "Unknown · coverage 0/100";
  return `${card.index}/100${card.status === "estimated" ? ` (${card.grade})` : " · partial"} · input coverage ${card.coverage.availableMax}/100 · uncalibrated heuristic`;
}
export function footprintLabel(footprint: FootprintRisk): string {
  if (
    footprint.methodVersion !== FOOTPRINT_METHOD_VERSION ||
    !footprint.coverage ||
    !["estimated", "unknown", "inconclusive"].includes(footprint.status)
  )
    return "Unknown (legacy footprint; rescan)";
  return footprint.status === "estimated"
    ? `${footprint.score}/100 (${footprint.verdict}) · sample heuristic`
    : `${footprint.status} · ${footprint.coverage.assessedSignals}/${footprint.coverage.totalSignals} signals assessed`;
}
