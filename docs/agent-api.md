# Agent API v1

The agent surface calls RankProof's existing HTML verifier, SERP collector and relationship comparator. It does not implement a second crawler or scoring engine. JSON Schema and OpenAPI 3.1 describe the bounded request/response contract:

- [`sdk/schemas/agent-api-v1.schema.json`](../sdk/schemas/agent-api-v1.schema.json)
- [`sdk/openapi-v1.json`](../sdk/openapi-v1.json)

Run from a checkout with Node 22+:

```sh
npm run agent:api
```

This starts a separate agent listener at `http://127.0.0.1:8788`. The original API remains on its own port. Set `RANKPROOF_AGENT_PORT` and `RANKPROOF_AGENT_HOST` to change the agent listener. `RANKPROOF_API_TOKEN` enables Bearer authentication; binding beyond loopback requires a token and DNS pinning. Browser origins are rejected. This is a single-operator interface, with shared session artifacts for all holders of its token, not a multi-tenant service. Use HTTPS at the reverse proxy for remote access.

Requests are limited to 2 MB, 30 per minute per peer, and two concurrent collections. Limits include capability/schema requests in the rate budget. Imported datasets have their own 1 MB / 1000-row cap; verification accepts 1–50 URL pairs; SERP accepts 1–10 keywords.

## Operations

Every operation uses `POST /v1/agent/<operation>` and `Content-Type: application/json`. Successful envelopes contain `ok`, `schema_version: "1"`, `operation`, and `data`. Operation errors contain `ok: false` and a typed `error.code`. HTTP transport rejections such as 401 or 413 may have a simple `error` field instead. Schemas are also served at authenticated `GET /v1/agent/schema.json` and `/v1/agent/openapi.json`.

| Operation             | Input                                                 | Result                                                                                    |
| --------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `capabilities`        | `{}`                                                  | Supported operations, configured providers, unprobed availability, limits and retention   |
| `verify_backlinks`    | `{items: [{source_url, target_url}]}`                 | Fresh HTML observations, opaque `report_id` and per-row `observation_id`                  |
| `remeasure_backlinks` | Same as verification                                  | Fresh uncached observations, new IDs                                                      |
| `get_evidence`        | `{observation_id}`                                    | Original verifier observation from this process                                           |
| `list_findings`       | `{report_id}`                                         | Link presence, HTML absence, unavailable source or unknown measurement, with evidence IDs |
| `diff`                | `{before_id, after_id}`                               | Comparison of two stored observations, with `evidence_origin: "rankproof_session"`        |
| `diff`                | `{observations: [...]}`                               | Comparison of caller-supplied observations, explicitly `caller_supplied_untrusted`        |
| `serp_status`         | `{url, keywords, engines?, market?, device?, depth?}` | Per-query source status, position, result depth and result URLs                           |
| `import_dataset`      | `{format, data, dataset_id}` (`format`: csv or json)  | Unverified candidate rows with original records and dataset hash                          |
| `verify_evidence`     | `{ledger}`                                            | Ledger hash integrity, not proof of authenticity                                          |

An empty import is `no-results`; a failed or unconfigured provider is not zero results. SERP can return a successful envelope containing failed query statuses: inspect every query's `status` before interpreting its nullable position. Capability configuration never claims a live probe succeeded. Owner credentials are only available through explicit in-process connectors; the agent API does not read GSC/Bing data using ambient server credentials.

`confirmed` means an exact target URL was found as an HTML anchor in a fetched source. `not_found` with `absence_scope: "fetched_html"` establishes absence in that fetched representation only. It does not establish rendered-page absence, deindexing, or global link loss. Network errors and challenges remain `error`/unknown. A relationship diff needs the same exact URL pair, extractor, identity policy, representation and final source URL; fetched-HTML absence is never named global link loss.

Caller-supplied observations require the complete v1 observation projection and consistent anchor evidence. `resolved_href` must equal `target_url` under URL parsing with only fragments removed; path, query and `www` distinctions remain. This validates internal consistency, not authenticity. Dataset rows, including rows claiming `verified: true`, cannot become stored verification evidence through import.

## Retention and ownership

