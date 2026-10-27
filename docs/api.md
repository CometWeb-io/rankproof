# HTTP API

A standalone JSON server, independent of the web application.

```bash
npm run api -- --port 8787 --host 127.0.0.1
```

**By default it listens on `127.0.0.1` only.** These endpoints query other people's servers. Public binding requires a service token and pinned DNS; public scans always disable operator GSC/Bing credentials and use the bounded quick profile. Protect the crawling budget with authentication and rate limits. See [`SECURITY.md`](../SECURITY.md).

## Authentication

Set `RANKPROOF_API_TOKEN` to require `Authorization: Bearer <token>` on every endpoint except `GET /health`. Requests without it get `401`. Without the variable the API stays open, which is only reasonable on `127.0.0.1`.

## Rate limits

20 requests per minute per client address by default, across every endpoint except `GET /health` (`RANKPROOF_RATE_LIMIT`, `RANKPROOF_RATE_WINDOW_MS`). Beyond that: `429`.

## Endpoints

### `GET /health`

```json
{
  "ok": true,
  "service": "rankproof",
  "version": "8.1.0",
  "revision": "deployment-revision",
  "schema_version": "1",
  "capabilities": ["backlinks.verify.v1"],
  "uptime": 42
}
```

`revision` is the optional `RANKPROOF_SERVICE_REVISION` deployment identifier, or `null` when unset. Clients should check `schema_version` and `capabilities` before enabling a versioned integration; the package version alone does not identify an unpublished source snapshot. This liveness endpoint performs no crawler or provider calls.

### `POST /v1/backlinks/verify`

Fetches fresh source HTML for explicit source/target pairs, without search engines, browser rendering or paid APIs.

```json
{
  "items": [
    {
      "source_url": "https://publisher.example/article",
      "target_url": "https://target.example/offer?ref=partner"
    }
  ]
}
```

Accepts 1–50 pairs. Both URLs must be absolute public HTTP(S) URLs, at most 2048 characters, without credentials or whitespace. Source and target must belong to different registrable domains; internal pairs return an individual error before fetching, without affecting other valid items in the batch. Source redirects onto the target site also return an individual error. Invalid batches return `400` before any crawler I/O; oversized batches are rejected rather than truncated. Results retain input order and echo the exact validated input URL strings; canonical URL serialization is used only for fetching and comparison.

```json
{
  "ok": true,
  "schema_version": "1",
  "results": [
    {
      "source_url": "https://publisher.example/article",
      "target_url": "https://target.example/offer?ref=partner",
      "status": "confirmed",
      "checked_at": "2026-10-25T10:00:00.000Z",
      "final_url": "https://publisher.example/article",
      "http_status": 200,
      "anchor": "Offer",
      "rel": "nofollow sponsored",
      "reason": null
    }
  ]
}
```

- `confirmed`: a real HTML anchor has the exact requested target URL. Fragments are ignored; scheme, host, path, trailing slash and query remain significant. `www`, subdomains, tracking parameters and redirect-wrapper URLs are not collapsed. Relative anchors resolve against the final source URL and the document's first HTML `base` URL.
- `not_found`: a successfully read HTML document has no matching anchor, or the source returns `404`/`410`. This establishes absence in fetched HTML only. It does not establish absence from a JavaScript-rendered page or prove when a link disappeared.
- `error`: blocked URL/robots, DNS or network failure, timeout, HTTP failure other than `404`/`410`, challenge, non-HTML, empty, oversized, incomplete/unparseable or script-only page. Errors never establish link loss. `reason` explains the observation; `http_status` and `final_url` are `null` when no final response was obtained.

HTML measurement supports UTF-8 text, including its decoder aliases and BOM.
This admission policy is versioned as `html-anchor-v5`; earlier observations
retain their original extractor version and cannot establish a cross-version
relationship change. API schema `1` and its fields remain unchanged.
Malformed UTF-8, NUL-bearing text, and unsupported HTTP, HTML meta or XHTML XML
encoding declarations remain unavailable observations. The transport does not
guess legacy character encodings or replace malformed bytes before evaluating
links. A supported HTTP UTF-8 declaration takes precedence over HTML meta.
Percent-encoded URLs and Unicode URL identity remain unchanged. A readable
404/410 can establish `http_resource` absence independently of HTML admission;
an unreadable response remains an error.

`anchor` is bounded plain text (up to 160 characters). `rel` contains the anchor's actual tokens (up to 512 characters), with an empty string for no attribute; both fields are `null` unless confirmed. All result fields are present. `checked_at` is an ISO UTC observation timestamp. Item errors are returned inside an HTTP `200` batch response, so clients must inspect each status.

Schema `1` keeps the original status and evidence fields and adds `evidence_kind` (`html_anchor` only on confirmation), `observation_method` (`fetched_html`), `absence_scope` (`fetched_html`, `http_resource` for 404/410, otherwise null), `extraction_version`, `identity_policy`, `source_revision` (nullable), `response_hash` (SHA-256 of the inspected response text, nullable before fetch), `raw_href`, `resolved_href`, and up to 50 `matching_anchors` containing bounded raw/resolved href, anchor text and actual rel tokens. Raw href retains the original HTML attribute spelling, including entity escapes. Multiple occurrences can have different rel values. `resolved_href` on the first match retains its fragment while identity comparison ignores it. These describe the fetched representation, not browser visibility or Google treatment.

