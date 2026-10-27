import { createHash } from "node:crypto";
import type { CompetitiveIntelligenceReport } from "./competitive-intelligence.ts";
import type { TechnicalGraphReport } from "./technical-graph.ts";
import type { ActionEffort, ScanReport } from "./types.ts";
import { renderedPolicy } from "./rendered-policy.ts";

export type EvidenceDecision = {
  id: string;
  action: string;
  urls: string[];
  evidence: {
    ref: string;
    kind: "imported-finding" | "html-confirmation" | "inventory";
    hash?: string;
  }[];
  assumptions: string[];
  confidence: "source-backed" | "assumption-only";
  expectedEffect: { kind: "hypothesis"; description: string };
  difficulty: ActionEffort;
  estimatedCost: null;
  priority: "high" | "medium" | "low";
  priorityRationale: string;
};
type DecisionScan = Pick<ScanReport, "queriedAt" | "siteAudit" | "plan">;

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function buildEvidenceDecisions(input: {
  scan?: DecisionScan;
  graph?: TechnicalGraphReport;
  competitive?: CompetitiveIntelligenceReport;
}) {
  if (!input || (!input.scan && !input.graph && !input.competitive))
    throw new Error("Supply a scan, graph or competitive report.");
  const decisions: EvidenceDecision[] = [];
  const append = (
    item: Omit<EvidenceDecision, "id" | "confidence" | "estimatedCost" | "expectedEffect">,
    effect: string,
  ) => {
    if (!item.evidence.length && !item.assumptions.length)
      throw new Error("A decision needs evidence or explicit assumptions.");
    decisions.push({
      ...item,
      id: digest([item.action, item.urls, item.evidence]).slice(0, 24),
      confidence: item.evidence.length ? "source-backed" : "assumption-only",
      estimatedCost: null,
      expectedEffect: { kind: "hypothesis", description: effect },
    });
  };
  if (input.scan) {
    if (
      !Number.isFinite(Date.parse(input.scan.queriedAt)) ||
      !Array.isArray(input.scan.plan?.items)
    )
      throw new Error("Invalid scan decision input.");
    for (const issue of input.scan.siteAudit?.issues ?? []) {
      append(
        {
          action: `Review and resolve: ${issue.title}`,
          urls: issue.samples,
          evidence: [
            {
              ref: `scan:${input.scan.queriedAt}:siteAudit/issues/${issue.id}`,
              kind: "imported-finding",
              hash: digest(issue),
            },
          ],
          assumptions: [
            "The imported audit finding is accurate; confirm current affected URLs before changing the site.",
          ],
          difficulty: "medium",
          priority: issue.id === "orphan-pages" ? "low" : issue.severity,
          priorityRationale:
            "Uses the audit's severity classification; effort and impact are not calibrated.",
        },
        `Resolve the reported condition: ${issue.detail}`,
      );
    }
    for (const item of input.scan.plan.items) {
      append(
        {
          action: item.title,
          urls: item.samples,
          evidence: [
            {
              ref: `scan:${input.scan.queriedAt}:plan/items/${item.id}`,
              kind: "imported-finding",
              hash: digest(item),
            },
          ],
          assumptions: [
            "The existing action plan is heuristic; its numeric impact and priority are not measured effects.",
          ],
          difficulty: item.effort,
          priority: "low",
          priorityRationale:
            "Review imported heuristic recommendations after concrete high and medium severity findings.",
        },
        item.detail,
      );
    }
  }
  for (const issue of input.graph?.issues ?? []) {
    append(
      {
        action: `Review ${issue.kind}`,
        urls: issue.urls,
        evidence: [
          { ref: `graph:issues:${digest(issue)}`, kind: "imported-finding", hash: digest(issue) },
        ],
        assumptions: [
          "Graph describes imported observations; an unobserved target may exist outside crawl coverage.",
        ],
        difficulty: "medium",
        priority:
          issue.kind === "canonical-cycle" || issue.kind === "canonical-unusable-target"
            ? "high"
            : "low",
        priorityRationale: "Observed canonical conflicts precede incomplete-coverage checks.",
      },
      "Clarify canonical declarations and remove a confirmed conflict; ranking impact remains unknown.",
    );
  }
  for (const candidate of input.graph?.orphanCandidates ?? []) {
    append(
      {
        action: "Check inventory URL reachability",
        urls: [candidate.url],
        evidence: candidate.sources.map((source) => ({
          ref: source.evidenceRef,
          kind: "inventory",
        })),
        assumptions: [
          "Inventory membership does not prove that the URL exists or is an orphan.",
          "Confirm existence, crawl scope and intended indexability before adding links.",
        ],
        difficulty: "low",
        priority: "low",
        priorityRationale: "Incomplete discovery requires investigation before remediation.",
      },
      "Determine whether an intended page needs internal navigation.",
    );
  }
  for (const prospect of input.competitive?.prospects ?? []) {
    if (prospect.verification === "already-observed-for-target") continue;
    append(
      {
        action:
          prospect.verification === "competitor-link-confirmed"
            ? "Review relevance and editorial feasibility"
            : "Verify the reported competitor relationship",
        urls: [prospect.sampleUrl],
        evidence: prospect.evidence.map((e) => ({
          ref: `${e.sourceUrl} -> ${e.targetUrl} @ ${e.observedAt}`,
          kind: "html-confirmation",
          hash: e.responseHash,
        })),
        assumptions: prospect.assumptions,
        difficulty: prospect.assessment?.feasibility === "difficult" ? "high" : "medium",
        priority: "low",
        priorityRationale:
          "Acquisition hypotheses follow concrete technical findings; no SEO gain is assumed.",
      },
      "Establish whether a relevant editorial opportunity exists.",
    );
  }
  const order = { high: 0, medium: 1, low: 2 };
  decisions.sort((a, b) => order[a.priority] - order[b.priority] || a.id.localeCompare(b.id));
  return {
    schemaVersion: 1,
    decisions,
    observedOutcomes: [],
    limitations: [
      "Ordering is an explicit review heuristic, not a forecast or calibrated probability.",
      "Costs are unknown; actual remediation and comparable outcome measurement have not been performed.",
      "Imported findings and source references must be retained alongside this report.",
    ],
  };
}

