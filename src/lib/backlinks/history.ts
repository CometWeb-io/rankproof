import type { ScanReport } from "./types.ts";

export type HistoryItem = {
  host: string;
  input: string;
  at: string;
  backlinks: number;
  referringDomains: number;
  health: number;
  /** Link identifiers — they let us count new and lost links. */
  ids: string[];
  domains: string[];
};

export type ScanDiff = {
  previousAt: string;
  newLinks: number;
  lostLinks: number;
  newDomains: string[];
  lostDomains: string[];
  backlinkDelta: number;
  domainDelta: number;
  healthDelta: number;
  newIds: Set<string>;
};

const KEY = "linkradar:history:v2";
const LIMIT = 12;
const MAX_IDS = 500;

export function loadHistory(): HistoryItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isHistoryItem);
  } catch {
    return [];
  }
}

function isHistoryItem(item: unknown): item is HistoryItem {
  if (typeof item !== "object" || item === null) return false;
  const row = item as Partial<HistoryItem>;
  return typeof row.host === "string" && typeof row.input === "string";
}

export function toHistoryItem(report: ScanReport, input: string): HistoryItem {
  return {
    host: report.target.host,
    input,
    at: report.queriedAt,
    backlinks: report.stats.backlinks,
    referringDomains: report.stats.referringDomains,
    health: report.analytics.health.total,
    ids: report.backlinks.slice(0, MAX_IDS).map((b) => b.id),
    domains: report.analytics.referringDomains.map((d) => d.domain),
  };
}

export function findPrevious(host: string): HistoryItem | null {
  return loadHistory().find((row) => row.host === host) ?? null;
}

/** Comparison with the previous scan of the same domain: new and lost links. */
export function diffReport(report: ScanReport, previous: HistoryItem | null): ScanDiff | null {
  if (!previous || previous.host !== report.target.host) return null;
  if (previous.at === report.queriedAt) return null;

  const prevIds = new Set(previous.ids ?? []);
  const prevDomains = new Set(previous.domains ?? []);
  const currentIds = report.backlinks.map((b) => b.id);
  const currentDomains = report.analytics.referringDomains.map((d) => d.domain);
  const currentDomainSet = new Set(currentDomains);

  const newIds = new Set(currentIds.filter((id) => !prevIds.has(id)));
  const lostLinks = [...prevIds].filter((id) => !currentIds.includes(id)).length;

  return {
    previousAt: previous.at,
    newLinks: newIds.size,
    lostLinks,
    newDomains: currentDomains.filter((d) => !prevDomains.has(d)).slice(0, 30),
    lostDomains: [...prevDomains].filter((d) => !currentDomainSet.has(d)).slice(0, 30),
    backlinkDelta: report.stats.backlinks - previous.backlinks,
    domainDelta: report.stats.referringDomains - previous.referringDomains,
    healthDelta: report.analytics.health.total - (previous.health ?? 0),
    newIds,
  };
}

export function pushHistory(item: HistoryItem): HistoryItem[] {
  const next = [item, ...loadHistory().filter((row) => row.host !== item.host)].slice(0, LIMIT);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  return next;
}
