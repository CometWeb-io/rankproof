import type { ScanReport } from "./types.ts";

export type HistoryItem = {
  host: string;
  input: string;
  at: string;
  scopeKey?: string;
  backlinks: number;
  referringDomains: number;
  health: number;
  /** Link identifiers — they let us count new and lost links. */
  ids: string[];
  domains: string[];
};

export type ScanDiff = {
  previousAt: string;
  /** Only a verified archived-vs-live comparison proves loss. */
  notRediscoveredLinks?: number;
  notRediscoveredDomains?: string[];
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
    scopeKey: report.scopeKey,
    backlinks: report.stats.backlinks,
    referringDomains: report.stats.referringDomains,
    health: report.analytics.health.total,
    ids: report.backlinks.slice(0, MAX_IDS).map((b) => b.id),
    domains: report.analytics.referringDomains.map((d) => d.domain),
  };
}

/** Pick the most recent comparable observation rather than just the last host scan. */
export function previousForScope(
  items: HistoryItem[],
  host: string,
  scopeKey: string | undefined,
): HistoryItem | null {
  if (!scopeKey) return null;
  const candidates = items.filter((item) => item.host === host && item.scopeKey === scopeKey);
  return candidates.sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}

export function findPrevious(host: string, scopeKey?: string): HistoryItem | null {
  const items = loadHistory();
  if (scopeKey) return previousForScope(items, host, scopeKey);
  return items.find((row) => row.host === host) ?? null;
}

/** Comparison with the previous scan of the same domain: new and lost links. */
export function diffReport(report: ScanReport, previous: HistoryItem | null): ScanDiff | null {
  // The UI starts a scan before knowing its scope; an unrelated latest
  // observation must not hide an older comparable observation.
  let comparable = previous;
  if (
    !report.scopeKey ||
    comparable?.scopeKey !== report.scopeKey ||
    comparable.host !== report.target.host
  ) {
    comparable = previousForScope(loadHistory(), report.target.host, report.scopeKey);
  }
  if (!comparable || comparable.at === report.queriedAt) return null;

  const prevIds = new Set(comparable.ids ?? []);
  const prevDomains = new Set(comparable.domains ?? []);
  const currentIds = report.backlinks.map((b) => b.id);
  const currentDomains = report.analytics.referringDomains.map((d) => d.domain);
  const currentDomainSet = new Set(currentDomains);

  const newIds = new Set(currentIds.filter((id) => !prevIds.has(id)));
  const notRediscoveredLinks = [...prevIds].filter((id) => !currentIds.includes(id)).length;

  return {
    previousAt: comparable.at,
    newLinks: newIds.size,
    lostLinks: 0,
    notRediscoveredLinks,
    newDomains: currentDomains.filter((d) => !prevDomains.has(d)).slice(0, 30),
    lostDomains: [],
    notRediscoveredDomains: [...prevDomains].filter((d) => !currentDomainSet.has(d)).slice(0, 30),
    backlinkDelta: report.stats.backlinks - comparable.backlinks,
    domainDelta: report.stats.referringDomains - comparable.referringDomains,
    healthDelta: report.analytics.health.total - (comparable.health ?? 0),
    newIds,
  };
}

export function pushHistory(item: HistoryItem): HistoryItem[] {
  const next = [
    item,
    ...loadHistory().filter((row) => row.host !== item.host || row.scopeKey !== item.scopeKey),
  ].slice(0, LIMIT);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  return next;
}
