import assert from "node:assert/strict";
import { test } from "node:test";
import { buildKeywordStats, collectKeywords, visibilityScore } from "./keywords.ts";
import { buildRankMoves, positionCtr, serpAggregates } from "./serp-intel.ts";
import type { SerpQuery } from "./types.ts";

function query(
  position: number | null,
  status: SerpQuery["status"] = "ok",
  keyword = "example",
): SerpQuery {
  return {
    keyword,
    engine: "bing",
    targetPosition: position,
    status,
    results: [],
    features: [],
    related: [],
    questions: [],
    depth: 20,
    difficulty: 20,
    market: "us",
    device: "desktop",
    ms: 1,
  };
}

test("visibility ranks 1–20 monotonically without a negative contribution", () => {
  let previous = 101;
  for (let position = 1; position <= 20; position++) {
    const score = visibilityScore([query(position)]).visibility;
    assert.ok(score >= 0 && score < previous, `${position}: ${score} >= ${previous}`);
    previous = score;
    const mixed = visibilityScore([query(1), query(position, "ok", "another")]);
    assert.ok(mixed.visibility >= 50);
  }
  assert.equal(visibilityScore([query(null, "blocked")]).measured, 0);
  assert.equal(visibilityScore([query(1), query(1, "blocked", "another")]).visibility, 100);
});

test("failed source data cannot create a position or an opportunity", () => {
  const seeds = [{ keyword: "example", source: "brand" as const, weight: 90 }];
  for (const status of [
    "blocked",
    "error",
    "parser-failed",
    "not-configured",
    "rate-limited",
    "empty-response",
  ] as const) {
    const stat = buildKeywordStats(seeds, [query(1, status)], [])[0]!;
    assert.equal(stat.bestPosition, null);
    assert.equal(stat.opportunity, 0);
    assert.equal(stat.trafficShare, 0);
    assert.equal(serpAggregates([query(1, status)]).trafficScore, 0);
  }
  assert.ok(buildKeywordStats(seeds, [query(null, "no-results")], [])[0]!.opportunity > 0);
  assert.equal(buildKeywordStats(seeds, [], [])[0]!.opportunity, 0);
});

test("Google measurements participate and malformed positions do not", () => {
  const seeds = [{ keyword: "example", source: "brand" as const, weight: 90 }];
  assert.equal(
    buildKeywordStats(seeds, [{ ...query(4), engine: "google" }], [])[0]!.bestPosition,
    4,
  );
  for (const position of [0, -1, 1.5, NaN, Infinity]) {
    assert.equal(visibilityScore([query(position)]).ranked, 0);
    assert.equal(positionCtr(position), 0);
    assert.equal(serpAggregates([query(position)]).trafficScore, 0);
  }
});

test("keyword identity retains scripts and diacritics across six markets", () => {
  for (const title of [
    "żółta łódź",
    "Straße München",
    "développement durable",
    "diseño técnico",
    "東京 観光",
    "القاهرة سياحة",
  ]) {
    assert.ok(
      collectKeywords({ title }).some((seed) => seed.keyword === title.toLowerCase()),
      title,
    );
  }
});

test("failed and omitted queries cannot prove a ranking loss", () => {
  const previous = [{ keyword: "example", engine: "bing", position: 2 }];
  assert.deepEqual(buildRankMoves([], previous), []);
  assert.deepEqual(buildRankMoves([query(null, "blocked")], previous), []);
  assert.equal(buildRankMoves([query(null, "no-results")], previous)[0]!.state, "lost");
});

test("a scorecard marks unavailable SERP as provisional instead of the weakest measured result", async () => {
  const { buildScorecard } = await import("./scorecard.ts");
  const card = buildScorecard({
    analytics: { health: { total: 70 } },
    anchorAudit: { score: 80 },
    serp: { queries: [query(null, "blocked")], visibility: 0, trafficScore: 0, top10: 0 },
    toxic: { avgToxicity: 10 },
    footprint: { score: 0, verdict: "low" },
    velocity: { verdict: "stable" },
    brandSerp: null,
    domainRating: 40,
    referringDomains: 5,
  } as never);
  assert.equal(card.provisional, true);
  assert.equal(card.measuredMax, 75);
  assert.match(card.parts.find((p) => p.key === "visibility")!.hint, /unavailable/);
  assert.notEqual(card.weakest, "SERP visibility (unmeasured)");
});

test("rank changes exclude different market, device, depth and failed prior attempts", () => {
  const prior = {
    keyword: "example",
    engine: "bing",
    position: 2,
    market: "us",
    device: "desktop",
    depth: 20,
    status: "ok",
  };
  for (const patch of [
    { market: "de" },
    { device: "mobile" },
    { depth: 10 },
    { status: "blocked" },
  ]) {
    assert.deepEqual(buildRankMoves([query(4)], [{ ...prior, ...patch }]), []);
  }
  assert.equal(buildRankMoves([query(4)], [prior])[0]!.state, "down");
});
