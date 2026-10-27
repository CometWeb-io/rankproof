# Evidence intelligence (experimental)

These modules replay retained RankProof results. They do not contact providers, execute JavaScript, send outreach, modify a site, or forecast SEO gains. Existing scan and gap fields remain compatible. No additional dependency is required.

## Entry points and integration

The existing `runSiteAudit()` now adds `technicalGraph` to successful results. It records actual fetched-HTML anchor edges, canonical declarations, hreflang, pagination and discovered sitemap inventory. The existing `runLinkGap()` adds `report.intelligence`, evaluated against the competitor and target backlinks already returned by its scans. Neither integration requests additional scans or providers.

From a checkout on Node 22:

```sh
node --experimental-strip-types scripts/intelligence-report.mjs scan-export.json > analysis.json
node --experimental-strip-types scripts/intelligence-replay.mjs citations citation-dataset.json > citation-report.json
node --experimental-strip-types scripts/intelligence-replay.mjs graph graph-input.json > graph.json
node bin/rankproof.mjs analyze scan-export.json > analysis.json
node bin/rankproof.mjs citations citation-dataset.json > citation-report.json
```

`intelligence-report` and the main CLI `analyze` command consume either a `ScanReport` exported by the CLI or `{ "ok": true, "report": ScanReport }`. They hash the supplied scan, reuse `siteAudit.technicalGraph` when present and convert existing audit issues/action plans into evidence decisions. A legacy export explicitly reports missing graph observations; it cannot reconstruct links from aggregate inbound counts. Main CLI `citations` invokes the same validated citation replay as the checkout script.

The main CLI imports `analyzeScanReport` from `decision-engine.ts` (or `dist/decision-engine.js` after `npm run build:cli`) for `analyze`. The checkout scripts are convenience adapters, not installed npm binaries. `runLinkGap(target, competitors, {profile: "quick"})` forwards the profile to all scans; owner webmaster data is explicitly disabled in gap scans. Omitting options keeps the runtime's configured default profile.

| Module                        | Named exports                                                 | Input                                                                                                                    | Output                                                                                     |
| ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `rendered-policy.ts`          | `renderedPolicy`, `compareRenderedSnapshots`, `RENDER_LIMITS` | URL string; or `{url, rawHtml, renderedHtml, capturedAt, evidenceRef}`                                                   | Unavailable renderer policy; or offline raw/DOM anchor comparison                          |
| `technical-graph.ts`          | `buildTechnicalGraph`                                         | `TechnicalGraphInput`                                                                                                    | Version 2 graph, coverage, candidate URLs and evidence references                          |
| `competitive-intelligence.ts` | `buildCompetitiveIntelligence`, `hasHtmlConfirmation`         | `{gap: LinkGapReport, competitorBacklinks: Backlink[], targetBacklinks: Backlink[], assessments?: ProspectAssessment[]}` | Review-ordered prospects, confirmation provenance, rationale and assumptions               |
| `decision-engine.ts`          | `buildEvidenceDecisions`, `analyzeScanReport`                 | `{scan?, graph?, competitive?}`; or exported scan                                                                        | Evidence decisions with qualitative effects, explicit assumptions and unknown costs        |
| `citation-lab.ts`             | `importCitationDataset`, `replayCitationDataset`              | `CitationDataset`                                                                                                        | Validated copied dataset; or retained dataset, hash and cohort-specific counts/variability |

`intelligence-replay.mjs` supports `render-policy`, `render-compare`, `graph`, `competitive`, `decisions`, and `citations`. Each reads the corresponding input above from a JSON file and writes JSON to stdout; invalid input produces a nonzero exit code. For `render-policy`, the JSON file contains a URL string. Both scripts reject inputs over 25 MB.

## Rendering boundary

`renderedPolicy()` always returns `status: unavailable` and `networkPolicy: deny_all`, including for public URLs. No browser is launched and no URL/subresource can be fetched through this module. Its limits describe the required executor contract, not resource limits already enforced by an implemented browser.

Enabling Chromium requires an independently qualified OS sandbox, enforced CPU/RAM/wall-time limits, a DNS-pinning egress proxy validating the address at connection time, complete confinement of navigation/redirect/subresource/worker/WebSocket/WebRTC traffic, robots checks and request/byte/redirect budgets. A Playwright route hook or an environment flag is insufficient. There is intentionally no flag that enables an unsafe fallback.

Offline snapshot comparison requires a public-form URL, timestamp and evidence reference; both snapshots are limited to 2 MB. It uses the existing strict HTML tokenizer and exact `<a href>` extraction, respects the document base, and retains SHA-256 hashes of the imported HTML. `data-href`, JavaScript strings and script bodies are not anchors. `renderedOnly` describes imported DOM differences; indexability remains unknown. Snapshot authenticity is a caller assertion, and no real JS rendering is claimed.

## Technical graph input and coverage

`TechnicalGraphInput` contains:

