import { positionCtr } from "./serp-intel.ts";
import type {
  SearchConsoleData,
  SearchConsoleInsights,
  SearchConsoleRow,
  SerpQuery,
} from "./types.ts";

/**
 * Analysis of real Search Console data.
 *
 * These checks are only possible with owner-level data, and each one answers
 * a question that scraped positions cannot:
 *
 *  - striking distance: which queries sit just outside the top three *and*
 *    already earn impressions, so the traffic upside is measured, not guessed
 *  - CTR anomalies: pages ranking well that nobody clicks — a title and
 *    description problem, not a ranking problem
 *  - decay: queries losing clicks while the position holds
 *  - cannibalisation: two of your pages taking impressions on one query
 *  - estimate accuracy: how far our CTR model sits from reality
 */

function keyOf(row: SearchConsoleRow): string {
  return (row.keys[0] ?? "").toLowerCase();
}

/** Queries at positions 4–15 with real impressions — the cheapest upside. */
export function strikingDistance(data: SearchConsoleData, limit = 20) {
  return data.queries
    .filter((row) => row.position >= 3.5 && row.position <= 15 && row.impressions >= 20)
    .map((row) => {
      // Potential = impressions × (CTR at position 3 − current CTR).
      const targetCtr = positionCtr(3) / 100;
      const currentCtr = row.ctr / 100;
      const upside = Math.max(0, Math.round(row.impressions * (targetCtr - currentCtr)));
      return { ...row, query: row.keys[0] ?? "", potentialClicks: upside };
    })
    .filter((row) => row.potentialClicks > 0)
    .sort((a, b) => b.potentialClicks - a.potentialClicks)
    .slice(0, limit);
}

/**
 * Pages and queries whose CTR is far below what their position normally
 * earns. Almost always a snippet problem: the ranking already works.
 */
export function ctrAnomalies(data: SearchConsoleData, limit = 20) {
  return data.queries
    .filter((row) => row.impressions >= 50 && row.position <= 10)
    .map((row) => {
      const expected = positionCtr(Math.round(row.position));
      const gap = Math.round((expected - row.ctr) * 10) / 10;
      return {
        query: row.keys[0] ?? "",
        position: row.position,
        impressions: row.impressions,
        clicks: row.clicks,
        ctr: row.ctr,
        expectedCtr: expected,
        gap,
        lostClicks: Math.max(0, Math.round((gap / 100) * row.impressions)),
      };
    })
    .filter((row) => row.gap >= 2 && row.lostClicks >= 5)
    .sort((a, b) => b.lostClicks - a.lostClicks)
    .slice(0, limit);
}

