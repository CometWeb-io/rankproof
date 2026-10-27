/** BYO credentials stay in adapter closures, outside manifests and datasets. */
import { connectorResult, type DataConnector } from "./connectors.ts";
import {
  fetchBingWebmaster,
  fetchSearchConsole,
  type GoogleCredentials,
} from "./search-console.server.ts";
import { runKeywordSerp } from "./serp.server.ts";
import type { SearchConsoleData, SerpDevice, SerpEngine, SerpMarket, SerpQuery } from "./types.ts";
import { parseTarget } from "./parse.ts";

export type SerpConnectorInput = {
  url: string;
  keywords: string[];
  engines?: SerpEngine[];
  market?: SerpMarket;
  device?: SerpDevice;
  depth?: 10 | 20;
};
export const serpConnector: DataConnector<SerpConnectorInput, SerpQuery> = {
  manifest: {
    schema_version: "1",
    id: "rankproof-serp",
    capabilities: ["serp.query"],
    credentials: "none",
  },
  async collect(input) {
    const result = await runKeywordSerp(input.url, input.keywords, input);
    if (!result.ok) return connectorResult("rankproof-serp", "error", [], result.error);
    const queries = result.snapshot.queries;
    // Keep per-query failure statuses; a successful wrapper is not zero rankings.
    return connectorResult(
      "rankproof-serp",
      queries.length ? "ok" : "error",
      queries,
      queries.length ? null : "No query observations were returned.",
    );
  },
};

export function ownerConnector(
  options:
    { source: "google"; credentials: GoogleCredentials } | { source: "bing"; apiKey: string },
): DataConnector<{ url: string }, SearchConsoleData> {
  const id = options.source === "google" ? "google-search-console" : "bing-webmaster";
  return {
    manifest: {
      schema_version: "1",
      id,
      capabilities: ["owner.performance"],
      credentials: "caller",
    },
    async collect(input) {
      parseTarget(input.url);
      const configured =
        options.source === "google"
          ? Boolean(
              options.credentials.accessToken ||
              (options.credentials.refreshToken &&
                options.credentials.clientId &&
                options.credentials.clientSecret),
            )
          : Boolean(options.apiKey.trim());
      // Never fall back to server credentials for an empty caller configuration.
      if (!configured)
        return connectorResult(id, "not-configured", [], "Caller credentials required.");
      try {
        const result =
          options.source === "google"
            ? await fetchSearchConsole(input.url, { credentials: options.credentials })
            : await fetchBingWebmaster(input.url, { apiKey: options.apiKey });
        if (!result || !result.connected)
          return connectorResult(id, "error", [], "Owner API collection failed.");
        return connectorResult(id, "ok", [result]);
      } catch {
        return connectorResult(id, "error", [], "Owner API collection failed.");
      }
    },
  };
}