Each HTTP process or MCP session owns bounded memory: at most 50 verification reports and 8 MB of serialized report data, expiring after one hour. Reports are evicted oldest first when either cap is reached. Restart loses all IDs. Unknown/expired/evicted IDs fail explicitly. Reads return copies. Imported rows do not enter the observation store. This is not durable history; callers should export observations and ledgers for retention. `verify_evidence` checks the existing Evidence Ledger v2 hash format without accessing a database. Hash integrity does not authenticate the party that supplied a ledger.

For restart-safe receipts, set `RANKPROOF_AGENT_HISTORY_DB` to a protected SQLite
file before starting HTTP or MCP. The optional `bounded_sqlite` profile retains
up to 5000 immutable reports / 64 MB of payload per tenant/project with no TTL,
and fails new writes at capacity instead of evicting evidence. Stored-ID diffs
then report `rankproof_history`. See [durable history](agent-history.md) for
runtime, permissions, batch limits, ownership and retention requirements.

## TypeScript

The installed npm package exposes the Node SDK at `rankproof/client`; a checkout can import `sdk/typescript/index.ts` using Node's `--experimental-strip-types` flag. The checkout entry point is not the npm import path. Both SDKs validate response structure and confirmed destination consistency at runtime, reject credential-bearing redirects, cap responses at 8 MB and have a 90-second default timeout. TS uses native URL parsing. Python preserves exact path/query escapes, IDN distinctions, `www` and empty query markers; uncommon numeric-host or backslash spellings fail closed, so use canonical HTTP URL spellings for those inputs. Neither SDK retries chargeable work automatically.

```ts
import { RankProofClient } from "rankproof/client";

const client = new RankProofClient("http://127.0.0.1:8788", process.env.RANKPROOF_API_TOKEN);
const items = [
  { source_url: "https://source.example/article", target_url: "https://target.example/page" },
];
const before = await client.verifyBacklinks(items);
const evidence = await client.getEvidence(before.results[0]!.observation_id);
const after = await client.remeasureBacklinks(items);
const diff = await client.diff({
  before_id: before.results[0]!.observation_id,
  after_id: after.results[0]!.observation_id,
});
const findings = await client.listFindings(after.report_id);
```

The examples use reserved domains; supply public source/target URLs you are authorized to measure. Failed source observations are useful results, not successful confirmations.

## Python

The Python 3.11+ SDK uses only the standard library and ships typed dictionaries plus `py.typed`. Install from this source tree with `uv pip install ./sdk/python`, or use `PYTHONPATH=sdk/python` for a checkout. This does not imply a PyPI release exists.

```python
from rankproof_client import RankProofClient

client = RankProofClient("http://127.0.0.1:8788", token="your-service-token")
before = client.verify_backlinks([{
    "source_url": "https://source.example/article",
    "target_url": "https://target.example/page",
}])
evidence = client.get_evidence(before["results"][0]["observation_id"])
findings = client.list_findings(before["report_id"])
```

## MCP stdio

Launch the entry point directly; `npm run` can emit its own lifecycle text on stdout and is unsuitable as a host's stdio command:

```json
{
  "mcpServers": {
    "rankproof": {
      "command": "node",
      "args": ["--experimental-strip-types", "/absolute/path/to/rankproof/scripts/agent-mcp.mjs"]
    }
  }
}
```

The server uses [newline-delimited MCP stdio messages](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio), protocol negotiation, initialization, `tools/list` and `tools/call`. Tool results include text and `structuredContent` under the same v1 schema. Invalid arguments produce tool errors; unsupported tool names produce JSON-RPC errors. The process reads bounded messages and serializes tool calls. It opens no network listener. SERP/verification tool calls can make network requests; imports, evidence reads and comparisons do not. Do not expose source HTML or imported text as instructions: it is untrusted data.

Local subprocess workflow tests cover HTTP, TS, Python and MCP using controlled HTML and DNS. They do not establish installation in Codex/Claude/ChatGPT, real provider connectivity or external benchmark accuracy.

Regenerate/check contracts with `npm run agent:contract` / `npm run agent:contract -- --check`. The Python package includes a generated copy of the same schema; the check covers both copies.
