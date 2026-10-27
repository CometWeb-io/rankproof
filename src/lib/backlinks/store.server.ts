import { getSql } from "@/lib/db";
import { URL_IDENTITY_POLICY } from "./parse.ts";
import { sourceRevision } from "./measurement.server.ts";
import { buildEvidenceLedger, type EvidenceLedger } from "./evidence-ledger.server.ts";
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
           coalesce(visibility, 0) as visibility, measurement
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
export async function loadPreviousPositions(
  host: string,
  before: string,
  scope?: Pick<SerpQuery, "market" | "device" | "depth">,
): Promise<PositionRow[]> {
  if (!scope) return [];
  const sql = await getSql();
  const rows = await sql<{
    keyword: string;
    engine: string;
    position: number | null;
    market: string;
    device: string;
    checked_depth: number;
    result_status: string;
  }>`
    select distinct on (keyword, engine) keyword, engine, position, market, device, checked_depth, result_status
    from serp_rank_history
    where host = ${host} and queried_at < ${before}
      and market = ${scope.market} and device = ${scope.device} and checked_depth = ${scope.depth}
      and result_status in ('ok', 'no-results')
      and identity_policy = ${URL_IDENTITY_POLICY} and measurement_version = 'serp-observation-v1'
    order by keyword, engine, queried_at desc
  `;
  return rows.map((row) => ({
    keyword: row.keyword,
    engine: row.engine,
    position: row.position === null ? null : Number(row.position),
    market: row.market,
    device: row.device,
    depth: Number(row.checked_depth),
    status: row.result_status,
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
      insert into serp_rank_history (host, keyword, engine, position, difficulty, queried_at,
        market, device, checked_depth, result_status, identity_policy, measurement_version, source_revision)
      values (${host}, ${query.keyword}, ${query.engine}, ${query.targetPosition},
              ${query.difficulty}, ${queriedAt}, ${query.market}, ${query.device}, ${query.depth},
              ${query.status}, ${URL_IDENTITY_POLICY}, 'serp-observation-v1', ${sourceRevision()})
    `;
  }
}

export async function saveScan(report: ScanReport): Promise<void> {
  const sql = await getSql();
  const ledger = buildEvidenceLedger(report);
  await sql`
    insert into evidence_runs (root_hash, host, queried_at, ledger)
    values (${ledger.rootHash}, ${report.target.host}, ${report.queriedAt}, ${JSON.stringify(ledger)}::jsonb)
    on conflict (root_hash) do nothing
  `;
  await sql`
    insert into scan_history (
      host, queried_at, backlinks, referring_domains, dofollow, domain_rating,
      health, spam_domains, lost_links, visibility, link_ids, domains, measurement
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
      ${JSON.stringify(
        report.backlinks
          .filter((b) => !report.measurement || (b.verified && b.state === "live"))
          .slice(0, MAX_HISTORY_IDS)
          .map((b) => b.id),
      )}::jsonb,
      ${JSON.stringify(report.analytics.referringDomains.map((d) => d.domain))}::jsonb,
      ${JSON.stringify(report.measurement ?? null)}::jsonb
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
    report = await attachRelationshipDates(report);
    const rows = await loadScanRows(report.target.host);
    const delta = rowToDelta(report, rows[0]);
    const trend = rowsToTrend(rows);

    // Rank moves are computed before the current measurement is written.
    let moves = report.measurement ? [] : report.serp.moves;
    try {
      const previous = report.measurement
        ? []
        : await loadPreviousPositions(report.target.host, report.queriedAt);
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

    // Sample history cannot establish acquisition; buildVelocity keeps it unknown without dated cohorts.
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

/** Export immutable stored evidence for a specific run; no inferred reconstruction. */
export async function loadEvidenceLedger(host: string, at: string): Promise<EvidenceLedger | null> {
  const sql = await getSql();
  const rows = await sql<{ ledger: EvidenceLedger }>`
    select ledger from evidence_runs where host = ${host} and queried_at = ${at}
    order by root_hash limit 1
  `;
  return rows[0]?.ledger ?? null;
}

async function attachRelationshipDates(report: ScanReport): Promise<ScanReport> {
  const sql = await getSql();
  const rows = await sql<{
    pair_id: string;
    first_observed: Date | string;
    last_confirmed: Date | string | null;
    last_attempted: Date | string | null;
  }>`
    select observation->>'pairId' as pair_id,
      min((observation->>'observedAt')::timestamptz) as first_observed,
      max((observation->>'observedAt')::timestamptz) filter (where observation->>'status' = 'CONFIRMED') as last_confirmed,
      max((observation->>'observedAt')::timestamptz) filter (where observation->>'status' = 'CONFIRMED') as last_attempted
    from evidence_runs, jsonb_array_elements(ledger->'observations') observation
    where host = ${report.target.host} and queried_at <= ${report.queriedAt}
    group by observation->>'pairId'
  `;
  const previous = new Map(rows.map((row) => [row.pair_id, row]));
  const iso = (value: string | Date | null) =>
    value === null ? null : new Date(value).toISOString();
  const update = (row: ScanReport["backlinks"][number]) => {
    const old = previous.get(row.id);
    const at = row.evidence?.observedAt ?? report.queriedAt;
    const confirmed = row.evidence?.kind === "html_anchor" && row.verified && row.state === "live";
    return {
      ...row,
      firstObserved: old ? iso(old.first_observed) : at,
      lastConfirmed: confirmed ? at : old ? iso(old.last_confirmed) : null,
      lastAttempted: confirmed ? at : old ? iso(old.last_attempted) : null,
    };
  };
  return {
    ...report,
    backlinks: report.backlinks.map(update),
    providerReports: report.providerReports?.map(update),
  };
}
