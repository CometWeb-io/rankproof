# Architecture

## The dividing rule

The whole engine lives in `src/lib/backlinks/`. One rule keeps the project honest:

- **Files without a suffix** (`score.ts`, `serp-intel.ts`, `plan.ts`, `toxic.ts`, `ssrf.ts`…) are **pure**: they touch neither the network, nor the database, nor `process`. They can be tested directly, without mocks.
- **Files with a `.server.ts` suffix** (`engine.server.ts`, `sources.server.ts`, `net.server.ts`…) perform I/O. They never reach the client bundle.

That is why the whole unit suite runs without network or database and still covers the decision logic; `npm test` reports the current count.

## Scan flow

`engine.server.ts` → `runScan()` runs seven phases under a shared time budget (`Budget` in `net.server.ts`). When time runs short, later phases **shrink rather than break the report** — an incomplete result beats an error.

1. **Target** — `target.server.ts`: page, sitemap, subdomains, archive, brand tokens, on-page audit.
2. **Discovery** — `sources.server.ts`: Wikipedia, Hacker News, Reddit, Bluesky, Stack Exchange, GitHub, urlscan.io, GDELT, Google News, Bing/DDG/Mojeek. Every source returns candidates, not finished links.
3. **Verification** — `verify.server.ts` in three waves: fetches the candidate's HTML and confirms the link. Determines `rel`, placement (`html.ts` → `buildRegions`), anchor type and topical relevance (`topic.ts`).
4. **Archive** — `findLostLinks()`: pages that used to link and stopped.
5. **Scoring** — `score.ts`: domain score, spam risk, aggregates; `graph.ts`: PageRank over the discovered graph; `dns.server.ts`: IP addresses and subnets.
6. **Analysis** — `serp-intel.ts`, `serp-cluster.ts`, `toxic.ts`, `segments.ts`, `scorecard.ts`, `plan.ts`.
7. **Own site and measured data** — `site-audit.server.ts` crawls the target's internal link graph; `search-console.server.ts` pulls real performance data when an account is connected.

## SERP

`serp.ts` contains **parsers only** (Bing, DuckDuckGo, Mojeek, Brave, related searches, questions, SERP features, block detection) — pure functions over an HTML string, fully testable and covered by golden tests against frozen fixtures in `fixtures/`.

`serp.server.ts` handles fetching: URLs with market parameters (`market.ts`), pagination to the top 20, page merging and snapshot construction.

When an engine changes its HTML, one parser breaks rather than the whole scan — the other engines carry on, and `detectSerpBlock()` makes sure the failure is reported as a failed measurement instead of a zero.

## Own-site audit

`site-audit.server.ts` performs a breadth-first crawl from the home page (breadth-first matters: it yields true click depth). It builds the internal link graph, then reports orphans, depth, broken links, redirect hops, canonical conflicts and — by joining against discovered backlinks — pages that earn external authority while receiving almost no internal links.

## Search Console

`search-console.server.ts` handles OAuth and the two APIs; `search-console-insights.ts` is pure and holds all the analysis (striking distance, CTR anomalies, decay, model accuracy). The split means every insight is unit-testable without credentials.

## Entry layers

The same engine serves three interfaces:

| Entry point | File                                                  | Use                        |
| ----------- | ----------------------------------------------------- | -------------------------- |
| Web app     | `src/routes/index.tsx` + `scan.ts` (server functions) | interactive audit          |
| CLI         | `bin/rankproof.mjs` + `cli.ts` (argument parser)      | automation, CI, cron       |
| HTTP API    | `scripts/serve-api.mjs`                               | integrations, self-hosting |

The CLI argument parser is a separate, pure module — tested without running a scan.

## Persistence

History is **optional**. Without `DATABASE_URL` an embedded PGLite (Postgres in WASM) starts up, and a database failure never breaks a report — `store.server.ts` catches the exception and returns the result without history.

Two tables: `scan_history` (aggregates for trends and diffs) and `serp_rank_history` (positions per keyword and engine, for gains and drops). Both hold public data only — the app works without login.

## Self-diagnosis

`doctor.server.ts` probes every engine with a known query and reports, per engine, whether results came back, a bot challenge appeared, or the markup moved. Because a broken parser otherwise produces confident zeros, it exits non-zero when nothing works — usable as a CI canary.

Golden tests in `backlinks.test.ts` run the same parsers against frozen fixtures in `fixtures/`, so a markup change breaks a test rather than production numbers.

## Network

`net.server.ts` is the only place HTTP requests leave from. It provides:

- **SSRF protection** — protocol allow-list, no credentials in URLs, DNS resolved and checked before connecting, redirects followed manually so every hop is re-validated (`ssrf.ts`),
- **robots.txt and Crawl-delay** enforcement on crawled pages (`robots.server.ts`); SERP and API lookups are deliberately exempt,
- a per-host concurrency limit (3 by default) with a queue,
- an in-memory cache keyed on URL, method, language and user-agent,
- an optional **disk cache with conditional revalidation** (`disk-cache.server.ts`) — repeat scans send `If-None-Match` and take a 304 instead of a body,
- hard limits on response size and time,
- `Budget` — a shared clock with an `AbortSignal` for the whole scan.

Want to change network behaviour? It is one file plus `config.ts`.

## Production network hardening

The crawler pins outbound TCP connections to validated public DNS answers by default in `NODE_ENV=production`. Use `RANKPROOF_PIN_DNS=1` to enable the same transport in development. `RANKPROOF_PIN_DNS=0` is an unsafe troubleshooting override and must not be used on publicly reachable deployments. Responses in the pinned transport have a hard byte limit and handle 204/205/304 without a body. Crawl rules are checked for each redirect destination. RAM cache expires after 60 seconds; the optional disk cache uses conditional revalidation. HTTP downgrade is disabled unless `RANKPROOF_ALLOW_HTTP_FALLBACK=1` is explicitly set.

## Registrable domains and multi-tenant providers

RankProof embeds a pinned snapshot of the Mozilla Public Suffix List (ICANN plus PRIVATE sections; MPL-2.0) so `a.github.io` and `b.github.io` are not falsely counted as the same referring domain. `src/lib/backlinks/public-suffix.ts` implements longest-match, wildcard and exception rules; Unicode suffixes are normalized using the WHATWG URL implementation. Snapshot reference: publicsuffix/list commit `3929462652695bad04f0a27afb600974014a3c8b` (2026-10-07). To refresh manually, run `npm run psl:update` and review the generated diff. This adds no runtime package or paid provider.
