import { fetchText } from "./net.server.ts";
import { parseTarget } from "./parse.ts";
import type { SearchConsoleData, SearchConsoleRow, SearchConsoleSource } from "./types.ts";

/**
 * Real data from the search engines themselves.
 *
 * Everything else in this project estimates. Google Search Console and Bing
 * Webmaster Tools do not: they report actual impressions, clicks, CTR and
 * average position for a property you own. That turns several estimates into
 * measurements, and enables checks that are impossible from the outside —
 * pages that lose clicks at a stable position, queries with impressions but
 * no clicks, and cannibalisation confirmed rather than inferred.
 *
 * Both APIs are free. Neither is reachable without the site owner's own
 * credentials, which is exactly right: this reads private performance data.
 *
 * Setup: docs/search-console.md
 */

const GSC_API = "https://searchconsole.googleapis.com/webmasters/v3";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const BING_API = "https://ssl.bing.com/webmaster/api.svc/json";

export type GoogleCredentials = {
  /** Short-lived token; skips the refresh round-trip when supplied. */
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
};

export function googleCredentialsFromEnv(): GoogleCredentials | null {
  const accessToken = process.env?.GOOGLE_OAUTH_ACCESS_TOKEN;
  const refreshToken = process.env?.GOOGLE_OAUTH_REFRESH_TOKEN;
  const clientId = process.env?.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env?.GOOGLE_OAUTH_CLIENT_SECRET;
  if (accessToken) return { accessToken };
  if (refreshToken && clientId && clientSecret) return { refreshToken, clientId, clientSecret };
  return null;
}

export function bingApiKeyFromEnv(): string | null {
  const key = process.env?.BING_WEBMASTER_API_KEY;
  return key && key.trim() ? key.trim() : null;
}

/** Exchanges a refresh token for an access token. */
async function googleAccessToken(credentials: GoogleCredentials): Promise<string> {
  if (credentials.accessToken) return credentials.accessToken;
  if (!credentials.refreshToken || !credentials.clientId || !credentials.clientSecret) {
    throw new Error("Missing Google OAuth credentials.");
  }
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: "refresh_token",
  }).toString();

  const response = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`Google token refresh failed (HTTP ${response.status}).`);
  }
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Google returned no access token.");
  return data.access_token;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Property strings Search Console accepts, most specific first. */
export function propertyCandidates(host: string): string[] {
  const bare = host.replace(/^www\./, "");
  return [
    `sc-domain:${bare}`,
    `https://${host}/`,
    `https://www.${bare}/`,
    `http://${host}/`,
  ];
}

type GscRow = {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
};

