# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); semantic versioning.

## [Unreleased] — open-source readiness

Pre-publication pass: a security fix, the last of the Polish surface, engine
truthfulness, and the packaging a stranger's first clone runs into.

### Security

- **SSRF bypass via IPv4-mapped IPv6 (`ssrf.ts`).** `new URL()` rewrites
  `http://[::ffff:127.0.0.1]/` to `[::ffff:7f00:1]`, and the guard only matched
  the dotted-quad form — so the hex form passed and reached loopback on an
  allowed port. Confirmed end to end against a local service before the fix.
  The classifier now expands the address and applies the IPv4 rules to every
  embedded form: IPv4-mapped, IPv4-compatible, IPv4-translated (RFC 2765),
  NAT64 and 6to4, plus `ff00::/8`, `100::/64`, `2001:db8::/32` and `2001::/23`.
  Regression tests cover the URL-normalised spelling, which is the one that
  actually arrives.
- `GET /doctor` is rate-limited like the POST endpoints; it runs five sequential
  engine probes and previously skipped the limiter entirely. `GET /health` stays
  free as a liveness probe.
- `resolveGateEndpoints` no longer derives a trusted OIDC issuer from
  `x-forwarded-host`, a header the caller controls, and no longer hardcodes a
  private staging domain. The issuer comes from `RANKPROOF_GATE_ORIGIN` or gate
  identity stays off.
- Removed `src/lib/app-data/` — generator scaffolding no part of the product
  imported. It hardcoded a private staging host as trusted for connector tokens,
  keyed off an attacker-influenced `x-forwarded-host`.
- `npm run dev` binds localhost instead of `0.0.0.0`. `npm run dev:lan` (or
  `RANKPROOF_DEV_HOST`) opts back in.

### Fixed

- **`.env` was never read.** README and `.env.example` both told people to create
  one; nothing loaded it, so every variable was silently ignored. The CLI, the
  HTTP API and `dev`/`build`/`preview` now load it via `util.parseEnv` — no new
  dependency. An existing environment variable still wins over the file.
- **CLI and API broke on any path with a space** (and on all of Windows): the
  re-exec passed a percent-encoded `URL.pathname` to `spawn`. Now `fileURLToPath`.
- **DuckDuckGo results were silently discarded.** `cleanUrl` unwrapped the
  redirect before restoring the scheme, so DDG's protocol-relative wrapper
  (`//duckduckgo.com/l/?uddg=…`) failed to parse and the result was then dropped
  for pointing at duckduckgo.com.
- **Mojeek invented results.** When the result markup changed, a generic fallback
  scraped any anchor — turning header, nav and footer links into organic hits
  with fabricated positions, which `detectSerpBlock` then called `ok`. The
  fallback is gone; an empty list reports `parser-failed`, which is the truth.
  Its primary parser also required more than two result blocks, so a genuine
  two-result page fell through to that fallback.
- **A bot challenge was reported as a parser bug.** DuckDuckGo serves an
  `anomaly-modal` puzzle with HTTP 202 and Mojeek a JavaScript challenge with
  HTTP 200; neither says "captcha", so `doctor` told users to file an issue
  against a working parser. Both now read as `blocked`.
- Conversely, a SERP that merely *mentions* "captcha" or "unusual traffic" in a
  snippet is no longer reported as blocked — parsed results settle it first.
- `doctor --format json` returned before the exit code was set, so the CI canary
  the docs promise always exited 0.
- Documented comma-separated positional keywords (`serp example.com "a,b"`) were
  passed through as one nonsense query instead of being split.
- `robots.txt`: a group addressed to us with an empty `Disallow:` — the standard
  "fetch anything" — was treated as absent and the wildcard's `Disallow: /`
  applied instead. Agent groups now match on the token rather than on any
  substring of "rankproof" (`a`, `pro`, `rank`, `roof` all used to bind us).
- `robots.txt` verdicts expire (30 min; 5 min after an error). One transient 5xx
  used to disallow a host for the entire life of a long-running API process.
- `Crawl-delay`: the reservation advanced by the full delay while the wait was
  capped at 10 s, so every queued request after the first fired early.
- The site audit read `budget.scale(…) || 30`, turning "no time left" (0) into a
  30-page crawl — it worked harder the further a scan had overrun.
- The Google provider fetch had no timeout, no abort signal and no body cap; one
  stalled provider hung `doctor` and every scan.
- A truncated or reset response left `RANKPROOF_PIN_DNS=1` requests hanging
  forever — the response stream had no `error`/`aborted` handler.
- Counts read as English: "1 keyword in the top 10", not "1 keywords".

### Changed

- **Nunito Sans**, bundled in `public/fonts/` rather than fetched from Google
  Fonts — the page no longer makes a third-party request, and the UI survives
  offline. Licensed under the SIL OFL 1.1, included alongside the files.
