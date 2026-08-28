import { getSql } from "@/lib/db";
import {
  MAX_HISTORY_IDS,
  TREND_LIMIT,
  rowToDelta,
  rowsToTrend,
  type ScanRow,
} from "./history-diff.ts";
import { buildRankMoves, type PositionRow } from "./serp-intel.ts";
import { buildVelocity } from "./segments.ts";
import type { ScanReport, SerpQuery } from "./types.ts";

/** The most recent scans for a domain, newest first. */
export async function loadScanRows(host: string, limit = TREND_LIMIT): Promise<ScanRow[]> {
  const sql = await getSql();
  return sql<ScanRow>`
    select queried_at, backlinks, referring_domains, dofollow, domain_rating,
           health, spam_domains, lost_links, link_ids, domains,
           coalesce(visibility, 0) as visibility
    from scan_history
    where host = ${host}
    order by queried_at desc
    limit ${limit}
  `;
}

/**
 * Positions from the most recent earlier scan — one row per (keyword, engine)
 * pair. We take the latest measurement preceding the current scan.
 */
export async function loadPreviousPositions(host: string, before: string): Promise<PositionRow[]> {
  const sql = await getSql();
  const rows = await sql<{ keyword: string; engine: string; position: number | null }>`
    select distinct on (keyword, engine) keyword, engine, position
    from serp_rank_history
    where host = ${host} and queried_at < ${before}
    order by keyword, engine, queried_at desc
  `;
  return rows.map((row) => ({
    keyword: row.keyword,
    engine: row.engine,
    position: row.position === null ? null : Number(row.position),
  }));
}

/** Stores the current scan's positions — the basis for gains and drops. */
export async function saveSerpPositions(
  host: string,
  queriedAt: string,
  queries: SerpQuery[],
): Promise<void> {
  if (queries.length === 0) return;
  const sql = await getSql();
  for (const query of queries.slice(0, 60)) {
    await sql`
      insert into serp_rank_history (host, keyword, engine, position, difficulty, queried_at)
      values (${host}, ${query.keyword}, ${query.engine}, ${query.targetPosition},
              ${query.difficulty}, ${queriedAt})
    `;
  }
}

export async function saveScan(report: ScanReport): Promise<void> {
  const sql = await getSql();
  await sql`
    insert into scan_history (
      host, queried_at, backlinks, referring_domains, dofollow, domain_rating,
      health, spam_domains, lost_links, visibility, link_ids, domains
    ) values (
      ${report.target.host},
      ${report.queriedAt},
      ${report.stats.backlinks},
      ${report.stats.referringDomains},
      ${report.stats.dofollow},
      ${report.stats.domainRating},
      ${report.analytics.health.total},
      ${report.stats.spamDomains},
      ${report.stats.lostLinks},
      ${report.stats.serpVisibility},
      ${JSON.stringify(report.backlinks.slice(0, MAX_HISTORY_IDS).map((b) => b.id))}::jsonb,
      ${JSON.stringify(report.analytics.referringDomains.map((d) => d.domain))}::jsonb
    )
  `;
}

/**
 * Adds trend and diff data from the database to the report, then stores the
 * current scan. A database failure must never break the report — in that case
 * the browser-side history remains.
 */
export async function attachHistory(report: ScanReport): Promise<ScanReport> {
  try {
    const rows = await loadScanRows(report.target.host);
    const delta = rowToDelta(report, rows[0]);
    const trend = rowsToTrend(rows);

    // Rank moves are computed before the current measurement is written.
    let moves = report.serp.moves;
    try {
      const previous = await loadPreviousPositions(report.target.host, report.queriedAt);
      if (previous.length > 0) moves = buildRankMoves(report.serp.queries, previous);
      await saveSerpPositions(report.target.host, report.queriedAt, report.serp.queries);
    } catch {
      // SERP history is optional — a missing table must not break the report.
    }

    await saveScan(report);
    const fullTrend = [
      ...trend,
      {
        at: report.queriedAt,
        backlinks: report.stats.backlinks,
        referringDomains: report.stats.referringDomains,
        domainRating: report.stats.domainRating,
        health: report.analytics.health.total,
        visibility: report.stats.serpVisibility,
      },
    ].slice(-TREND_LIMIT);

    // With scan history available, link velocity is more accurate than from the archive.
    const velocity =
      report.velocity.verdict === "unknown"
        ? buildVelocity(report.analytics.referringDomains, fullTrend)
        : report.velocity;

    return {
      ...report,
      velocity,
      stats: { ...report.stats, linkVelocity: velocity.perMonth },
      serp: { ...report.serp, moves },
      trend: fullTrend,
      delta,
      persisted: true,
    };
  } catch {
    return report;
  }
}

export { rowToDelta, rowsToTrend };
