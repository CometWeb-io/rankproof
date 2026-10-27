import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCompetitiveIntelligence, hasHtmlConfirmation } from "./competitive-intelligence.ts";
import { buildEvidenceDecisions, analyzeScanReport } from "./decision-engine.ts";
import type { Backlink, LinkGapReport } from "./types.ts";

const gap: LinkGapReport = {
  target: "target.example",
  competitors: [],
  shared: [],
  unique: [],
  queriedAt: "2026-10-27T10:00:00Z",
  gap: [
    {
      domain: "source.example",
      domainScore: 99,
      priority: 100,
      competitors: ["competitor.example"],
      sampleUrl: "https://source.example/article",
      dofollow: true,
    },
  ],
};
function link(target = "competitor.example"): Backlink {
  return {
    id: "one",
    sourceUrl: "https://source.example/article",
    sourceHost: "source.example",
    sourceDomain: "source.example",
    sourceTitle: "Article",
    sourceLang: "en",
    targetUrl: `https://${target}/`,
    targetPath: "/",
    anchor: "Example",
    anchorType: "brand",
    rel: "dofollow",
    effectiveFollow: true,
    placement: "content",
    sitewide: false,
    discoveredVia: "bing",
    verified: true,
    firstSeen: null,
    httpStatus: 200,
    targetStatus: 200,
    domainScore: 99,
    spamScore: 0,
    relevance: 100,
    targetFinalUrl: null,
    state: "live",
    lastSeen: null,
    flags: [],
    evidence: {
      kind: "html_anchor",
      method: "fetched_html",
      observedAt: gap.queriedAt,
      sourceRevision: "test",
      extractionVersion: "test-v1",
      identityPolicy: "exact",
      requestedSourceUrl: "https://source.example/article",
      resolvedSourceUrl: "https://source.example/article",
      rawHref: `https://${target}/`,
      resolvedHref: `https://${target}/`,
      responseHash: "a".repeat(64),
      absenceScope: null,
    },
  };
}

test("gap evidence overrides legacy scores and never infers target-wide link absence", () => {
  const report = buildCompetitiveIntelligence({
    gap,
    competitorBacklinks: [link()],
    targetBacklinks: [],
  });
  assert.equal(report.prospects[0]?.verification, "competitor-link-confirmed");
  assert.ok(report.prospects[0]?.assumptions.some((a) => a.includes("does not prove")));
  assert.equal(
    buildCompetitiveIntelligence({
      gap,
      competitorBacklinks: [{ ...link(), evidence: undefined }],
      targetBacklinks: [],
    }).prospects[0]?.verification,
    "reported-gap-unverified",
  );
  assert.equal(
    buildCompetitiveIntelligence({
      gap,
      competitorBacklinks: [link()],
      targetBacklinks: [link("target.example")],
    }).prospects[0]?.verification,
    "already-observed-for-target",
  );
  const forged = link();
  forged.evidence!.resolvedHref = "https://elsewhere.example/";
  assert.equal(hasHtmlConfirmation(forged), false);
  const unrelated = buildCompetitiveIntelligence({
    gap,
    competitorBacklinks: [link("unrelated.example")],
    targetBacklinks: [],
  });
  assert.equal(unrelated.prospects[0]?.verification, "reported-gap-unverified");
});

test("verified source redirects keep the resolved confirmation and requested URL provenance", () => {
  const redirected = link();
  redirected.sourceUrl = "https://source.example/moved";
  redirected.evidence!.requestedSourceUrl = "https://source.example/old";
  redirected.evidence!.resolvedSourceUrl = redirected.sourceUrl;
  assert.equal(hasHtmlConfirmation(redirected), true);
  assert.equal(
    buildCompetitiveIntelligence({ gap, competitorBacklinks: [redirected], targetBacklinks: [] })
      .prospects[0]?.verification,
    "competitor-link-confirmed",
  );
  redirected.evidence!.resolvedSourceUrl = "https://source.example/unrelated";
  assert.equal(hasHtmlConfirmation(redirected), false);
});

test("assessments require cited rationale; observed links do not establish acquisition feasibility", () => {
  const assessment = {
    sampleUrl: gap.gap[0]!.sampleUrl,
    pageType: "editorial" as const,
    topicalRelevance: "high" as const,
    feasibility: "plausible" as const,
    rationale: "Relevant review topic.",
    evidenceRefs: ["human:review-1"],
    publicationHistory: [],
  };
  const report = buildCompetitiveIntelligence({
    gap,
    competitorBacklinks: [link()],
    targetBacklinks: [],
    assessments: [assessment],
  });
  assert.equal(report.prospects[0]?.reviewOrder, 0);
  assert.throws(
    () =>
      buildCompetitiveIntelligence({
        gap,
        competitorBacklinks: [],
        targetBacklinks: [],
        assessments: [{ ...assessment, evidenceRefs: [] }],
      }),
    /cited rationale/,
  );
});

test("decisions retain evidence or assumptions, qualitative estimates and unknown costs", () => {
  const competitive = buildCompetitiveIntelligence({
    gap,
    competitorBacklinks: [],
    targetBacklinks: [],
  });
  const result = buildEvidenceDecisions({ competitive });
  const decision = result.decisions[0]!;
  assert.equal(decision.confidence, "assumption-only");
  assert.equal(decision.expectedEffect.kind, "hypothesis");
  assert.equal(decision.estimatedCost, null);
  assert.deepEqual(result.observedOutcomes, []);
  assert.ok(decision.assumptions.length);
  assert.deepEqual(buildEvidenceDecisions({ competitive }), result);
  assert.throws(() => buildEvidenceDecisions({}));
});

test("scan export adapter uses existing plan and marks unavailable legacy graph", () => {
  const report = {
    version: 8,
    queriedAt: gap.queriedAt,
    backlinks: [],
    target: { url: "https://target.example/" },
    siteAudit: null,
    plan: {
      items: [
        {
          id: "fix",
          title: "Review page",
          detail: "Inspect the condition.",
          samples: ["/page"],
          effort: "low",
          impact: 100,
          priority: 100,
        },
      ],
      quickWins: 1,
      coverage: 0,
    },
  };
  const result = analyzeScanReport({ ok: true, report });
  assert.equal(result.decisions.decisions[0]?.action, "Review page");
  assert.ok(result.decisions.decisions[0]?.evidence[0]?.hash);
  assert.ok("status" in result.technicalGraph);
  assert.throws(() => analyzeScanReport({ ok: false }), /failed scan/);
});

test("legacy high-severity orphan assertions remain low-priority investigations", () => {
  const result = buildEvidenceDecisions({
    scan: {
      queriedAt: gap.queriedAt,
      plan: { items: [], quickWins: 0, coverage: 0 },
      siteAudit: {
        status: "ok",
        crawled: 1,
        avgDepth: 0,
        avgInboundLinks: 0,
        maxDepth: 0,
        orphans: 1,
        brokenInternal: 0,
        redirectedInternal: 0,
        noindexPages: 0,
        pages: [],
        score: 96,
        issues: [
          {
            id: "orphan-pages",
            title: "Unreachable page",
            detail: "Legacy inferred finding.",
            severity: "high",
            count: 1,
            samples: ["/a"],
          },
        ],
      },
    },
  });
  assert.equal(result.decisions[0]?.priority, "low");
  assert.equal(result.decisions[0]?.expectedEffect.kind, "hypothesis");
});
