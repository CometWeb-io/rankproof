# SERP providers

RankProof ships four built-in HTML scrapers and an optional Google organic adapter.

| Engine | Mode | Default | Notes |
|---|---|---|---|
| Bing | scrape | on | Primary free SERP |
| DuckDuckGo | scrape | on | HTML endpoint |
| Mojeek | scrape | on | Independent index |
| Brave | scrape | off | Often challenged |
| Google organic | http-json | off | Needs self-hosted provider |
| Google (owned site) | Search Console API | opt-in | Not a SERP engine — see `search-console.md` |

## Google organic provider

Scraping Google from the RankProof process is intentionally unsupported (blocks, ToS, product honesty).

To measure competitor Google SERPs, run a self-hosted JSON provider (e.g. [OpenSERP](https://openserp.org/docs/)) and set:

```bash
export RANKPROOF_GOOGLE_PROVIDER_URL=http://127.0.0.1:7000
# legacy alias still accepted: OPENVIS_GOOGLE_PROVIDER_URL
```

Expected request:

`GET {base}/google/search?q=…&gl=pl&device=desktop`

Expected JSON (any of):

```json
{ "organic": [{ "link": "https://…", "title": "…", "snippet": "…" }] }
```

```json
{ "results": [{ "url": "https://…", "title": "…", "description": "…" }] }
```

Then:

```bash
rankproof scan example.com --engines=bing,google
rankproof doctor
```

Registry code: `src/lib/backlinks/serp-providers.ts`.
