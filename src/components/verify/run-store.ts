/**
 * Runs kept in this browser (localStorage), newest last. A convenience for
 * comparing and for a short per-link timeline — durable monitoring belongs to
 * `rankproof verify --history`. Every access is wrapped: storage can be
 * blocked, full or wiped by the browser at any time.
 */
import { pairKey, previousObservations, type ObservationLike } from "@/lib/backlinks/observe";
import type { BacklinkObservation } from "@/lib/backlinks/verify-api.server";

const KEY = "rankproof.verify.runs.v2";
const LEGACY_KEY = "rankproof.verify.last-run.v1";
export const MAX_RUNS = 12;

export type StoredRun = { saved_at: string; results: ObservationLike[] };

function slim(results: BacklinkObservation[]): ObservationLike[] {
  return results.map((r) => ({
    source_url: r.source_url,
    target_url: r.target_url,
    status: r.status,
    checked_at: r.checked_at,
    anchor: r.anchor,
    rel: r.rel,
    reason: r.reason,
    absence_scope: r.absence_scope,
    resolved_href: r.resolved_href,
    response_hash: r.response_hash,
    placement: r.placement,
  }));
}

export function loadRuns(): StoredRun[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const json = JSON.parse(raw) as { runs?: unknown };
      if (Array.isArray(json.runs)) {
        return json.runs
          .map((run) => {
            try {
              return {
                saved_at: String((run as { saved_at?: unknown }).saved_at ?? ""),
                results: previousObservations(run),
              };
            } catch {
              return null;
            }
          })
          .filter((run): run is StoredRun => Boolean(run && run.results.length > 0));
      }
    }
    // One-time upgrade from the single-run format.
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const json = JSON.parse(legacy) as { saved_at?: string };
      return [{ saved_at: json.saved_at ?? "", results: previousObservations(json) }];
    }
  } catch {
    /* unreadable storage: no history */
  }
  return [];
}

export function appendRun(results: BacklinkObservation[]): StoredRun[] {
  const runs = [
    ...loadRuns(),
    { saved_at: new Date().toISOString(), results: slim(results) },
  ].slice(-MAX_RUNS);
  try {
    localStorage.setItem(KEY, JSON.stringify({ runs }));
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* full or blocked: keep the in-memory copy for this session */
  }
  return runs;
}

export function clearRuns(): void {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
}

export type TimelinePoint = { at: string; status: ObservationLike["status"] | "absent" };

/** One point per stored run: the pair's status, or "absent" when the run did not include it. */
export function timelineFor(
  runs: StoredRun[],
  sourceUrl: string,
  targetUrl: string,
): TimelinePoint[] {
  const key = pairKey(sourceUrl, targetUrl);
  return runs.map((run) => {
    const hit = run.results.find((item) => pairKey(item.source_url, item.target_url) === key);
    return { at: hit?.checked_at ?? run.saved_at, status: hit ? hit.status : "absent" };
  });
}
