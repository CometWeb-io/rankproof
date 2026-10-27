# Provider and dataset connector SDK v1

`src/lib/backlinks/connectors.ts` defines the versioned `DataConnector<Input, Record>` interface, capability manifest and collection envelope. `connectors.server.ts` reuses RankProof's SERP collector and existing Google Search Console/Bing Webmaster adapters. No connector can turn a supplier claim into an independently verified link.

```ts
import { collectConnector, datasetConnector } from "../src/lib/backlinks/connectors.ts";

const result = await collectConnector(datasetConnector, "backlinks.discover", {
  format: "json",
  dataset_id: "supplier-export-2026-10-27",
  data: JSON.stringify([
    {
      source_url: "https://source.example/article",
      target_url: "https://target.example/page",
      supplier_note: "reported by owner export",
    },
  ]),
});
```

The capability manifest contains `schema_version: "1"`, a stable connector ID, `capabilities` (`backlinks.discover`, `serp.query`, `owner.performance`) and credential ownership (`none` or `caller`). `collectConnector` validates the manifest, requested capability and returned envelope. Implementations must validate their record types at their trust boundaries; this generic wrapper cannot infer a third-party record schema. Exceptions remain failures, never empty successes.

| Status           | Meaning                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `ok`             | At least one collection record; inspect its own status if it represents attempts, such as a SERP query |
| `no-results`     | Successful collection with zero records                                                                |
| `not-configured` | Required caller credentials/configuration absent                                                       |
| `blocked`        | Supplier denied access                                                                                 |
| `rate-limited`   | Supplier throttled access                                                                              |
| `error`          | Collection failed; no zero-result inference                                                            |

A result includes `connector_id`, `schema_version`, `observed_at`, `reason` and `records`. Failure/empty statuses cannot carry records. SERP records preserve every per-query source status. Owner performance returns a connected property record even when its measured query list is empty; failures return a generic reason to avoid exposing credentials from upstream errors.

## BYO CSV/JSON

JSON is an array of objects. CSV must have unique, nonempty headers, including exact `source_url` and `target_url` columns. RFC 4180 quotes, commas, escaped quotes and embedded newlines are supported. UTF-8 BOM and CRLF are accepted. Other columns, nested JSON data, duplicate source rows, original URL strings and row order are retained. Invalid rows fail the whole import; there is no silent partial ingestion.

Imports accept at most 1 MB and 1000 rows. Source/target must be absolute public HTTP(S) URLs; validation performs no DNS/network requests. A later fetch still passes the engine's DNS/redirect/robots guards. Every candidate includes `verification_status: "unverified"` plus dataset ID, SHA-256 of the exact input text including any BOM, format, import timestamp, one-based record number and `original_record`. A CSV record number counts logical records, including quoted newlines, not physical lines.

Provenance is retained in the import response, including any supplier's own provenance fields inside `original_record`. No deduplication merges it away. Send source/target pairs to `verify_backlinks` for independent observations, and retain the import response alongside those observations to preserve the supplier chain. The existing scan `seedUrls` path only accepts URLs and cannot retain this richer provenance; do not treat it as the dataset storage format.

## BYO owner credentials

```ts
import { ownerConnector } from "../src/lib/backlinks/connectors.server.ts";

const google = ownerConnector({ source: "google", credentials: { accessToken: yourToken } });
const bing = ownerConnector({ source: "bing", apiKey: yourKey });
const performance = await google.collect({ url: "your-owned-site.example" });
```

The adapter captures caller credentials privately and passes them explicitly to existing collection functions. Empty credentials return `not-configured`, even if the server environment contains another operator's credentials. Manifests never include credentials. These adapters are in-process APIs for trusted code; public agent requests cannot supply a property and consume ambient webmaster credentials. Property authorization and credential rotation remain the caller's responsibility.

## Contract verification

`connectors.test.ts` exercises CSV/JSON provenance, duplicate preservation, malformed/oversized data, forbidden URLs, capability mismatch, source status and absence of fallback to server owner credentials. `agent-workflow.test.ts` exercises import → actual verifier → evidence receipts and rechecks over local HTTP and MCP processes with controlled source responses. These are contract/integration checks; GSC/Bing property connectivity and supplier availability require separate authorized live qualification.
