# RankProof: evidence-led release criteria

RankProof is local-first and uses free data sources by default.
A high score alone is not evidence of correctness.
Changes in [PR #2](https://github.com/CometWeb-io/rankproof/pull/2) are not released yet.

## Implemented in the draft PR

- Separate private GSC/Bing Webmaster data from public scans
- Fix anchor parsing, URL identity, GSC dates and source totals
- Fix non-monotonic SERP scoring and suppress unsupported opportunities
- Constrain OpenSERP responses, loopback access, DNS and redirect handling
- Fail closed on unreachable robots.txt and require live checks for lost links
- Use full ICANN and private Public Suffix List rules
- Restrict scan comparisons to matching collection scopes
- Report source/API/HTML evidence and bounded-sample coverage
- Bound API/Web UI concurrency and add optional local PGLite persistence
- Provide quick, standard and deep scan profiles
- Add regression tests, documentation and offline microbenchmarks

## Required release evidence

1. Reproduce findings on small, large, IDN and shared-hosting sites.
2. Verify redirects, blocked sources, localized SERPs and multilingual pages.
3. Report unknown, blocked, truncated and HTML-verified observations.
4. Retain market, device, keywords, sources and profile for comparisons.
5. Test SSRF, DNS rebinding, response limits, authentication and timeouts.
6. Measure wall time, request count, bytes, memory and CPU usage.
7. Test packaged CLI, Web UI, standalone API and database migrations.
8. Review licenses, docs, contribution process and security disclosures.

These gates require real-world and adversarial tests, not just mocked unit tests.

## Known limitations

- Scraped SERPs may differ from Google Search Console and may be blocked.
- Backlinks are sampled, not retrieved from an exhaustive web index.
- Historical scan rows without a scope fingerprint cannot yield reliable deltas.
- Request admission controls are per process, not distributed across replicas.
- SEO recommendations and toxic scores remain uncalibrated heuristics.
- Any disavow action requires independent human review.
- The bundled PSL snapshot needs periodic manual updates.
- Run `npm run bench:local` in a source checkout for synthetic CPU benchmarks.
- Such benchmarks do not measure real-world SEO accuracy or network latency.

## Cost contract

No paid LLM, commercial link index, hosted database or cloud queue is required.
Local CPU, memory, bandwidth and website crawler load remain real costs.
Public hosting and optional third-party providers may incur charges.