- `rootUrl`: the actual graph document root; graph scope is that exact HTTP(S) origin. Optional `requestedRootUrl` retains the original request before bootstrap redirects.
- `audit: SiteAudit`: existing pages and canonical declarations. Each page URL must be unique and in scope.
- `observations: GraphObservation[]`: `{url, links, hreflang?: [{language,url}], pagination?: [{relation: "next" | "prev",url}], resolvedUrl?, requestedUrl?, evidenceRef}`. Observations belong to the actual fetched document URL; URLs resolve against that source page and links preserve query case/order and remove only fragments. An observation must belong to an audited page.
- `inventories: GraphInventory[]`: `{source: "sitemap" | "gsc" | "cms" | "supplied", urls, complete, evidenceRef, documentUrl?}`. Different inventory sources remain distinguishable. Legacy `knownUrls` are labelled `supplied`, never guessed as GSC or CMS. `runSiteAudit` also accepts `options.inventories`.
- `crawl`: `{frontierExhausted, blockedUrls, failedUrls, redactedUrlCount?, redirects?: [{from,to,status}]}`. Redirect receipts describe actually observed HTTP responses, not inferred URL aliases. A stopped frontier, missing edge/redirect observation, unsuccessful response, refused cross-origin redirect, parse truncation or blocked URL prevents a complete-crawl claim. Successfully observed in-scope redirects are traversed without attributing HTML to their aliases.

Coverage separates `auditedPages` (retained audit rows with an actual HTTP status above zero), `knownPages` (all retained audit rows, including synthetic inventory rows), and `observedLinkPages` (admitted HTML link observations). Known rows are not a count of the complete site inventory.

Output includes BFS shortest depths, declaration-based canonical clusters/cycles, reciprocal/absent/unknown hreflang checks, pagination observations, sitemap reached/unobserved counts, query-variant facet candidates and orphan candidates with inventory provenance. Query variants are not automatically treated as faceted navigation. Canonical clusters are declarations, not search-engine canonical selection.

Inventory URLs never reached by the graph remain **candidates**. Observed link targets count as reached even when the fetch budget stops before visiting them. With partial coverage the candidate state is `inventory-not-reached`; with complete observed graph traversal it is `unreachable-in-observed-graph`. Existence is reported separately. Candidate counts do not reduce the existing heuristic audit score, and investigation issues have low severity. A complete traversal does not certify a complete inventory or search-engine crawl. The built-in sitemap collector remains conservatively incomplete because its existing map/URL/request limits cannot establish exhaustive coverage. Non-HTML, incomplete/truncated HTML and recognized HTTP-200 challenge pages cannot become admitted graph observations.

The initial root request may follow guarded, robots-checked redirects within the same registrable site, including the common apex-to-www redirect. The actual root document then establishes an exact origin (scheme, host and port). Subsequent sibling subdomains are external links, and non-root cross-origin redirects are refused before target DNS/HTTP. HTML observations and relative links belong to the actual fetched document, never to its redirect alias. Graph click depth counts an anchor as one step and an observed in-scope redirect as zero extra clicks. Safe internal HTTP links remain graph edges even when the crawl policy excludes their targets, including PDFs with query strings; exclusions prevent complete-coverage claims. Credential-like URL parameters are suppressed before crawling/export and counted in `coverage.redactedUrlCount`, which also prevents complete-coverage claims. URL admission does not sanitize arbitrary caller-supplied evidence labels: keep those labels free of secrets.

`inventories` retains each source's reference and optional actual sitemap `documentUrl`; built-in sitemap references hash the decoded XML text (`sitemap:sha256:…`). Discovery visits at most 32 same-origin map URLs and stops at its URL/time budget. Built-in sitemap completeness stays false, including when all discovered maps return successfully. Synthetic inventory rows (legacy status zero) never establish a fetched canonical, hreflang, pagination or sitemap target observation. Canonical target failures, conflicting targets for one normalized hreflang locale, missing observed return links and unusable observed alternates have explicit issue URLs. No language/content match is inferred from a locale declaration.

`facetCandidates` adds observed parameter names/values, inventory provenance and actual anchor navigation evidence. Its classification remains `query-variants-not-proven-facets`: search, tracking and pagination parameters can resemble filters. `pagination` retains observed `next`/`prev` declarations separately. `redirects` retains the actual observed HTTP redirect hops and status codes, including a refused cross-origin target; the crawler refuses that target before its DNS/HTTP request. `documentResolutions` separately records requested-to-final document provenance and never invents a direct HTTP hop.

`repairTargets` contains every concrete URL for canonical/hreflang issues, deep-page checks and orphan investigations, with related URLs, certainty and references. `technicalGraphCsv(graph)` from `export.ts` exports the whole list without the legacy audit's 100-page display cap or six-sample issue cap. CSV cells escape quotes and spreadsheet formulas. An investigation row is not a recommendation to delete or redirect that URL. Neither graph JSON nor this CSV carries HTML bodies.

The hermetic acceptance test in `technical-graph-acceptance.test.ts` serves 1017 authored HTML pages over actual local HTTP, runs the production crawler/parser through a test-only transport adapter, and combines 1268 unique sitemap/GSC/CMS inventory URLs. It checks shortest depth, canonical/hreflang/pagination/query-navigation evidence, source provenance and all 257 repair rows. A second traversal stops after 12 pages and must retain incomplete coverage and candidate-only orphan states. This is controlled integration evidence, not validation on an independently operated large production site or a scalability benchmark.

