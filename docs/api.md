# HTTP API

A standalone JSON server, independent of the web application.

```bash
npm run api -- --port 8787 --host 127.0.0.1
```

**By default it listens on `127.0.0.1` only.** These endpoints query other people's servers, and — if you have connected Search Console — they expose your own performance data. Exposing them publicly without a reverse proxy and authentication means anyone can use your machine as a proxy and read your analytics. See [`SECURITY.md`](../SECURITY.md).

## Rate limits

20 requests per minute per client address by default, across every endpoint except `GET /health` (`RANKPROOF_RATE_LIMIT`, `RANKPROOF_RATE_WINDOW_MS`). Beyond that: `429`.

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

| Field | Type | Required |
| --- | --- | --- |
| `url` | string | yes |
| `market` | `pl` `us` `gb` `de` `fr` `es` | no |
| `device` | `desktop` `mobile` | no |
| `engines` | string[] | no |
| `skipSiteAudit` | boolean | no |

Response: `{ "ok": true, "report": ScanReport }` or `{ "ok": false, "error": "…" }`.

The full shape of `ScanReport` lives in `src/lib/backlinks/types.ts` — that file is the source of truth, not this document.

The most important fields:

```jsonc
{
  "target":     { "host": "…", "domainRating": 0 },
  "scorecard":  { "index": 0, "grade": "C", "parts": [] },
  "stats":      { "backlinks": 0, "referringDomains": 0, "serpVisibility": 0 },
  "backlinks":  [],
  "serp":       { "queries": [], "competitors": [], "clusters": [], "moves": [] },
  "toxic":      { "domains": [], "disavowCount": 0 },
  "plan":       { "items": [], "quickWins": 0 },
  "brandSerp":  null,
  "siteAudit":  { "score": 0, "orphans": 0, "issues": [] },
  "searchConsole": null
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

| Code | Meaning |
| --- | --- |
| `200` | Success |
| `400` | Invalid input, or the scan failed |
| `405` | Wrong method (`/health` and `/doctor` accept GET; everything else is POST) |
| `429` | Rate limit exceeded |