/** Accepts an engine report or the existing {ok, report} CLI/API envelope. */
export function analyzeScanReport(input: unknown) {
  if (!input || typeof input !== "object") throw new Error("Expected a RankProof scan export.");
  const envelope = input as { ok?: boolean; report?: unknown };
  if (envelope.ok === false) throw new Error("Cannot analyze a failed scan.");
  const report = (envelope.ok === true ? envelope.report : input) as ScanReport;
  if (
    !report ||
    typeof report !== "object" ||
    !Number.isInteger(report.version) ||
    !Array.isArray(report.backlinks) ||
    !report.target ||
    typeof report.target.url !== "string" ||
    !Array.isArray(report.plan?.items) ||
    !Number.isFinite(Date.parse(report.queriedAt))
  )
    throw new Error("Invalid scan report export.");
  const graph = (
    report.siteAudit as ScanReport["siteAudit"] & { technicalGraph?: TechnicalGraphReport }
  )?.technicalGraph;
  return {
    schemaVersion: 1,
    source: {
      version: report.version,
      queriedAt: report.queriedAt,
      target: report.target.url,
      hash: digest(report),
    },
    rendering: renderedPolicy(report.target.url),
    technicalGraph: graph ?? {
      status: "unavailable",
      reason:
        "Scan export does not contain edge observations; rerun a site audit with graph capture.",
    },
    decisions: buildEvidenceDecisions({ scan: report, graph }),
    limitations: [
      "Analysis replays the exported scan without issuing network requests.",
      "Legacy scans cannot reconstruct missing edges, hreflang or complete inventory.",
    ],
  };
}
