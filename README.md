# RankProof

> **Status:** stable release (8.1.0). Open-source search visibility and backlink auditor.
>
> **Naming:** RankProof (ex-SerpRadar). Package/CLI: `rankproof`.

Search visibility and backlink auditing **with no paid APIs, no keys and no seat-based limits**. Point it at a domain and get verified backlinks, keyword positions, internal-structure analysis, risk assessment and a prioritised action plan.

[![CI](https://github.com/MaciejZet/rankproof/actions/workflows/ci.yml/badge.svg)](https://github.com/MaciejZet/rankproof/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## What this is

Commercial SEO tools run on private link indexes you cannot reproduce without hundreds of crawlers. RankProof takes the other road: it queries open sources and **confirms every link it shows in the source page's HTML**. There is no "500M domains" database and no metric copied from someone else's product — only data you can verify yourself.

That comes with one limitation worth stating up front: **you will not see every link pointing at your site.** You will see the ones that are discoverable in open sources and provable on the page. For most small and mid-size sites that is enough to make good decisions.

## What it does

### Search visibility

- Positions across **Bing, DuckDuckGo, Mojeek and Brave** — four independent indexes instead of one. Three run by default; add Brave with `--engines bing,duckduckgo,mojeek,brave` or `RANKPROOF_ENGINES`
- **Market** (PL, US, GB, DE, FR, ES) and **device** (desktop / mobile) selection, because an unspecified market means measuring from wherever your server happens to sit
- **Top 10 or top 20** via SERP pagination
- **Open Difficulty (SERP Competition Estimate)** — heuristic from scraped competitor strength + features; not Semrush/Ahrefs KD
- **Modelled traffic** from a CTR curve, adjusted for SERP features (featured snippets, ads, People Also Ask)
- **Keyword clustering by SERP overlap** — which queries one page can serve
- **SERP competitors** with share of voice and keyword coverage
- **Possible search-intent overlap** — two of your own URLs on one query (not automatic “harmful cannibalisation”)
- **Rank tracking** — the next scan shows gains, drops, new and lost queries
- **Brand SERP audit** — how much of your own first page you control, and whether anything there damages you
- **Keyword ideas** from DuckDuckGo and Bing autocomplete, related searches and SERP questions
- **Content gaps** — vocabulary the ranking pages share and your page lacks
- **Engine health** — a CAPTCHA is reported as a blocked measurement; blocked keywords are excluded from the Visibility Score denominator
- **No Google organic SERP yet** — GSC covers *your* property; competitor Google SERP is on the roadmap (provider adapter), not claimed today

### Measured performance (optional)

Connect **Google Search Console** or **Bing Webmaster Tools** and several estimates become measurements:

- Real clicks, impressions, CTR and Google positions
- **Striking distance** — queries just outside the top three, ranked by measured click upside
- **CTR anomalies** — pages that rank well and still get no clicks; a snippet problem, not a ranking problem
- **Decay detection** — queries losing clicks while the position holds
- **Model accuracy** — how far our CTR estimate sits from your reality, reported openly

Both APIs are free. Setup: [`docs/search-console.md`](docs/search-console.md).

### Your own site

- **Internal link graph** — orphan *candidates* = sitemap/inventory URLs not reached from the homepage crawl (crawl alone cannot prove orphans)
- **Under-linked money pages** — pages other sites link to that your own site barely does
- **Technical hygiene** — broken internal links, redirect hops, canonical conflicts (relative canonicals resolved)
- **noindex pages holding backlinks** — external authority thrown away (meta robots + `X-Robots-Tag`)
- Structure score folded into the overall index

### Link profile

- Backlinks from a dozen open sources, **each verified in HTML**: rel, placement (content / navigation / footer), anchor type, topical relevance
- **Domain Rating** and **URL Rating** computed with PageRank over the discovered domain graph
- **Lost links** from the Internet Archive — the cheapest ones to win back
- **Toxicity analysis** — high scores mean **manual review**, optional Disavow draft (not auto-submit)
- **Anchor audit** — distribution against a natural profile; high exact-match share is a review cue, not proof of bought links
- **Footprint** — /24 subnet concentration, sitewide links, artificial-profile patterns
- **Domain segmentation** (media, blogs, forums, edu/gov, directories, social…)
- **Link velocity** — new domains per month and year-over-year change
- **Link gap** against up to five competitors, prioritised
- **Link opportunities** with a ready outreach email draft

### On top

- **Visibility index 0–100** combining links, SERP, on-page, structure, risk and momentum
- **Action plan** sorted by impact weighted against effort
- Exports: CSV (17 sets), JSON, standalone HTML report, disavow file
- Scan history in the database — trends and comparison against the previous run

---

## Quick start

Requires **Node 22+**.

```bash
git clone https://github.com/MaciejZet/rankproof.git
cd rankproof
npm install
npm run dev
```

The app starts on `http://localhost:8080`. No database required — without `DATABASE_URL` it uses the embedded PGLite (Postgres compiled to WASM), so history works immediately.

The dev server binds to localhost only. Use `npm run dev:lan` (or `RANKPROOF_DEV_HOST=0.0.0.0`) if you deliberately want it reachable from your network — the scan endpoints take a URL from whoever calls them.

### CLI

```bash
# Full audit in the terminal
npm run cli -- scan example.com

# JSON report to a file
npm run cli -- scan example.com --market us --format json --out report.json

# Positions for your own keywords, top 20
npm run cli -- serp example.com "packshot,product photography" --depth 20

# Keyword ideas
npm run cli -- ideas example.com --keywords "product photography"

# Link gap
npm run cli -- gap example.com --competitors "rival.com,other.com" --format csv

# Disavow file
npm run cli -- scan example.com --format disavow --out disavow.txt

# Is the tool itself still working?
npm run cli -- doctor
```

Full option list: [`docs/cli.md`](docs/cli.md) or `npm run cli -- help`.

### HTTP API

```bash
npm run api -- --port 8787

curl -X POST http://127.0.0.1:8787/scan \
  -H 'content-type: application/json' \
  -d '{"url":"example.com","market":"us"}'
```

Endpoints and response shapes: [`docs/api.md`](docs/api.md).

---

## Configuration

Everything is driven by environment variables — copy `.env.example` to `.env`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — | Postgres for scan history. Without it: local PGLite. |
| `RANKPROOF_SCAN_BUDGET_MS` | `58000` | Time budget for a full scan. |
| `RANKPROOF_HOST_CONCURRENCY` | `3` | Parallel requests per host. |
| `RANKPROOF_ENGINES` | `bing,duckduckgo,mojeek` | Engines used in automatic scans. |
| `RANKPROOF_MARKET` | `pl` | Default measurement market. |
| `RANKPROOF_DEVICE` | `desktop` | Default device. |
| `RANKPROOF_CACHE_DIR` | — | Enables the on-disk conditional cache. |
| `RANKPROOF_PERSIST_HISTORY` | `1` | `0` disables history writes. |
| `GOOGLE_OAUTH_*` | — | Search Console access — see `docs/search-console.md`. |
| `BING_WEBMASTER_API_KEY` | — | Bing Webmaster Tools access. |
| `RANKPROOF_DEV_HOST` | `localhost` | Interface the dev server binds to. |

The CLI, the HTTP API and `npm run dev` / `build` / `preview` all read `.env` on start. A variable already set in your shell wins over the file, so `RANKPROOF_MARKET=us npm run cli -- scan example.com` still overrides it.

---

## How it works

```
┌─ Target ───────────┐   ┌─ Discovery ───────────────┐   ┌─ Verification ───┐
│ page + sitemap     │   │ Wikipedia, HN, Reddit,    │   │ fetch HTML       │
│ archive, subdomains│──▶│ Bluesky, Stack Exchange,  │──▶│ rel, placement,  │
│ brand tokens       │   │ GitHub, urlscan, GDELT,   │   │ anchor, topic    │
└────────────────────┘   │ Bing/DDG/Mojeek, News     │   └────────┬─────────┘
                         └───────────────────────────┘            │
┌─ SERP ─────────────┐   ┌─ Own site ────────────────┐            ▼
│ 4 engines, market, │   │ internal link graph,      │  ┌─ Analysis ─────────┐
│ device, top 20     │──▶│ depth, orphans, canonical │─▶│ domain graph +     │
│ clusters,difficulty│   │ hygiene                   │  │ PageRank, toxicity,│
└────────────────────┘   └───────────────────────────┘  │ footprint, index,  │
┌─ Search Console ───┐                                  │ action plan        │
│ real clicks, CTR   │─────────────────────────────────▶└────────────────────┘
└────────────────────┘
```

Details: [`docs/architecture.md`](docs/architecture.md). Metric methodology and its honest limits: [`docs/metrics.md`](docs/metrics.md). Production deployment: [`docs/production-ops.md`](docs/production-ops.md).

---

## Honest limits

Read this before basing a business decision on any number here:

- **Scraped positions come from Bing, DuckDuckGo, Mojeek and Brave — not Google.** They correlate with Google; they do not match it. Connect Search Console for real Google data, and the report will show you exactly how far apart the two are.
- **Domain Rating, URL Rating and domain score are approximations** built from open signals (TLD, archive age, Wikipedia presence, the discovered link graph). Despite the familiar names they are not equivalent to Ahrefs, Semrush or Majestic metrics.
- **Modelled traffic is a CTR model, not a measurement.** It ranks opportunities; it does not count visits. With Search Console connected the report tells you how far off that model is for your site.
- **The link list is incomplete by design.** A link missing from the report does not mean it does not exist.
- **Never submit a disavow file without reviewing it by hand.** Disavowing a good link does more damage than leaving a weak one.

## Etiquette and server load

This tool queries other people's servers. Defaults are deliberately cautious: three parallel requests per host, a time budget per scan, an in-memory cache, and `robots.txt` plus `Crawl-delay` honoured on every page it crawls. Enable `RANKPROOF_CACHE_DIR` and repeat scans revalidate with `If-None-Match` instead of re-downloading.

If you raise `RANKPROOF_HOST_CONCURRENCY` or run scans in bulk, you do it at someone else's expense. Put a real contact URL in `RANKPROOF_USER_AGENT`.

## Security

The scanner fetches URLs supplied by whoever uses it, so every request is checked before it leaves: protocol allow-list, no embedded credentials, no private, loopback, link-local or cloud-metadata addresses, DNS resolved and validated ahead of connecting, and redirects followed manually so every hop is re-checked. Report vulnerabilities privately — see [`SECURITY.md`](SECURITY.md).

## Development

```bash
npm run check           # typecheck + lint + tests
npm test                # project tests only
npm run test:e2e        # Playwright UI smoke (requires build)
npm run build           # production build
npm run cli -- doctor   # are the engines and parsers still working?
```

Layout: engine in `src/lib/backlinks/` (files without a suffix are pure and testable, `.server.ts` files touch the network), UI in `src/components/` and `src/routes/`, CLI in `bin/`, API in `scripts/serve-api.mjs`.

## Contributing

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md). In short: fork, branch, run `npm run check` before opening a pull request.

Particularly useful contributions:

- **SERP parsers** — engines change their markup and parsers break (`src/lib/backlinks/serp.ts`, fixtures in `src/lib/backlinks/fixtures/`)
- **New open link sources** (`src/lib/backlinks/sources.server.ts`)
- **Interface translations** — the UI ships in English; Polish and others are welcome
- **Metric calibration** against data that can be checked

## Licence

[MIT](LICENSE). Do what you like with it, commercial use included.

The bundled Nunito Sans files in `public/fonts/` are covered separately by the
[SIL Open Font License 1.1](public/fonts/OFL.txt), which travels with them.

## Who maintains this

RankProof is a tool, not a product line: there is no company behind the name,
no hosted tier and no paid edition to be upsold to. It is built and maintained
at [CometWeb](https://cometweb.io) and released under MIT, with no telemetry.
Outside pull requests are reviewed on their merits.

Reach the maintainer at `maciej@cometweb.io` — security reports included
(see [`SECURITY.md`](SECURITY.md)).