async function gscQuery(
  property: string,
  token: string,
  body: Record<string, unknown>,
): Promise<GscRow[]> {
  const url = `${GSC_API}/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (response.status === 403 || response.status === 404) {
    throw new Error(`No access to property ${property}.`);
  }
  if (!response.ok) throw new Error(`Search Console returned HTTP ${response.status}.`);
  const data = (await response.json()) as { rows?: GscRow[] };
  return data.rows ?? [];
}

function toRows(rows: GscRow[], keyCount = 1): SearchConsoleRow[] {
  return rows.map((row) => ({
    keys: (row.keys ?? []).slice(0, keyCount),
    clicks: Math.round(row.clicks ?? 0),
    impressions: Math.round(row.impressions ?? 0),
    ctr: Math.round((row.ctr ?? 0) * 1000) / 10,
    position: Math.round((row.position ?? 0) * 10) / 10,
  }));
}

/**
 * Pulls query, page and query×page performance for the last N days, plus the
 * previous equal-length window so we can show real movement rather than a
 * scraped snapshot.
 */
export async function fetchSearchConsole(
  rawHost: string,
  options: {
    credentials?: GoogleCredentials | null;
    days?: number;
    property?: string;
    rowLimit?: number;
  } = {},
): Promise<SearchConsoleData | null> {
  const credentials = options.credentials ?? googleCredentialsFromEnv();
  if (!credentials) return null;

  let host: string;
  try {
    host = parseTarget(rawHost).host;
  } catch {
    return null;
  }

  const days = Math.max(7, Math.min(180, options.days ?? 28));
  const rowLimit = Math.max(10, Math.min(1000, options.rowLimit ?? 250));
  const token = await googleAccessToken(credentials);

  // Search Console lags roughly two days; asking for today returns nothing.
  const endDate = isoDaysAgo(2);
  const startDate = isoDaysAgo(2 + days);
  const previousEnd = isoDaysAgo(3 + days);
  const previousStart = isoDaysAgo(3 + days * 2);

  const properties = options.property ? [options.property] : propertyCandidates(host);
  let property: string | null = null;
  let queries: GscRow[] = [];
  let lastError = "";

  for (const candidate of properties) {
    try {
      queries = await gscQuery(candidate, token, {
        startDate,
        endDate,
        dimensions: ["query"],
        rowLimit,
      });
      property = candidate;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!property) {
    return {
      source: "google",
      connected: false,
      property: null,
      error: lastError || "No accessible Search Console property found for this domain.",
      days,
      queries: [],
      pages: [],
      previousQueries: [],
      totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
    };
  }

  const [pages, previous] = await Promise.all([
    gscQuery(property, token, {
      startDate,
      endDate,
      dimensions: ["page"],
      rowLimit,
    }).catch(() => [] as GscRow[]),
    gscQuery(property, token, {
      startDate: previousStart,
      endDate: previousEnd,
      dimensions: ["query"],
      rowLimit,
    }).catch(() => [] as GscRow[]),
  ]);

  const clicks = queries.reduce((sum, row) => sum + (row.clicks ?? 0), 0);
  const impressions = queries.reduce((sum, row) => sum + (row.impressions ?? 0), 0);
  const weightedPosition =
    impressions > 0
      ? queries.reduce((sum, row) => sum + (row.position ?? 0) * (row.impressions ?? 0), 0) /
        impressions
      : 0;

  return {
    source: "google",
    connected: true,
    property,
    error: null,
    days,
    queries: toRows(queries),
    pages: toRows(pages),
    previousQueries: toRows(previous),
    totals: {
      clicks: Math.round(clicks),
      impressions: Math.round(impressions),
      ctr: impressions > 0 ? Math.round((clicks / impressions) * 1000) / 10 : 0,
      position: Math.round(weightedPosition * 10) / 10,
    },
  };
}

type BingRow = {
  Query?: string;
  Clicks?: number;
  Impressions?: number;
  AvgClickPosition?: number;
  AvgImpressionPosition?: number;
};

/**
 * Bing Webmaster Tools. Simpler than Search Console — a single API key, no
 * OAuth dance — and a useful cross-check, since our own SERP measurements
 * lean on Bing's index.
 */
export async function fetchBingWebmaster(
  rawHost: string,
  options: { apiKey?: string | null } = {},
): Promise<SearchConsoleData | null> {
  const apiKey = options.apiKey ?? bingApiKeyFromEnv();
  if (!apiKey) return null;

  let host: string;
  try {
    host = parseTarget(rawHost).host;
  } catch {
    return null;
  }

  const site = `https://${host}`;
  const url = `${BING_API}/GetQueryStats?apikey=${encodeURIComponent(apiKey)}&siteUrl=${encodeURIComponent(site)}`;

  try {
    const { status, text } = await fetchText(url, {
      timeoutMs: 12_000,
      maxBytes: 900_000,
      accept: "application/json",
      skipRobots: true,
      cache: false,
    });
    if (status >= 400) throw new Error(`HTTP ${status}`);
    const data = JSON.parse(text) as { d?: BingRow[] };
    const rows = data.d ?? [];
    const queries: SearchConsoleRow[] = rows.map((row) => ({
      keys: [row.Query ?? ""],
      clicks: Math.round(row.Clicks ?? 0),
      impressions: Math.round(row.Impressions ?? 0),
      ctr:
        row.Impressions && row.Impressions > 0
          ? Math.round(((row.Clicks ?? 0) / row.Impressions) * 1000) / 10
          : 0,
      position: Math.round((row.AvgImpressionPosition ?? row.AvgClickPosition ?? 0) * 10) / 10,
    }));

    const clicks = queries.reduce((sum, row) => sum + row.clicks, 0);
    const impressions = queries.reduce((sum, row) => sum + row.impressions, 0);
    return {
      source: "bing",
      connected: true,
      property: site,
      error: null,
      days: 30,
      queries,
      pages: [],
      previousQueries: [],
      totals: {
        clicks,
        impressions,
        ctr: impressions > 0 ? Math.round((clicks / impressions) * 1000) / 10 : 0,
        position:
          impressions > 0
            ? Math.round(
                (queries.reduce((sum, row) => sum + row.position * row.impressions, 0) /
                  impressions) *
                  10,
              ) / 10
            : 0,
      },
    };
  } catch (error) {
    return {
      source: "bing",
      connected: false,
      property: site,
      error: error instanceof Error ? error.message : "Bing Webmaster request failed.",
      days: 30,
      queries: [],
      pages: [],
      previousQueries: [],
      totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
    };
  }
}

/** Fetches whichever providers are configured; returns an empty list if none. */
export async function fetchSearchConsoleData(host: string): Promise<SearchConsoleData[]> {
  const jobs: Promise<SearchConsoleData | null>[] = [];
  if (googleCredentialsFromEnv()) jobs.push(fetchSearchConsole(host).catch(() => null));
  if (bingApiKeyFromEnv()) jobs.push(fetchBingWebmaster(host).catch(() => null));
  if (jobs.length === 0) return [];
  const settled = await Promise.all(jobs);
  return settled.filter((item): item is SearchConsoleData => item !== null);
}

export type { SearchConsoleSource };