/** Queries losing clicks against the previous window of equal length. */
export function decayingQueries(data: SearchConsoleData, limit = 20) {
  const before = new Map(data.previousQueries.map((row) => [keyOf(row), row]));
  return data.queries
    .map((row) => {
      const previous = before.get(keyOf(row));
      if (!previous || previous.clicks < 5) return null;
      const clickDelta = row.clicks - previous.clicks;
      const positionDelta = Math.round((previous.position - row.position) * 10) / 10;
      return {
        query: row.keys[0] ?? "",
        clicks: row.clicks,
        previousClicks: previous.clicks,
        clickDelta,
        position: row.position,
        positionDelta,
        // Losing clicks while holding position points at the SERP or the
        // snippet, not at the ranking.
        positionStable: Math.abs(positionDelta) < 1,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null && row.clickDelta <= -3)
    .sort((a, b) => a.clickDelta - b.clickDelta)
    .slice(0, limit);
}

/**
 * How close our CTR curve is to this site's reality. Reported honestly so
 * nobody treats the modelled traffic number as a measurement.
 */
export function modelAccuracy(data: SearchConsoleData): {
  samples: number;
  meanAbsoluteError: number;
  bias: number;
  verdict: "close" | "optimistic" | "pessimistic" | "unknown";
} {
  const sample = data.queries.filter((row) => row.impressions >= 100 && row.position <= 20);
  if (sample.length < 5) {
    return { samples: sample.length, meanAbsoluteError: 0, bias: 0, verdict: "unknown" };
  }
  let absolute = 0;
  let signed = 0;
  for (const row of sample) {
    const expected = positionCtr(Math.round(row.position));
    absolute += Math.abs(expected - row.ctr);
    signed += expected - row.ctr;
  }
  const mae = Math.round((absolute / sample.length) * 10) / 10;
  const bias = Math.round((signed / sample.length) * 10) / 10;
  return {
    samples: sample.length,
    meanAbsoluteError: mae,
    bias,
    verdict: mae <= 2 ? "close" : bias > 0 ? "optimistic" : "pessimistic",
  };
}

/**
 * Compares scraped positions with the ones Google reports. Large gaps are
 * expected — we measure Bing, DuckDuckGo, Mojeek and Brave — and knowing the
 * size of that gap is more honest than pretending it does not exist.
 */
export function comparePositions(data: SearchConsoleData, queries: SerpQuery[], limit = 20) {
  const scraped = new Map<string, number>();
  for (const query of queries) {
    if (query.targetPosition === null) continue;
    const key = query.keyword.toLowerCase();
    const current = scraped.get(key);
    if (current === undefined || query.targetPosition < current) {
      scraped.set(key, query.targetPosition);
    }
  }
  const out = [];
  for (const row of data.queries) {
    const key = keyOf(row);
    const ours = scraped.get(key);
    if (ours === undefined) continue;
    out.push({
      query: row.keys[0] ?? "",
      google: row.position,
      measured: ours,
      gap: Math.round((row.position - ours) * 10) / 10,
      impressions: row.impressions,
    });
  }
  return out.sort((a, b) => b.impressions - a.impressions).slice(0, limit);
}

/** Aggregates every check into the shape carried by the report. */
export function buildSearchConsoleInsights(
  providers: SearchConsoleData[],
  queries: SerpQuery[],
): SearchConsoleInsights | null {
  const google = providers.find((item) => item.source === "google" && item.connected);
  const primary = google ?? providers.find((item) => item.connected) ?? null;
  if (!primary) {
    const failed = providers[0];
    return failed
      ? {
          connected: false,
          providers,
          striking: [],
          ctrAnomalies: [],
          decaying: [],
          comparison: [],
          accuracy: { samples: 0, meanAbsoluteError: 0, bias: 0, verdict: "unknown" },
          hint: failed.error ?? "No search-engine account connected.",
        }
      : null;
  }

  const striking = strikingDistance(primary);
  const anomalies = ctrAnomalies(primary);
  const decaying = decayingQueries(primary);
  const accuracy = modelAccuracy(primary);

  const parts: string[] = [];
  if (striking.length > 0) {
    const total = striking.reduce((sum, row) => sum + row.potentialClicks, 0);
    parts.push(
      `${striking.length} queries sit just outside the top three — reaching position 3 on all of them is worth roughly ${total} extra clicks per ${primary.days} days.`,
    );
  }
  if (anomalies.length > 0) {
    const lost = anomalies.reduce((sum, row) => sum + row.lostClicks, 0);
    parts.push(
      `${anomalies.length} queries rank well but under-perform on clicks — about ${lost} clicks lost to weak titles and descriptions.`,
    );
  }
  if (decaying.filter((row) => row.positionStable).length > 0) {
    parts.push(
      "Some queries are losing clicks while holding position — usually a SERP layout change or a snippet that stopped working.",
    );
  }
  if (parts.length === 0) {
    parts.push("No obvious quick wins in the connected performance data.");
  }

  return {
    connected: true,
    providers,
    striking,
    ctrAnomalies: anomalies,
    decaying,
    comparison: comparePositions(primary, queries),
    accuracy,
    hint: parts.join(" "),
  };
}
