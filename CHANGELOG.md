# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); semantic versioning.

## [Unreleased]

## [1.1.0] — 2026-11-14

### Fixed

- A resumed `verify --checkpoint` run skipped pairs whose stored observation was an error; they are now verified again.
- `verify --strict` with all contracts met reset a webhook failure (exit `4`) to `0`; a contract failure (`3`) still takes precedence.
- `keygen` silently overwrote an existing signing key; it now refuses unless `--force` is given.
- A source that already lacked the link and then returned 404/410 was reported as _Unchanged_; it is now _Source page gone_.
- Accessibility (WCAG 2.1 AA, checked with axe on every page and on the landing page, now part of the end-to-end suite): secondary text and error colours raised to at least 4.5:1 contrast, links inside sentences are underlined, market buttons and the hash copy button have accessible names that contain their visible text, scrollable code blocks on the landing page can be focused.
- Page content showed through the 12 px gap above the sticky header while scrolling.
- A built app without `DATABASE_URL` crashed the server on its first database query: PGLite's `pglite.data`/`.wasm` files were not copied into the server bundle. `npm run build` now copies them (`scripts/copy-pglite-assets.mjs`).

### Security

- **Rendered verification followed redirects without checking them.** Chromium followed a server redirect on its own, and Playwright does not route the next hop again, so a public page redirecting to a private or metadata address was loaded despite the URL policy (main frame and subresources). Chromium now never follows a redirect: main-frame hops are re-navigated through the interceptor, subresource hops are followed and checked one by one (at most 5). Regression test included. Only affected `--render` / `RANKPROOF_RENDER=1`.
- **Pinned rendering.** With `RANKPROOF_PIN_DNS=1`, the browser makes no connections of its own: every allowed request is performed by Node through the validated address (`pinnedFetch`, Host/SNI preserved, uncompressed, 5 MB per resource) and handed to the page with `route.fulfill`. DNS prefetch and network prediction are disabled and the browser is launched behind a proxy address that refuses every connection.
- **Rendering hardening.** WebSockets, which Playwright's request routing does not see, are now closed by a `routeWebSocket` handler before any connection is made (previously a rendered page could open one directly). Without pinning, browser responses above 5 MB are refused instead of buffered. A process-wide limit, `RANKPROOF_RENDER_CONCURRENCY` (default `1`), caps concurrent Chromium instances. A rendered page that redirects into the target's own site is an internal link (error), as in the fetched path, instead of a confirmation.
- **`check-seal` no longer reports a timestamp it did not verify as OK.** The TSA token is checked structurally only (status, imprint, nonce, time); its CMS signature is verified by the printed `openssl ts -verify` command. Such a seal, and a signed seal checked without `--public-key`, is now reported as _not fully verified_ (`status: "unverified"`, `ok: false`, exit `0`) instead of `✓ timestamp` / `Seal OK`. Exit `3` stays for real failures. See [evidence](docs/evidence.md#sealing-a-run).
- **Monitor webhooks quoted publisher text verbatim.** Change details include the page's anchor text and rel; Slack `text` now escapes `&`, `<`, `>`, Discord `content` escapes mention and masked-link markup, `@everyone`/`@here`/`@channel` are broken in both, and the payload carries `allowed_mentions: { parse: [] }`.
- **Report and evidence hardening.** The Markdown report puts every input- or page-derived value in a code span (no injected links, images, HTML or mentions in CI summaries); the HTML report links only `http(s)` URLs. A recorded `response_hash` must be a SHA-256 hex digest before it is used as a file name in `corpus`, `replay` and `export-warc`; `corpus` also checks each snapshot's SHA-256 and derives case IDs from a hash of the whole target URL (a prefix collided).
- **Mention extraction was quadratic on hostile HTML.** Plain-text mentions were found with backtracking regular expressions over up to 2 MB of source HTML; many unclosed `<a` openers or a long run of `<` without `>` could pin a CPU for minutes. Mentions now come from the linear tokenizer, and `stripTags` no longer backtracks.

RankProof now leads with its core job: verifying backlinks you already know about, against what was agreed, with a receipt of what was read. The domain audit stays, one click away.

### Added

- **Link contracts** (policy `link-contract-v2`). `POST /v1/backlinks/verify` items accept optional `expected_anchor`, `expected_rel` and `expected_placement` (`follow`, `nofollow`, `sponsored`, `ugc`). Every result gains `contract` (`meets`, `deviates`, `missing`, `unverified` plus per-clause marks and notes) and `near_matches` (links to the target site but a different URL, with the difference named). Additive to schema `1`; advertised as capability `backlinks.verify.contract.v1`.
- **`rankproof verify <pairs.csv|->`**: CSV/TSV/semicolon input with optional header, line-numbered errors, de-duplication, any number of pairs in batches of 50, `--previous run.json` change report (_Appeared_, _Gone from HTML_, _Source page gone_, _Details changed_, _Run failed_, _Verified again_), `--capture-dir` to save the fetched HTML as SHA-256-named evidence, `--strict` (exit `3` unless every pair meets its contract), and text / JSON / CSV / standalone HTML report output.
- **`rankproof replay <run.json> --capture-dir dir`** re-runs the current extractor offline against captured HTML, checks each snapshot's hash and reports `reproduced`, `differs`, `no_snapshot` or `integrity_failed`.
- **Verify links in the web app** (now the home page): paste or upload a table, see a ledger of results with an observation receipt per pair (final URL, HTTP status, extractor, SHA-256), filter by result, compare with the last run in this browser or with a saved JSON run, export CSV, JSON (accepted by `--previous`) or an HTML report. An offline example runs bundled HTML through the real extractor.
- **MCP server.** `rankproof mcp` speaks the Model Context Protocol on stdio (JSON-RPC 2.0; protocol versions 2025-06-18, 2025-03-26, 2024-11-05) with tools `verify_links` (pairs or CSV text, optional rendering) and `explain_verdicts`, so AI agents can verify links and describe the result without overstating it. Checked with the official MCP TypeScript SDK client. Setup for Claude Code / Claude Desktop in [docs/mcp.md](docs/mcp.md).
- **Resumable runs.** `verify --checkpoint progress.jsonl` saves results after every batch of 50 and skips completed pairs on rerun; resumed observations are re-judged against the current expectations; the file is removed when the run completes.
- **Saved lists in the web app** (`/monitors`). Keep up to 200 links per list on the server, check them on demand, browse the last 30 runs with each run compared with the previous one, edit and delete. "Save as a list" on the verify page hands the current table over. Per-user (verified session; local dev user without sign-in and database), migration `0005_link_monitors.sql`, tested against PGLite including cross-user isolation, plus an end-to-end test.
- **Scheduled saved lists.** A list can run every day or every week and post a summary of changes to a Slack/Discord-style `https://` webhook. `GET|POST /api/cron/monitors` with `Authorization: Bearer $RANKPROOF_CRON_SECRET` (or Vercel's `CRON_SECRET`) runs due lists, each claimed first so overlapping calls never run a list twice; failures are recorded per list and never stop the others. Migration `0006_monitor_schedule.sql`. Tested with concurrent invocations, a failing list and the endpoint's authorization.
- Saved lists: upload a CSV into a list, export any run as CSV, JSON (accepted by `--previous`), HTML report or Markdown, search and sort (problems first by default). Filtering and sorting are shared with the verify page and unit-tested.
- **Property tests** (`src/lib/backlinks/fuzz.test.ts`, seeded and reproducible): every spelling of a private IPv4 address (decimal, hex, octal, short forms, trailing dot, IPv4-mapped and NAT64 IPv6, ideographic dots) and private IPv6 ranges are refused; DNS answers that mix in a private address are refused; the pair table parser only emits valid, unique http(s) pairs; the tokenizer is total and in bounds; an exact-URL anchor in content is always confirmed, and one hidden in a comment, script, style, template, textarea, noscript, title or attribute is always a definite `not_found`; robots.txt parsing follows RFC 9309 tie-breaking. 300 cases per property in `npm test`, 5,000 with a fresh seed per CI run (`npm run test:fuzz`). Mutation-checked: breaking comment, script or style handling, or one private range, fails the suite.
- The domain audit is labelled **experimental** in the app and README; the landing page (`site/`) and screenshots show the verify workflow, saved lists, rendering, sealing and MCP.
- **Copy as Markdown** in the web app results, for Slack, e-mail or pull requests.
- **Evidence you can archive.** `rankproof export-warc run.json --capture-dir dir --out evidence.warc.gz` writes WARC 1.1 (ISO 28500): a `resource` record per captured body with SHA-256 block/payload digests, linked `metadata` records with the observation. Validated with `warcio check`. [docs/evidence.md](docs/evidence.md) defines what each artifact proves and what it does not.
- **API contract for integrators.** `contract/fixtures/` holds golden `/health` and `/v1/backlinks/verify` documents produced by the real extractor; the test suite fails on any drift (`npm run contract:update` on purpose). Reference clients with tests against those fixtures: Python (standard library only, for FastAPI and other Python backends) and TypeScript (no dependencies). `npm run test:clients`.
- **Benchmark on real links.** `rankproof corpus run.json --capture-dir dir` turns a captured run into a labelling sheet (RankProof's verdict only as `suggested`); `npm run benchmark -- --corpus cases.json [--render]` scores reviewed cases only.
- **Sealed evidence.** `rankproof seal run.json [--key key.pem] [--tsa URL] [--wayback]` adds a SHA-256 seal, an Ed25519 signature, an RFC 3161 timestamp token (`.tsr`, verifiable with `openssl ts -verify`) and Internet Archive copies of the source pages; `rankproof check-seal` verifies it (exit `3` on failure); `rankproof keygen` creates a key pair. Round trip tested against an OpenSSL TSA.
- **Large lists run smoother.** `verify` spreads source hosts across batches (round-robin, each host's order kept), so a list dominated by one site no longer times out a whole batch behind the per-host limit; results keep table order. Multi-batch runs log progress with confirmed count and an estimate of time left.
- **Crawler identity.** `RANKPROOF_CRAWLER_IDENTITY=rankproof` makes page fetches send `RANKPROOF_USER_AGENT` instead of a browser user agent (port of the open decision from upstream PR #2, as an opt-in). Default unchanged; `doctor` shows which is active.
- **`rankproof report run.json`** re-formats a stored run offline (text, CSV, HTML, Markdown); `--format markdown` for CI summaries and PR comments.
- **GitHub Action** (`action.yml`): verify a links file in CI, job summary, HTML report, outputs per verdict, optional rendering and change report. Example workflow in `docs/examples/link-check.yml`.
- **Dockerfile**: CLI + API image with only the three runtime packages; `--target render` adds Playwright and Chromium. `docker run … rankproof api` binds the API inside the container and warns without a token.
- **Rendered verification (optional).** `rankproof verify --render[=always]`, `replay --render`, and `"render"` on `POST /v1/backlinks/verify` when the server runs with `RANKPROOF_RENDER=1` (capability `backlinks.verify.render.v1`). Headless Chromium via the optional `playwright` peer dependency (or a system Chrome/Chromium, `RANKPROOF_CHROMIUM_PATH`). Results gain `rendered` with its own status, DOM hash, visibility and anchors; the fetched-HTML fields are never rewritten. Links inserted by JavaScript are confirmed with `contract.basis: "rendered_dom"`; links hidden from visitors make the contract `deviates` (`contract.visibility: "mismatch"`). Every browser request passes the crawler's URL policy; media, WebSockets and service workers are blocked; challenges are not solved; an empty rendered page is an error, not an absence. `npm run benchmark -- --render` resolves both documented limitations with no regressions (39/39, 2/2). The web app shows a browser-check option when the server allows it, and a browser receipt per link.
- **Where the link sits.** Every matching anchor reports its `placement` (content, navigation, footer, sidebar, comment) and up to 400 characters of surrounding visible text (`context`). Contracts accept `expected_placement`; a page without landmarks yields `unobserved`, never a deviation. A move between regions is reported as _Details changed_ only when both runs could tell.
- **Mentioned without a link.** On `not_found`, plain-text occurrences of the target host or the agreed anchor (outside any link) are returned as `mentions` and flagged with `contract.mentioned` — a ready-made outreach candidate.
- **Local monitoring.** `rankproof verify --history <dir>` stores every run and its HTML evidence, compares with the latest run automatically and prunes to `--keep` runs. `--webhook <url>` posts a Slack/Discord-compatible summary only when something changed (exit `4` if the notification fails). `rankproof history <dir>` reports each pair over time (confirmed share, failed runs, last confirmed, streak, recent changes) as text, CSV or JSON.
- **Verification benchmark.** `npm run benchmark` scores the extractor on a labelled corpus of 39 cases (URL identity, markup traps, rel, anchor text, placement, HTTP statuses, unreadable pages) and reports precision, recall, unresolved share and false absences. Two documented limitations (JavaScript-inserted and CSS-hidden links) are scored separately. The test suite fails on any regression. See [docs/benchmark.md](docs/benchmark.md).
- **OpenAPI.** `docs/openapi.yaml` describes `/health` and `/v1/backlinks/verify`, including every evidence and contract field.
- The web app keeps the last 12 runs in the browser and shows a per-link timeline; results can be searched and sorted (problems first). Placement, context, mentions and near matches appear in each link's receipt.
- The domain report groups its 17 sections into Summary, Links, Search, Site and Opportunities, with arrow-key navigation between tabs.
- Scorecard components carry a `basis` (`observed`, `estimated`, `unknown`) and the scorecard a `coverage` percentage.

### Changed

- Positioning: "Verifiable web relationships". README, package description and keywords lead with link verification and evidence; the domain audit is described as secondary. [docs/roadmap.md](docs/roadmap.md) lists the problems fixed and where.
- The Disavow download left the report header; it now sits in the Risk tab behind an explicit review confirmation and Google's guidance.
- The domain scan moved to `/audit`. Its headline numbers are split into what was seen in fetched HTML and what is a model or estimate; labels are no longer all-caps.
- The visibility index excludes components that were not measured instead of filling them with neutral or free points (unreadable landing page = 50, empty profile = full Safety marks, failed crawl = structure 0). The UI and HTML report show coverage.
- Referring domains use the full Public Suffix List (`tldts`, private section included): `alice.github.io` and `bob.github.io` are separate domains, and a link between them is no longer rejected as internal.
- Owner data from Search Console / Bing Webmaster Tools is attached to web and HTTP API scans only for hosts listed in `RANKPROOF_OWNER_SITES`. The CLI, run by the operator, still attaches it for any accessible property.

### Fixed

- `verify --capture-dir` kept every fetched page in memory until the end and wrote evidence only after the whole run; it now writes per batch, so memory stays bounded and an interruption loses at most one batch.
- robots.txt starting with a UTF-8 BOM ignored its first `User-agent` group (RFC 9309). A public Google provider must use HTTPS. Both ported from upstream PR #2.
- The npm package now ships `contract/` fixtures and the reference clients; CI installs the packed tarball and runs the Python client tests and every verify-side module from `dist/`.

- Anchors made only of navigation words ("Visit website", "Blog", "Odwiedź stronę") are classified as generic, not exact-match. Ported from upstream PR #5 by MaciejZet.
- Blocked, rate-limited or parser-failed SERP pages no longer feed competitors, cannibalisation, clusters, content gaps or featured-snippet opportunities; they stay visible in engine health. A Google provider envelope that reports an engine failure or has no results field now fails closed instead of reading as "does not rank". Ported from upstream PR #2.

- Keyword visibility used `11 − position`, so a #20 hit subtracted 90 points and scored worse than not ranking at all. Positions #11–#20 now earn a small positive tail; top-10 values are unchanged. The brand-SERP control share had the same flaw.
- Requests waiting for a per-host connection slot ignored their timeout and abort signal, and robots.txt for a redirect target could queue behind the request that needed it, which could stall a verification indefinitely. Waiting now counts against the request deadline, abandoned waiters leave the queue, and robots.txt bypasses the limiter.
- The documented loopback Google provider (`http://127.0.0.1:7000`) was always refused by the SSRF guard. It now works with an explicit `RANKPROOF_GOOGLE_PROVIDER_ALLOW_LOOPBACK=1`; LAN, link-local and metadata addresses stay blocked, and provider redirects are refused.
- Sitemap URLs not reached by a crawl that stopped early (page limit, budget, robots, fetch errors) were reported as high-severity orphan pages. Orphans now require a complete crawl; otherwise they are a low-severity measurement gap and cost no structure points.
- Two Polish strings in the English interface ("kopia archiwalna", "Analiza celu").

## [1.0.1] — 2026-11-08

### Fixed

- Anchor text no longer contains raw markup when a link wraps a long inline SVG icon. Such links read as image links with no text unless they carry an `aria-label`, `title`, `<img alt>` or an SVG `<title>`. Anchor extraction is now `html-anchor-v5`.
- `<wbr>` inside a link no longer inserts a space into the anchor text ("backlinks", not "back links").
- The action plan tab showed four Polish labels in the English interface, and the toxic links tab and one toxic-link reason showed Polish text ("Ryzyko CSV", "tylko stopka lub sidebar").

## [1.0.0] — 2026-11-07

First release under restarted numbering. Earlier internal versions are listed under [History before 1.0](#history-before-10).

### Security

- Upgrade `better-auth` to 1.7.18 for [GHSA-r4xp-prcw-77qf](https://github.com/advisories/GHSA-r4xp-prcw-77qf) and [GHSA-965c-763c-88jm](https://github.com/advisories/GHSA-965c-763c-88jm) (sign-in as another user through the OAuth proxy or OAuth state), [GHSA-q84f-53jg-9ppm](https://github.com/advisories/GHSA-q84f-53jg-9ppm) and [GHSA-44jh-23m7-hpcf](https://github.com/advisories/GHSA-44jh-23m7-hpcf).
- Pin `minimatch` 11.0.5 under `typescript-eslint` for [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
- `RANKPROOF_GOOGLE_PROVIDER_URL` (and the legacy OpenVis / SerpRadar aliases)
  goes through the same guard before fetch. Loopback, link-local and metadata
  addresses are refused, including after DNS resolution.
- Dependency overrides clear the high advisories on `fast-uri`, `js-yaml` and
  `brace-expansion`. CI runs `prettier --check`.
- Upgrade TanStack Start and its matching router to fix unauthenticated reflected XSS in server-function responses ([GHSA-qx66-fv34-fjm8](https://github.com/advisories/GHSA-qx66-fv34-fjm8)).
- Upgrade Vite, Zod, `source-map-js` and the `fast-uri` override to patched versions. CI audits the complete dependency tree, including web dependencies listed under `devDependencies`.

### Added

- **Versioned exact backlink verification:** `POST /v1/backlinks/verify` accepts up to 50 pairs and returns fresh, ordered `confirmed`, `not_found` or `error` observations with timestamps and anchor evidence. HTTP challenges, robots refusals, unsupported content and fetch failures do not count as missing links.
- HTTP health now advertises contract capabilities, package version and optional `RANKPROOF_SERVICE_REVISION` for source-snapshot compatibility.
- **Service token for the HTTP API.** With `RANKPROOF_API_TOKEN` set, every endpoint except `GET /health` requires `Authorization: Bearer <token>` and answers `401` otherwise — for running RankProof on a private port behind another service.
- **`seedUrls` on `POST /scan`.** Up to 150 pages the site owner's webmaster tools (Bing, Yandex) report as linking in. They are prioritized within the available verification budget, and show up as `discoveredVia: "webmaster"` only when the link is confirmed in their HTML.
- `POST /scan` also accepts `mode`, `budgetMs` (clamped to 8–300 s) and `depth`; request parsing moved to the pure, tested `service-api.ts`.

### Changed

- HTML anchor extraction v4 preserves equals signs in unquoted query values and decodes URL attribute entities once in shared parsing.
- Exact HTML URL attributes use the full, case-sensitive runtime entity decoder; discovery revalidates source HTML rather than refreshing cached evidence timestamps.
- Unknown acquisition remains unknown in the UI, CLI and HTML export; score comparability includes the actual scored subset and selection inputs.
- Discovery separates provider reports from fetched-HTML confirmation, preserves overlapping source provenance and adds a versioned coverage/score/visibility manifest.
- Exact source-target IDs preserve URL semantics and survive anchor edits. Legacy summary history without comparable manifests no longer emits new-report acquisition/loss or score deltas.
- Source-domain archive age is separate from link observations; acquisition velocity remains unknown without dated cohorts. Rendered-DOM checking is deferred behind browser network/robots safety requirements.

### Fixed

- Unknown `--market`, `--device` and `--depth` values error with the allow-list
  instead of falling back. `scan --depth` is the depth the scan uses (10 or 20).
- The CLI exits before `--experimental-strip-types` when Node is older than 22,
  with a message that names the floor. `doctor` stays non-zero when unhealthy,
  matching HTTP 503.
- Install docs no longer tell people to `npm install rankproof` while the
  registry 404s. Clone and `npm ci` is the path that works.
- The CLI imports `scripts/node-version.mjs` before any command runs. That file
  is now in the published `files` list, so an installed package can start.

### Documentation

- New [backlink verification quickstart](docs/backlink-verification-quickstart.md); README leads with the known-backlink verification workflow and its limits.
- `docs/metrics.md` no longer presents the clustering threshold or CTR curve as established standards; `docs/api.md` documents the `503` from `GET /doctor`.

## History before 1.0

Versions 7.0.0 to 8.1.0 were internal numbers carried over from the project's earlier names (SerpRadar, then OpenVis). They were never published to npm, and their Git tags and GitHub releases were retired when numbering restarted at 1.0.0. The entries stay here as a record of what changed.

## 8.1.0 (internal) — 2026-08-30

First stable public release after the RC hardening pass.

### Added

- Playwright UI smoke tests (`e2e/smoke.spec.ts`) and CI job — landing page, skip link, form validation, market toggles.
- [`docs/production-ops.md`](docs/production-ops.md) — doctor cron, npm publish, deployment, cache, upgrade checklist.
- Modular scan UI under `src/components/scan/` — labels, primitives, charts, link gap, empty states, accessible tab navigation.
- Skip link, `aria-pressed` market/device toggles, `:focus-visible` rings, and 44px touch targets on primary controls.

### Changed

- **GA status** — version `8.1.0`, npm publish tag `latest`, README no longer marks the project as RC.
- **English UI** — removed remaining Polish strings from components and user-facing engine output.
- `scan-results.tsx` refactored from a single 1.5k-line module into focused subcomponents.
- `scan-serp.tsx` split into `src/components/scan/` modules (barrel re-export; largest file ~250 lines).

## Open-source readiness (before internal 8.1.0)

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
- Conversely, a SERP that merely _mentions_ "captcha" or "unusual traffic" in a
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
  contact moved to the CometWeb mailbox; see `SECURITY.md` for the current address.

## 8.1.0-rc.0 (internal) — 2026-08-25

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

## 8.0.0 (internal) — 2026-08-25

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

## 7.0.0 (internal) — 2026-08-25

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