- CometWeb palette: Night Black surfaces, Energy Mint for actions. Semantic
  colours stay distinct from the accent so a dofollow badge does not read as a
  button.
- `<html lang>` was `pl` on an English interface.
- The last Polish user-facing strings are gone: scorecard labels, action-plan
  titles, every tab and stat card, on-page checks, brand-SERP badges, market
  names (which screen readers were announcing in Polish) and the `pl-PL` date
  format. `DomainSegment` and the brand-SERP `kind` unions are English values
  now — a breaking change to the JSON export, taken while this is still an RC.

### Packaging

- **The published package could not run at all.** `bin/` imports the engine's
  `.ts` sources, and Node refuses to strip types under `node_modules`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so every command failed the
  moment the package was installed rather than cloned — `rankproof version`
  included. The tarball now ships `dist/`, compiled by `tsconfig.build.json`
  (`prepack` builds it). A clone still runs the TypeScript sources directly, and
  sources win when present so a stale `dist/` cannot shadow what you are editing.
  CI installs the real tarball into a path with a space and runs it.
- The tarball is 153 kB across 52 files with **no runtime dependencies**, down
  from shipping all of `src/` — React routes, styles and tests included — plus
  51 dependencies the CLI never imports. Every one of them is consumed by the
  Vite build, and `vite` was already a devDependency, so `npm ci --omit=dev`
  could never build regardless.

- `publishConfig.tag: next`, so publishing an RC does not claim `latest`.
- `npm test` globs `src/**/*.test.ts` instead of naming three files, so a new
  test file actually runs. `npm run test:scaffold` is green rather than
  documented as expected-to-fail.
- `package-lock.json` still identified the project as `serpradar@7.0.0`.
- `.gitignore` covers `.rankproof/`, which the preview and env wrappers write to.
- README/docs corrected: 17 CSV sets (not 14), Brave is off by default, `/doctor`
  accepts GET, the rate limit's real scope, the JSON-redirect recipe that npm's
  banner used to break, and a stale hard-coded test count.
- Code of Conduct reports went to `conduct@rankproof.dev` — a domain nobody
  here owns, with neither MX nor A records, so every report bounced. All
  contact now goes to `maciej@cometweb.io`.

## [8.1.0-rc.0] — 2026-08-25

Truth & reliability hardening + rename to **RankProof** (avoid commercial SERPRadar clash).

### Added

- Google organic provider adapter (`serp-providers.ts`, `docs/providers.md`) via `RANKPROOF_GOOGLE_PROVIDER_URL`.
- Hermetic DNS injection for tests (`setHostResolverForTests`).
- API `GET /doctor` for self-hosted health probes.
- SERP status `not-configured` for optional Google when no provider is set.

### Removed

- Grok PWA / preview-host bridge / `__grok` assets / unused multiplayer scaffold.

### Fixed

- **Orphan detection** — orphans are `inventory (sitemap + optional known URLs) − crawl reachability`, not “crawled page with inboundLinks===0”.
- **HTML meta/canonical parsers** — attribute-order independent; relative canonicals resolve against the page URL.
- **Visibility Score** — blocked / rate-limited / parser-failed / error / not-configured / empty-response queries no longer enter the denominator.
- **Site audit failures** — return `status: "failed"` with an issue instead of silent `null`.
- **X-Robots-Tag** — combined with meta robots during the site crawl.
- **Typecheck** — Better Auth social sign-in APIs (`signIn.social` / `signInSocial`); canonical extraction narrowing.
- **SERP fetches** honour the documented robots exemption (`skipRobots: true`).
- Doctor maps HTTP 429 → `rate-limited`, 403/401 → `blocked`; unconfigured Google is `skip`, not FAIL.

### Changed

- Toxicity verdict `disavow` → `review` (manual review UX; Disavow file remains an optional draft).
- KD documented / aliased as **Open Difficulty / SERP Competition Estimate**.
- Optional DNS pinning via `RANKPROOF_PIN_DNS=1` (Host/SNI preserved; legacy `SERPRADAR_*` env aliases still work).
- Package / CLI / folder: `rankproof`.
- Link velocity verdicts: `growing` | `stable` | `declining` | `unknown` (was Polish enum).
- Action plan: areas `content`/`links`/`risk`, effort `low`/`medium`/`high`; footprint risk `low`/`medium`/`high`.
- Remaining UI/CLI strings English (project language).
- CLI/API `scan` now honour `--engines` / `engines` (previously ignored on full scan).
- CSV / HTML exports and remaining UI copy switched to English.
- SERP fetch: one retry on HTTP 429; hard HTTP failures map to `rate-limited` / `blocked` / `error` instead of crashing the query.
- SERP requests send browser-like Accept + engine Referer (fewer empty challenge pages).
- `.env.example`: `RANKPROOF_GOOGLE_PROVIDER_URL`, User-Agent 8.1.
- `npm run smoke` — doctor + version + help canary.

