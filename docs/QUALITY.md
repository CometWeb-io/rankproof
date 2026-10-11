# RankProof — evidence-led release criteria

RankProof is intentionally **local-first, low-cost, free-API-first**. An attractive score alone is not enough to claim correctness. The current changes live in [PR #2](https://github.com/CometWeb-io/rankproof/pull/2); do not treat its code as released until reviewed and merged.

## What has been implemented

- Separated operator-owned Search Console/Bing Webmaster data from anonymous HTTP and Web UI scans; local CLI requires explicit opt-in
- Fixed HTML anchor attribute confusion and case-sensitive URL identity
- Fixed non-monotonic SERP scores, query/aggregate mismatch in GSC, and inclusive calendar windows
- Bounded Google/OpenSERP v2 responses and added opt-in loopback trust
- Restricted production crawler DNS-rebinding, HTTPS downgrade, robots.txt behavior, and caches
- Added explicit links evidence kinds and live revalidation for archived lost-link claims
- Added complete PSL (ICANN and private), with a manual no-dependency update path
- Added scope fingerprints and suppressed cross-scope comparison deltas
- Added sampled coverage metadata and separated 'not rediscovered' from confirmed loss
- Added bounded standalone API/Web UI concurrency, optional local PGLite durability and quick/standard/deep profiles
- Added regression tests, documentation and an offline benchmark command

## Acceptance gates before a stable release

1. **Real-world correctness:** use a fixed corpus of diverse sites: small/large, IDN, private hosting, redirects, localized SERPs, blocked SERPs, HTTP/HTTPS, JS-rendered, multi-language and historical/archive cases. Manual examination of ground truth and false-positive rates is required.
2. **Metrology:** publish source coverage, unknown/blocked status and methodology for every headline metric. Never substitute a zero for missing data; avoid describing bounded discovery as a global backlink census.
3. **Reproducibility:** record exact engine, market, device, profile, keyword set, source states, date/time and version. Compare only equivalent scopes, never convert links not rediscovered into proven losses.
4. **Security:** have independent adversarial tests for SSRF (DNS rebinding, IDNs, redirects, IPv4-in-IPv6), HTML/formula injection, local API authentication, multi-process resource exhaustion, fetch cancellation, connection and body limits, timeout behavior and privacy boundaries.
5. **Resource efficiency:** measure true wall time, p50/p95, CPU, memory, fetched bytes, network requests per scan, cache hit rate and accuracy against a reproducible corpus. Run `npm run bench:local` for *synthetic microbenchmarks only*; they do not replace real-site measurements.
6. **Supportability:** test Node-supported versions, packaged CLI and standalone API, ephemeral and persistent DB mode, offline tests, migration from earlier history, failure recovery, legal/robots constraints and installation instructions.
7. **OSS quality:** provide issue and PR templates, contribution policy, deterministic fixtures, changelog, security disclosure instructions, licensing/attribution and explicit non-goals. Workflow automation is intentionally out of scope.

## Current known limitations

- Real-time scraped SERPs are source-dependent and may be blocked, localized or personalized; they are not equivalent to Google's private Search Console measurements.
- Sampling and source outages prevent exhaustive link discovery. `coverage.completeness` is deliberately `bounded-sample`.
- Pre-existing history rows have no `scopeKey`, so their scan deltas are withheld; preserved historical charts are descriptive.
- Request admission control is per Node process, not distributed across multiple replicas. A public deployment needs a reverse proxy, TLS, abuse protection, and independent security review.
- Some SEO recommendations and risk scores are heuristic, not validated causal estimates. In particular disavowal requires manual review; an automated disavow file is **not** a recommended default action.
- The optional local PSL snapshot is intentionally pinned; refresh it manually after upstream updates, review MPL-2.0 attribution and test against the PSL fixture corpus.
- Synthetic microbenchmarks do not provide independent evidence that RankProof is the most efficient, accurate or reliable scanner globally.

## Cost contract

No cloud queue, paid LLM, paid commercial SEO index or hosted database is required for the default local workflow. Local CPU, network, memory, and website operators' crawl load remain real costs. Externally hosted services, optional remote data sources and any infrastructure selected by a self-hosting operator can introduce costs.
