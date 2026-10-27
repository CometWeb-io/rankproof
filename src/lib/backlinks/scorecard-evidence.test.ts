import assert from "node:assert/strict";
import { test } from "node:test";
import { reportHtml } from "./export.ts";
import {
  buildFootprint,
  buildScorecard,
  footprintLabel,
  qualifiedScorecard,
  scorecardLabel,
  type ScorecardInput,
} from "./scorecard.ts";
import type { FootprintRisk, ReferringDomain, ScanReport, Scorecard } from "./types.ts";

const domain = (subnet: string | null = null) =>
  ({ domain: "publisher.example", links: 1, pages: 1, sitewide: false, subnet }) as ReferringDomain;
const unknownInput = (patch: Partial<ScorecardInput> = {}): ScorecardInput =>
  ({
    // Favorable numeric placeholders must not stand in for source observations.
    analytics: { referringDomains: [], anchors: [], health: { total: 100 } },
    serp: { queries: [], visibility: 100, trafficScore: 100, top10: 10 },
    onPage: null,
    siteAudit: null,
    toxic: { domains: [], avgToxicity: 0 },
    anchorAudit: { score: 100 },
    footprint: buildFootprint([], [], []),
    velocity: { verdict: "unknown" },
    brandSerp: null,
    domainRating: 100,
    referringDomains: 100,
    ...patch,
  }) as ScorecardInput;

test("no observed profile cannot establish low footprint risk or perfect subnet diversity", () => {
  const footprint = buildFootprint([], [], []);
  assert.equal(footprint.verdict, "unknown");
  assert.equal(footprint.status, "unknown");
  assert.equal(footprint.topSubnetShare, null);
  assert.equal(footprint.subnetDiversity, null);
  assert.equal(footprint.coverage.domains, 0);
});

test("missing DNS remains inconclusive even with other observed footprint features", () => {
  const footprint = buildFootprint([domain()], [{ effectiveFollow: false }] as never, [
    { key: "brand", share: 100 },
  ]);
  assert.equal(footprint.verdict, "inconclusive");
  assert.equal(footprint.status, "inconclusive");
  assert.equal(footprint.subnetDiversity, null);
  assert.equal(footprint.coverage.subnetDomains, 0);
  assert.ok(footprint.coverage.assessedSignals < footprint.coverage.totalSignals);
});

test("missing evidence cannot buy on-page, safety, momentum or profile credits", () => {
  const card = buildScorecard(unknownInput());
  assert.equal(card.index, 0);
  assert.equal(card.status, "unknown");
  assert.equal(card.coverage.availableMax, 0);
  assert.equal(card.provisional, true);
  assert.ok(card.parts.every((part) => part.score === 0 && part.availableMax === 0));
  assert.ok(card.parts.every((part) => part.status === "unknown"));
});

test("known structure does not fabricate a neutral landing page and vice versa", () => {
  for (const patch of [
    { siteAudit: { score: 100, crawled: 1, status: "ok", pages: [{ status: 200 }] } },
    { onPage: { score: 100 } },
  ]) {
    const card = buildScorecard(unknownInput(patch as never));
    const part = card.parts.find((row) => row.key === "onpage")!;
    assert.equal(part.score, 5);
    assert.equal(part.availableMax, 5);
    assert.equal(part.status, "inconclusive");
    assert.equal(card.index, 5);
    assert.equal(card.coverage.availableMax, 5);
  }
  const failed = buildScorecard(
    unknownInput({ siteAudit: { score: 100, crawled: 0, status: "failed" } } as never),
  );
  assert.equal(failed.parts.find((row) => row.key === "onpage")!.score, 0);
});

test("unknown velocity and absent brand do not earn neutral points", () => {
  const unknown = buildScorecard(unknownInput()).parts.find((row) => row.key === "momentum")!;
  const growing = buildScorecard(
    unknownInput({ velocity: { verdict: "growing" } } as never),
  ).parts.find((row) => row.key === "momentum")!;
  assert.equal(unknown.score, 0);
  assert.equal(growing.score, 6);
  assert.equal(growing.availableMax, 6);
  assert.equal(growing.status, "inconclusive");
});

test("failed SERP attempts remain outside scored coverage and cannot earn their share", () => {
  const queries = [
    { status: "ok", targetPosition: 1 },
    { status: "blocked", targetPosition: null },
  ];
  const card = buildScorecard(
    unknownInput({ serp: { queries, visibility: 100, trafficScore: 100, top10: 1 } } as never),
  );
  const part = card.parts.find((row) => row.key === "visibility")!;
  assert.equal(part.status, "inconclusive");
  assert.equal(part.availableMax, 12.5);
  assert.ok(part.score <= part.availableMax);
  assert.equal(card.coverage.successfulSerpAttempts, 1);
  assert.equal(card.coverage.attemptedSerp, 2);
  assert.equal(card.provisional, true);
});