The source bypasses in-memory/disk response caches and requests HTTP revalidation. The existing robots policy and URL/DNS/redirect guards apply at every hop. Set `RANKPROOF_PIN_DNS=1` in service deployments to pin connections to the validated public address and close the DNS-rebinding window. A forward-only tokenizer reads actual tags outside quoted attribute values, comments, raw-text elements and nested templates; incomplete markup or more than 100,000 visible tokens returns an error rather than a partial absence claim. Verification reads at most 2 MB of source HTML, uses up to eight workers, and includes DNS/robots/queue time in each 10-second item deadline (75-second batch ceiling). A timed-out item is an error; it is not evidence of absence.

### `GET /doctor`

Probes every SERP engine (same logic as `rankproof doctor`). Returns HTTP 200 when at least one engine works, otherwise 503.

```json
{
  "ok": true,
  "diagnosis": {
    "healthy": true,
    "engines": [{ "engine": "bing", "status": "ok", "hits": 10 }],
    "environment": []
  }
}
```

Unconfigured Google organic shows `status: "not-configured"` (not a failure).

### `POST /scan`

```bash
curl -X POST http://127.0.0.1:8787/scan \
  -H 'content-type: application/json' \
  -d '{"url":"example.com","market":"us","device":"desktop"}'
```

| Field           | Type                          | Required |
| --------------- | ----------------------------- | -------- |
| `url`           | string                        | yes      |
| `market`        | `pl` `us` `gb` `de` `fr` `es` | no       |
| `device`        | `desktop` `mobile`            | no       |
| `engines`       | string[]                      | no       |
| `skipSiteAudit` | boolean                       | no       |
| `mode`          | `full` `light`                | no       |
| `budgetMs`      | number, 8000–300000           | no       |
| `depth`         | `10` `20`                     | no       |
| `seedUrls`      | string[] (max 150)            | no       |

`seedUrls` are pages your own webmaster tools (Bing Webmaster `GetUrlLinks`, Yandex Webmaster `links/external/samples`) say link to you. RankProof does not trust them: each is fetched and only a link found in its HTML becomes a backlink (`discoveredVia: "webmaster"`). Pages on the target itself and statically unsafe URLs are dropped. Supplied source paths and query parameters are preserved; only fragments are removed. Discovery candidates are not a substitute for a fresh exact-pair observation from `/v1/backlinks/verify`.

Response: `{ "ok": true, "report": ScanReport }` or `{ "ok": false, "error": "…" }`.

`providerReports` holds unconfirmed provider assertions and is excluded from live backlink statistics. `backlinks` contains fetched HTML confirmation (`evidence.kind: "html_anchor"`) or archive recovery candidates (`state: "lost"`, `evidence.kind: "archive_anchor"`). Each row exposes method, observation time, source revision, extraction/identity policy, requested/final source URL, original href, resolved href and response-text hash. `discoverySources` preserves overlapping candidate provenance.

`measurement` contains the `measurement-v1` run manifest, per-source candidate/verification funnel, observed versus displayed counts, graph signature, versioned heuristic scores and keyword/engine measurement coverage. See [metric methodology](metrics.md#evidence-identity-and-coverage) for denominators, comparability gates, archive-date semantics, disabled rendering and incomplete domain-suffix grouping. Existing `stats` remain displayed-report counts. `domainFirstArchivedAt` is domain context; `firstSeen` is null rather than a fabricated link acquisition date.

The full shape of `ScanReport` lives in `src/lib/backlinks/types.ts` — that file is the source of truth, not this document.

The most important fields:

```jsonc
{
  "target": { "host": "…", "domainRating": 0 },
  "scorecard": { "index": 0, "grade": "C", "parts": [] },
  "stats": { "backlinks": 0, "referringDomains": 0, "serpVisibility": 0 },
  "backlinks": [],
  "serp": { "queries": [], "competitors": [], "clusters": [], "moves": [] },
  "toxic": { "domains": [], "disavowCount": 0 },
  "plan": { "items": [], "quickWins": 0 },
  "brandSerp": null,
  "siteAudit": { "score": 0, "orphans": 0, "issues": [] },
  "searchConsole": null,
}
```

### `POST /serp`

```json
{ "url": "example.com", "keywords": ["packshot"], "depth": 20, "engines": ["bing", "brave"] }
```

### `POST /ideas`

```json
{ "keywords": ["product photography"], "limit": 60 }
```

### `POST /gap`

```json
{ "url": "example.com", "competitors": ["rival.com", "other.com"] }
```

It scans the competitors as well, so a response can take several minutes. Set a generous client-side timeout.

## Response codes

| Code  | Meaning                                                                    |
| ----- | -------------------------------------------------------------------------- |
| `200` | Success                                                                    |
| `400` | Invalid input, or the scan failed                                          |
| `401` | `RANKPROOF_API_TOKEN` is set and the bearer token is missing or wrong      |
| `405` | Wrong method (`/health` and `/doctor` accept GET; everything else is POST) |
| `429` | Rate limit exceeded                                                        |
