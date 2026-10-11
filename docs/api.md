# HTTP API

A standalone JSON server, independent of the web application.

```bash
npm run api -- --port 8787 --host 127.0.0.1
```

**By default it listens on `127.0.0.1` only.** Owner-only Search Console and Bing Webmaster data are never included in web/API responses. Public binding requires `RANKPROOF_API_TOKEN`, and all endpoints except `GET /health` require `Authorization: Bearer <token>` when the token is configured. Put TLS and a reverse proxy in front of externally reachable instances. See [`SECURITY.md`](../SECURITY.md).

## Rate limits

20 requests per minute per socket client address by default, across every endpoint except `GET /health` (`RANKPROOF_RATE_LIMIT`, `RANKPROOF_RATE_WINDOW_MS`). Beyond that: `429`. The limiter has a bounded client table. `RANKPROOF_MAX_ACTIVE_SCANS=2` prevents concurrent expensive scans from exhausting machine resources; when full the API returns `503`. There is no paid queue service.

## Endpoints

### `GET /health`

```json
{ "ok": true, "service": "rankproof", "uptime": 42 }
```

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

Response: `{ "ok": true, "report": ScanReport }` or `{ "ok": false, "error": "…" }`.

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
| `401` | Missing or invalid bearer credential                                       |
| `405` | Wrong method (`/health` and `/doctor` accept GET; everything else is POST) |
| `415` | POST body is not JSON                                                      |
| `429` | Rate limit exceeded                                                        |
| `503` | Scan capacity exhausted or unavailable                                     |

### Cancellation on client disconnect

The standalone HTTP server forwards response-close cancellation to the domain scan's internal `Budget`, allowing cooperative sources and waiting host queues to stop when the client disconnects. This limits avoidable external traffic; not every third-party call or CPU-bound task is currently cancellable. Admission capacity remains a per-process control, not a distributed queue.

### DNS-pinned public HTTP API

When the standalone API binds beyond loopback, it requires a Bearer secret **and** enforces DNS-pinned outbound requests even when Node is not running in production mode. The explicit insecure override `RANKPROOF_PIN_DNS=0` causes startup to fail for public bindings. This does not replace egress firewalling or a TLS reverse proxy.

### Bounded request payloads

All JSON API inputs are validated before invoking scanner work. Scans accept an explicit URL up to 400 characters and enumerated market/device/engine values; SERP checks accept at most 10 keywords and depths 10 or 20; keyword ideas accept at most 5 seeds and 100 returned ideas; backlink-gap scans accept at most 5 competitors. Rejecting excessive input helps limit accidental or adversarial resource usage. HTTP disconnect signals propagate into the SERP, ideas and gap scan budgets as well as full scans, though some remote operations may remain non-cancellable.

### Local HTTP contract test

`npm run test:scaffold` exercises the standalone API using an ephemeral localhost port with no external scans. It checks unauthenticated health, Bearer authorization, malformed payload handling and method errors. The test uses no external services; it is not a replacement for a public-deployment penetration test or heavy-load measurement.