test("successful no-result measurements remain known zero instead of unknown", () => {
  const card = buildScorecard(
    unknownInput({
      serp: {
        queries: [{ status: "no-results", targetPosition: null }],
        visibility: 0,
        trafficScore: 0,
        top10: 0,
      },
    } as never),
  );
  const part = card.parts.find((row) => row.key === "visibility")!;
  assert.equal(part.score, 0);
  assert.equal(part.availableMax, 25);
  assert.equal(part.status, "estimated");
  assert.match(scorecardLabel(card), /0\/100 · partial/);
  assert.doesNotMatch(scorecardLabel(card), /\(E\)/);
});

test("complete input availability permits a heuristic grade without claiming calibration", () => {
  const domains = [domain("93.184.216")];
  const footprint = buildFootprint(domains, [{ effectiveFollow: false }] as never, [
    { key: "brand", share: 100 },
  ]);
  const card = buildScorecard(
    unknownInput({
      analytics: { referringDomains: domains, anchors: [{ text: "Brand" }], health: { total: 70 } },
      serp: {
        queries: [{ status: "ok", keyword: "Brand", engine: "bing" }],
        visibility: 0,
        trafficScore: 0,
        top10: 0,
      },
      onPage: { score: 60 },
      siteAudit: { score: 50, crawled: 1, status: "ok", pages: [{ status: 200 }] },
      toxic: { domains: [{ domain: "publisher.example" }], avgToxicity: 10 },
      footprint,
      velocity: { verdict: "stable" },
      brandSerp: {
        keyword: "Brand",
        engine: "bing",
        results: [{ url: "https://publisher.example/" }],
        control: 0,
      },
    } as never),
  );
  assert.equal(card.status, "estimated");
  assert.equal(card.coverage.availableMax, 100);
  assert.equal(card.provisional, false);
  assert.ok(card.parts.every((part) => part.status === "estimated"));
  assert.match(scorecardLabel(card), /uncalibrated heuristic/);
  assert.match(scorecardLabel(card), /\([A-E]\)/);
});

test("legacy favorable scores and missing coverage are presented as unknown without a grade", () => {
  const legacy = { index: 100, grade: "A", parts: [] } as unknown as Scorecard;
  assert.equal(qualifiedScorecard(legacy), false);
  assert.match(scorecardLabel(legacy), /^Unknown/);
  assert.doesNotMatch(scorecardLabel(legacy), /100\/100|\(A\)/);
  assert.match(
    footprintLabel({ score: 0, verdict: "low", subnetDiversity: 100 } as FootprintRisk),
    /^Unknown/,
  );
  const unknown = buildScorecard(unknownInput());
  assert.match(scorecardLabel(unknown), /^Unknown · coverage 0\/100$/);
  assert.doesNotMatch(scorecardLabel(unknown), /\(E\)/);
});

test("saved v5 HTML export cannot qualify a nonempty archive profile or grade as current", () => {
  const report = {
    version: 5,
    target: { host: "target.example" },
    queriedAt: "2026-10-27T00:00:00Z",
    stats: { domainRating: 100, lostLinks: 1, onPageScore: 50 },
    // Legacy analytics included historical links. A nonempty table cannot establish current coverage.
    analytics: {
      referringDomains: [{ domain: "source.example", domainScore: 100 }],
      issues: [],
      health: { total: 100, grade: "A" },
    },
    scorecard: {
      index: 100,
      grade: "A",
      parts: [{ label: "Legacy quality", score: 15, max: 15, hint: "Perfect profile" }],
    },
    footprint: { score: 0, verdict: "low", subnetDiversity: 100 },
    onPage: null,
    serp: { queries: [], clusters: [] },
    velocity: { verdict: "unknown" },
    plan: { items: [] },
    toxic: { domains: [] },
    segments: [],
    keywords: [],
    prospects: [],
    backlinks: [{ state: "lost", sourceUrl: "https://source.example/old", flags: [] }],
  } as unknown as ScanReport;
  const html = reportHtml(report);
  assert.match(html, /Unknown \(legacy report; rescan for evidence coverage\)/);
  assert.match(html, /<b>Unknown<\/b>On-page heuristic/);
  assert.match(html, /<b>Unknown<\/b>Profile heuristic/);
  assert.match(html, /<b>Unknown<\/b>Sampled profile index \(uncalibrated\)/);
  assert.match(html, /<b>1<\/b>Archive candidates/);
  assert.match(html, /<td>archive candidate<\/td>/);
  assert.doesNotMatch(
    html,
    /100\/100 \(A\)|Perfect profile|Every link was confirmed|<td>lost<\/td>/,
  );
});