## [8.0.0] — 2026-08-25

Security hardening, real data from the search engines, an audit of the site itself, and a switch to English as the project language.

### Security

- **SSRF protection** (`ssrf.ts`) — the scanner fetches user-supplied URLs, so every request is now checked before it leaves: protocol allow-list, no embedded credentials, private/loopback/link-local/metadata addresses refused, DNS resolved and validated ahead of connecting, and **redirects followed manually** so a public host cannot bounce us into private space. Mixed public/private DNS answers are treated as rebinding and refused outright.
- **Port allow-list** — only 80, 443, 8080 and 8443.

### Added

- **Google Search Console and Bing Webmaster Tools integration** (`search-console.server.ts`, `search-console-insights.ts`) — real clicks, impressions, CTR and Google positions for a property you own. Powers striking-distance analysis, CTR anomaly detection, decay detection at stable positions, a Google-vs-scraped position comparison, and an honest report of how far our CTR model sits from your reality. Both APIs are free; setup in `docs/search-console.md`.
- **Own-site audit** (`site-audit.server.ts`) — breadth-first crawl building the internal link graph: orphan pages, click depth, broken internal links, redirect hops, canonical conflicts, `noindex` pages holding backlinks, and pages that earn external links while receiving almost none internally.
- **Block detection** (`detectSerpBlock`) — a CAPTCHA, a rate limit and an out-of-date parser are now distinguished from a genuine zero. Per-engine health is carried in the report and surfaced in the UI, so a failed measurement never reads as "no visibility".
- **`doctor` command** — probes every engine with a known query and reports whether results come back, a challenge appeared, or the markup moved. Exits non-zero when no engine works, making it usable as a CI canary.
- **Golden parser tests** against frozen fixtures (`src/lib/backlinks/fixtures/`) — an engine changing its markup now breaks a test instead of silently breaking production numbers.
- **robots.txt and Crawl-delay support** (`robots.server.ts`) — honoured on every crawled page, with agent-specific groups, wildcard and `$` matching, and longest-match Allow precedence. SERP and API lookups are deliberately exempt.
- **Disk cache with conditional revalidation** (`disk-cache.server.ts`) — repeat scans send `If-None-Match` / `If-Modified-Since` and take a 304 instead of a full body. Opt-in via `RANKPROOF_CACHE_DIR`.
- New tabs in the interface: **Search Console** and **Structure**; new exports `searchConsoleCsv` and `siteAuditCsv`.
- `--no-audit` flag for faster scans; `skipSiteAudit` in the API.

### Changed

- **Project language is now English** — interface, comments, error messages and documentation. Translations are welcome as a separate contribution.
- The **on-page component of the visibility index** now averages landing-page quality with internal structure — a perfect page inside a broken site no longer scores full marks.
- The **action plan** prefers measured opportunities: actions derived from Search Console data outrank modelled ones, because the upside behind them is real.
- 66 tests (up from 53).

## [7.0.0] — 2026-08-25

The release that opened the project as open source. Renamed from LinkRadar to **RankProof** — SERP data is a peer of link data here, not an add-on.

### Added

- **CLI** (`bin/rankproof.mjs`): `scan`, `serp`, `ideas`, `gap` commands; `text`, `json`, `csv`, `html`, `disavow` formats
- **HTTP API** (`scripts/serve-api.mjs`) for self-hosting, with rate limiting and localhost-only default
- **ENV configuration** (`src/lib/backlinks/config.ts`) — budgets, concurrency, engines, market, user-agent
- **Market and device selection** — 6 markets, desktop/mobile, matching `Accept-Language`
- **Visibility index 0–100** with six components and an A–E grade
- **Brand SERP** — control over your own first page and detection of reputation-damaging results
- **Link profile footprint** — subnet concentration, sitewide links, exact-match excess
- **Keyword clustering by SERP overlap**, content gaps, featured-snippet opportunities
- **Action plan** — tasks sorted by impact weighted against effort
- **Domain segmentation** and **link velocity**
- **Toxicity analysis** with a disavow file, and an **anchor audit**
- **Rank tracking** between scans (migration `0004_serp_rank_history.sql`)
- **Keyword ideas** from DuckDuckGo and Bing autocomplete
- Documentation: README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, `docs/`
- GitHub Actions CI: typecheck, lint, tests, build

### Changed

- Fourth SERP engine: **Brave**
- SERP depth extended to the top 20 via pagination
- Link gap supports up to 5 competitors and sorts by priority
- Custom keyword panel: 10 keywords, choice of engines, market, device and depth
- HTML report includes the index, plan, brand SERP, clusters, risk and segments
- The HTTP cache key includes language and user-agent — otherwise a second market received the first market's results

### Limitations

Positions come from Bing, DuckDuckGo, Mojeek and Brave — not Google. DR/UR/DS are approximations from open data, not equivalents of commercial metrics. The link list is incomplete by design.
