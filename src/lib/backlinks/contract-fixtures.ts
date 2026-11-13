/**
 * Golden API documents for consumers (services, SDKs, other tools). Built from
 * the bundled example through the real extractor, so they are deterministic
 * and offline. `npm run contract:update` rewrites contract/fixtures; the test
 * suite fails whenever the produced shape drifts from the committed files.
 */
import { BACKLINKS_SCHEMA_VERSION } from "./verify-api.server.ts";
import { EXAMPLE_TABLE, exampleRuns } from "./verify-example.server.ts";
import { parsePairTable } from "./observe.ts";

export function contractFixtures(): Record<string, unknown> {
  const { results, previous } = exampleRuns();
  const request = {
    items: parsePairTable(EXAMPLE_TABLE).rows.map(({ line: _line, ...item }) => item),
  };
  const normalize = <T extends { source_revision: string | null }>(item: T) => ({
    ...item,
    source_revision: null,
  });
  return {
    "verify-request.json": request,
    "verify-response.json": {
      ok: true,
      schema_version: BACKLINKS_SCHEMA_VERSION,
      results: results.map(normalize),
    },
    "verify-response-previous.json": {
      ok: true,
      schema_version: BACKLINKS_SCHEMA_VERSION,
      results: previous.map(normalize),
    },
    "health.json": {
      ok: true,
      service: "rankproof",
      version: "x.y.z",
      revision: null,
      schema_version: BACKLINKS_SCHEMA_VERSION,
      capabilities: ["backlinks.verify.v1", "backlinks.verify.contract.v1"],
      uptime: 1,
    },
  };
}