The live crawler hashes the useful HTML returned by its fetch layer (`useful-html:sha256:…`); this is not a claim that original HTTP response bytes were retained. Keep exports and the upstream evidence ledger to resolve references. Cross-origin hreflang/canonical targets can be described but are not silently added to graph scope. Graph import bounds are 100,000 pages/observations/inventory URLs and 1,000,000 edges.

## Prospects and decisions

Prospects use existing gap candidates. `competitor-link-confirmed` requires a live verified backlink with fetched-HTML anchor evidence, matching exact resolved source/target identity, timestamp and SHA-256 response hash. Requested source URL remains separate redirect provenance. Provider-only reports remain `reported-gap-unverified`. An observed target relationship is marked `already-observed-for-target`; absence in the supplied target sample does not establish site-wide absence.

Optional human assessments specify page type, topical relevance, feasibility, cited rationale and publication history with dates/references. They are imported assessments, not calibrated model output. Review order prioritizes confirmed relationships with cited relevance/feasibility, then other confirmed relationships, then unverified reports. Legacy authority/priority numbers do not establish feasibility or expected rank gains.

Decisions retain source references/hashes or explicit assumptions, state an expected effect as a `hypothesis`, describe difficulty and leave cost unknown (`null`). Existing action-plan numeric impact is explicitly treated as heuristic. Technical conflicts precede incomplete-coverage investigations and acquisition hypotheses. No observed repair outcome or causal effect is manufactured (`observedOutcomes: []`). An export should travel alongside the referenced original scan/graph/evidence.

## Citation dataset and replay

A version 1 dataset has `prompts` and `samples`. Prompts contain `{id, version, text, systemPrompt}`. Each sample contains:

```json
{
  "id": "synthetic-example-1",
  "runId": "synthetic-run-1",
  "promptId": "sources-1",
  "provider": "fixture",
  "model": "fixture-model",
  "modelVersion": "fixture-v1",
  "language": "en",
  "region": "US",
  "generation": { "temperature": 0, "seed": null },
  "kind": "synthetic",
  "capturedAt": "2026-10-27T10:00:00Z",
  "evidenceRef": "synthetic:example",
  "status": "ok",
  "responseText": "Example cites https://example.org/",
  "citations": [{ "url": "https://example.org/", "evidenceText": "https://example.org/" }],
  "mentions": ["Example"]
}
```

This example is synthetic. Observed samples require `kind: observed` and a reference to retained capture evidence; import validation cannot authenticate the capture. Citation annotations require a response evidence span containing the actual cited URL, as supplied or normalized. A generic substring such as "sources" cannot support an arbitrary URL. Hidden provider-only citation metadata without a visible URL is not supported by this schema. Mentions must occur verbatim. The importer does not equate every URL string with a citation or scrape external pages.

Failed attempts use `status: error`, retain diagnostic response text and have no citations/mentions. Reports show all attempts, successful and failed counts separately. Host/mention counts use only successful responses as their denominator, counting a host/mention at most once per response.

Cohort hashes bind prompt text/system prompt/version, provider, exact model/version, region, language, generation settings and observed/synthetic kind. Duplicate sample IDs and duplicate prompt/configuration attempts in one run are rejected. Dataset hashing sorts prompts/samples by ID, so array order does not change the hash. Citation order remains part of the retained observation. Variability counts distinct citation-host sets and differing pairs within a cohort; zero successful trials has denominator zero and no percentage. Samples are descriptive repeated trials, not independent random estimates. Limits: 1,000 prompts, 10,000 samples, 2 MB per response and 20 MB response text in aggregate.

## Milestone acceptance boundaries

| Milestone             | Delivered in source                                                                                                               | Required real validation still outstanding                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 09 Safe rendering     | Tested fail-closed capability policy; bounded offline raw/DOM replay                                                              | Isolated executor, actual JS-only sites, enforced resource/network controls and adversarial browser SSRF qualification. Rendering is **not implemented**. |
| 10 Technical graph v2 | Crawler capture, graph/inventory analysis, exact repair URL exports, incomplete-coverage safeguards                               | Large real-site validation, exhaustive inventory connectors, full faceted-navigation semantics and external canonical/hreflang resolution                 |
| 12 Competitive gap    | Existing gap pipeline connected to supplied HTML evidence, cited human assessments and explicit feasibility assumptions           | SEO expert relevance comparison and real publication/acquisition history validation                                                                       |
| 14 Decision engine    | Existing scan/graph/prospect replay, source references, qualitative hypothesis/effort/unknown cost, deterministic review ordering | Practitioner assessment on real cases, calibrated impact/cost and measured comparable remediation outcomes                                                |
| 15 Citation lab       | Versioned prompt/response import, observed/synthetic separation, retained source text, repeatable replay and variation counts     | Authorized observed provider captures, model-version reproducibility checks and real repeated-trial dataset                                               |

Passing deterministic tests establishes these code paths and contracts. It does not close the outstanding milestone gates or establish installation, publication, hosted runtime safety or commercial readiness.
