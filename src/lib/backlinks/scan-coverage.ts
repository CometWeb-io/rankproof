/**
 * Describes the requested and observed scope of a bounded scan. This is not a
 * guarantee of complete search-engine discovery. A different fingerprint must
 * never yield a direct before/after or link-loss comparison.
 */
export type ScanScope = {
  host: string;
  requestedUrl?: string;
  profile: string;
  market: string;
  device: string;
  serpDepth: number;
  keywords: string[];
  engines: string[];
  sources: { id: string; status: string }[];
  siteAudit: boolean;
  backlinkCap: number;
  verifyCap: number;
  truncated?: boolean;
};

export function scanScopeKey(input: ScanScope): string {
  return JSON.stringify({
    version: 1,
    host: input.host.toLowerCase(),
    requestedUrl: input.requestedUrl ?? null,
    profile: input.profile,
    market: input.market,
    device: input.device,
    serpDepth: input.serpDepth,
    keywords: [...new Set(input.keywords.map((x) => x.trim().toLowerCase()))].sort(),
    engines: [...new Set(input.engines)].sort(),
    sources: input.sources.map((s) => [s.id, s.status]).sort(([a], [b]) => a.localeCompare(b)),
    siteAudit: input.siteAudit,
    backlinkCap: input.backlinkCap,
    verifyCap: input.verifyCap,
    truncated: input.truncated ?? false,
  });
}
