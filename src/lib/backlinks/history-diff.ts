import type { ScanDelta, ScanReport, TrendPoint } from "./types.ts";
import { comparableObservationCohort, measurementComparability } from "./measurement-comparison.ts";
import type { RunManifest } from "./measurement.server.ts";

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
  measurement?: RunManifest | null;
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
  // Legacy rows lack coverage/identity manifests; comparing them fabricates acquisition and score changes.
  if (!row) return null;
  if (report.measurement) {
    if (
      !row.measurement ||
      !comparableObservationCohort(row.measurement, report.measurement) ||
      !(Date.parse(report.queriedAt) > Date.parse(toIso(row.queried_at)))
    )
      return null;
    const previousIds = new Set(asList(row.link_ids));
    const previousDomains = new Set(asList(row.domains));
    const currentIds = new Set(
      report.backlinks.filter((b) => b.state === "live" && b.verified).map((b) => b.id),
    );
    const newIds = [...currentIds].filter((id) => !previousIds.has(id));
    const comparable = measurementComparability(row.measurement, report.measurement);
    return {
      previousAt: toIso(row.queried_at),
      newLinks: newIds.length,
      lostLinks: 0,
      newDomains: report.analytics.referringDomains
        .map((d) => d.domain)
        .filter((d) => !previousDomains.has(d))
        .slice(0, 40),
      lostDomains: [],
      backlinkDelta: report.stats.backlinks - row.backlinks,
      domainDelta: report.stats.referringDomains - row.referring_domains,
      healthDelta: comparable.scores ? report.analytics.health.total - row.health : null,
      ratingDelta: comparable.scores ? report.stats.domainRating - row.domain_rating : null,
      visibilityDelta: comparable.visibility
        ? report.stats.serpVisibility - (row.visibility ?? 0)
        : null,
      unobservedLinks: [...previousIds].filter((id) => !currentIds.has(id)).length,
      commonLinks: [...currentIds].filter((id) => previousIds.has(id)).length,
      basis: "discovery_sample",
      newIds: newIds.slice(0, MAX_HISTORY_IDS),
    };
  }
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
