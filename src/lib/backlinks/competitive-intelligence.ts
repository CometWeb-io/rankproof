import { domainFromUrl, normalizeUrl, registrableDomain } from "./parse.ts";
import type { Backlink, LinkGapReport } from "./types.ts";

export type ProspectAssessment = {
  sampleUrl: string;
  pageType: "editorial" | "directory" | "resource" | "forum" | "other" | "unknown";
  topicalRelevance: "high" | "medium" | "low" | "unknown";
  feasibility: "plausible" | "difficult" | "unknown";
  rationale: string;
  evidenceRefs: string[];
  publicationHistory: { url: string; publishedAt: string; evidenceRef: string }[];
};

export function hasHtmlConfirmation(link: Backlink): boolean {
  return (
    link.verified === true &&
    link.state === "live" &&
    link.evidence?.kind === "html_anchor" &&
    link.evidence.method === "fetched_html" &&
    /^[a-f0-9]{64}$/i.test(link.evidence.responseHash ?? "") &&
    Number.isFinite(Date.parse(link.evidence.observedAt)) &&
    !!link.evidence.resolvedSourceUrl &&
    normalizeUrl(link.evidence.resolvedSourceUrl) === normalizeUrl(link.sourceUrl) &&
    normalizeUrl(link.evidence.resolvedHref) === normalizeUrl(link.targetUrl)
  );
}

export function buildCompetitiveIntelligence(input: {
  gap: LinkGapReport;
  competitorBacklinks: Backlink[];
  targetBacklinks: Backlink[];
  assessments?: ProspectAssessment[];
}) {
  if (
    !input?.gap ||
    !Array.isArray(input.gap.gap) ||
    !Array.isArray(input.competitorBacklinks) ||
    !Array.isArray(input.targetBacklinks) ||
    input.gap.gap.length > 100_000 ||
    input.competitorBacklinks.length + input.targetBacklinks.length > 200_000 ||
    !Number.isFinite(Date.parse(input.gap.queriedAt))
  )
    throw new Error("Invalid competitive input.");
  const assessments = new Map<string, ProspectAssessment>();
  for (const assessment of input.assessments ?? []) {
    if (
      !assessment.rationale?.trim() ||
      !Array.isArray(assessment.evidenceRefs) ||
      assessment.evidenceRefs.length === 0 ||
      assessment.evidenceRefs.some((ref) => typeof ref !== "string" || !ref.trim()) ||
      !["editorial", "directory", "resource", "forum", "other", "unknown"].includes(
        assessment.pageType,
      ) ||
      !["high", "medium", "low", "unknown"].includes(assessment.topicalRelevance) ||
      !["plausible", "difficult", "unknown"].includes(assessment.feasibility) ||
      !Array.isArray(assessment.publicationHistory) ||
      assessment.publicationHistory.some(
        (item) =>
          !Number.isFinite(Date.parse(item.publishedAt)) ||
          !item.evidenceRef?.trim() ||
          !/^https?:\/\//.test(item.url),
      )
    ) {
      throw new Error(
        "Prospect assessments require dated publication provenance and cited rationale.",
      );
    }
    const key = normalizeUrl(new URL(assessment.sampleUrl).href);
    if (assessments.has(key)) throw new Error("Duplicate prospect assessment.");
    assessments.set(key, assessment);
  }
  const index = (links: Backlink[]) => {
    const byDomain = new Map<string, Backlink[]>();
    for (const link of links) {
      const domain = domainFromUrl(link.sourceUrl);
      const group = byDomain.get(domain) ?? [];
      group.push(link);
      byDomain.set(domain, group);
    }
    return byDomain;
  };
  const competitors = index(input.competitorBacklinks);
  const target = index(input.targetBacklinks);
  const prospects = input.gap.gap
    .map((gap) => {
      const domain = registrableDomain(gap.domain);
      if (!domain || domainFromUrl(gap.sampleUrl) !== domain)
        throw new Error("Gap sample URL must belong to its referring domain.");
      const matching = (competitors.get(domain) ?? []).filter((link) =>
        gap.competitors.some((host) => domainFromUrl(link.targetUrl) === registrableDomain(host)),
      );
      const confirmed = matching.filter(hasHtmlConfirmation);
      const held = (target.get(domain) ?? []).filter(
        (link) =>
          hasHtmlConfirmation(link) &&
          domainFromUrl(link.targetUrl) === registrableDomain(input.gap.target),
      );
      const assessment = assessments.get(normalizeUrl(gap.sampleUrl));
      const status = held.length
        ? "already-observed-for-target"
        : confirmed.length
          ? "competitor-link-confirmed"
          : "reported-gap-unverified";
      const evidence = [...confirmed, ...held].map((link) => ({
        sourceUrl: link.sourceUrl,
        requestedSourceUrl: link.evidence!.requestedSourceUrl,
        targetUrl: link.targetUrl,
        observedAt: link.evidence!.observedAt,
        responseHash: link.evidence!.responseHash!,
        extractionVersion: link.evidence!.extractionVersion,
      }));
      return {
        domain,
        sampleUrl: gap.sampleUrl,
        competitors: gap.competitors,
        verification: status,
        evidence,
        assessment: assessment ?? null,
        rationale: [
          `The imported gap report lists this domain for ${gap.competitors.length} competitor(s).`,
          confirmed.length
            ? `${confirmed.length} imported HTML confirmation(s) support competitor relationships.`
            : "No matching HTML confirmation was supplied.",
          ...(assessment ? [assessment.rationale] : []),
        ],
        assumptions: [
          "Absence from the supplied target sample does not prove that the domain never links to the target.",
          "Competitor publication does not establish editorial access or acquisition feasibility.",
          "No ranking improvement is predicted.",
        ],
        reviewOrder: held.length
          ? 3
          : confirmed.length &&
              assessment?.topicalRelevance === "high" &&
              assessment.feasibility === "plausible"
            ? 0
            : confirmed.length
              ? 1
              : 2,
      };
    })
    .sort(
      (a, b) =>
        a.reviewOrder - b.reviewOrder ||
        a.domain.localeCompare(b.domain) ||
        a.sampleUrl.localeCompare(b.sampleUrl),
    );
  return {
    schemaVersion: 1,
    target: input.gap.target,
    observedAt: input.gap.queriedAt,
    prospects,
    ordering:
      "HTML evidence, then cited topical relevance and feasibility; already observed target relationships last",
    limitations: [
      "Human assessments are imported assertions, not calibrated probabilities.",
      "No live verification, SEO expert evaluation or outreach was performed.",
    ],
  };
}

export type CompetitiveIntelligenceReport = ReturnType<typeof buildCompetitiveIntelligence>;
