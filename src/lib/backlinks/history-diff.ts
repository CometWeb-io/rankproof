import type { ScanDelta, ScanReport, TrendPoint } from "./types.ts";

export const MAX_HISTORY_IDS = 800;
export const TREND_LIMIT = 30;

export type ScanRow = {
  queried_at: string | Date;
  backlinks: number;
  referring_domains: number;
  dofollow: number;
  domain_rating: number;
  health: number;
  spam_domains: number;
  lost_links: number;
  visibility?: number | null;
  link_ids: string[] | null;
  domains: string[] | null;
};


function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function rowsToTrend(rows: ScanRow[]): TrendPoint[] {
  return rows
    .map((row) => ({
      at: toIso(row.queried_at),
      backlinks: row.backlinks,
      referringDomains: row.referring_domains,
      domainRating: row.domain_rating,
      health: row.health,
      visibility: row.visibility ?? 0,
    }))
    .reverse();
}

/** The difference against the previous stored scan of the same domain. */
export function rowToDelta(report: ScanReport, row: ScanRow | undefined): ScanDelta | null {
  if (!row) return null;
  const prevIds = new Set(asList(row.link_ids));
  const prevDomains = new Set(asList(row.domains));
  const currentIds = report.backlinks.map((b) => b.id);
  const currentIdSet = new Set(currentIds);
  const currentDomains = report.analytics.referringDomains.map((d) => d.domain);
  const currentDomainSet = new Set(currentDomains);
  const newIds = currentIds.filter((id) => !prevIds.has(id));

  return {
    previousAt: toIso(row.queried_at),
    newLinks: newIds.length,
    lostLinks: [...prevIds].filter((id) => !currentIdSet.has(id)).length,
    newDomains: currentDomains.filter((d) => !prevDomains.has(d)).slice(0, 40),
    lostDomains: [...prevDomains].filter((d) => !currentDomainSet.has(d)).slice(0, 40),
    backlinkDelta: report.stats.backlinks - row.backlinks,
    domainDelta: report.stats.referringDomains - row.referring_domains,
    healthDelta: report.analytics.health.total - row.health,
    ratingDelta: report.stats.domainRating - row.domain_rating,
    visibilityDelta: report.stats.serpVisibility - (row.visibility ?? 0),
    newIds: newIds.slice(0, MAX_HISTORY_IDS),
  };
}
