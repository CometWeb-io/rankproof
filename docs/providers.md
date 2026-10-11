# SERP providers

RankProof ships four built-in HTML scrapers and an optional Google organic adapter.

| Engine              | Mode               | Default | Notes                                       |
| ------------------- | ------------------ | ------- | ------------------------------------------- |
| Bing                | scrape             | on      | Primary free SERP                           |
| DuckDuckGo          | scrape             | on      | HTML endpoint                               |
| Mojeek              | scrape             | on      | Independent index                           |
| Brave               | scrape             | off     | Often challenged                            |
| Google organic      | http-json          | off     | Needs self-hosted provider                  |
| Google (owned site) | Search Console API | opt-in  | Not a SERP engine — see `search-console.md` |

## Google organic provider

Scraping Google from the RankProof process is intentionally unsupported (blocks, ToS, product honesty).

To measure competitor Google SERPs, run a self-hosted JSON provider (e.g. [OpenSERP](https://openserp.org/docs/)) and set:

```bash
export RANKPROOF_GOOGLE_PROVIDER_URL=http://127.0.0.1:7000
export RANKPROOF_GOOGLE_ALLOW_LOOPBACK=1 # explicit local provider trust
# legacy alias still accepted: OPENVIS_GOOGLE_PROVIDER_URL
```

Expected request:

`GET {base}/google/search?text=…&region=pl&lang=pl&limit=10`

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

### Security and accuracy

Loopback access is opt-in **only** for the administrator-selected Google provider. The scanner's user-controlled URL/redirect guard still blocks local addresses. External providers must resolve exclusively to public addresses. OpenSERP v2 responses can contain ads; the adapter includes organic results only and preserves `position.absolute`. Provider results are not guaranteed to reproduce localized mobile rankings: OpenSERP v2 does not define a `device` query parameter in its documented request contract. Treat the device as unspecified until a provider explicitly supports it.
