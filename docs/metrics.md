# Metric methodology

This document describes **how every number is calculated and what it does not measure**. Without that, metrics are just decorative progress bars.

Overriding principle: everything below is an approximation built from open data. Legacy JSON names such as `domainRating` and `urlRating` remain for compatibility. The UI calls these sampled profile/page indices: they are not measurements of authority or equivalents of Ahrefs, Semrush or Majestic metrics.

---

## Domain score (DS, 0–100)

`src/lib/backlinks/score.ts` → `domainScore()`

This is an **uncalibrated ordering rule**, not a measured property. Inputs include a manually selected domain trust list (+34 points), TLD priors (+26 for selected government/education suffixes; −18 for selected other suffixes), domain archive age, Wikipedia discovery, sampled current linking-page count, HTTPS and name construction. The trust list and TLD weights are assumptions, not empirical labels of quality. Domain age is not a link-acquisition date.

The source URL, fetched representation, response hash and evidence timestamp are observations. Their conversion into DS uses chosen weights. Independent annotation and calibration are still required; relabeling this index does not validate those weights.

**What it does not measure:** real traffic, or authority in Google's eyes. It is a heuristic for ordering a list, not an oracle.

## Sampled profile and page indices (legacy `domainRating` / `urlRating`)

`src/lib/backlinks/graph.ts`

PageRank uses **freshly fetched HTML context and verified live backlink relations**. Current referring-domain and page aggregates use all observed current links before presentation caps. Historical archive candidates and unverified/provider assertions are partitioned separately and cannot add domains, anchor shares, follow counts or synthetic edges to current metrics. A historical record from an already-live domain cannot boost its linking-page count or sitewide classification.

`measurement.graphPartitions` reports live, historical and unverified graph signatures. The legacy `measurement.graph` is explicitly scoped to live data; `measurement.scores.graphScope` is `live`. Full scan report version 6 and `local-current-graph-heuristic-v2` distinguish these semantics from older mixed reports, so old/new scores are not comparable. Optional evidence on legacy verified rows is not fabricated: `unattributedCurrentPairs` declares those rows. Newly fetched scan rows carry HTML evidence; known contradictory archive/provider evidence is never admitted as current.

The legacy indices combine sampled counts, DS, local graph position and chosen follow/content/risk weights. They are heuristics rather than observed authority.

**What it does not measure:** the graph is incomplete and the score is relative to this run. More coverage can increase or decrease the same target's score without its links changing. This is not Google value, a calibrated probability, or a score comparable with another provider. `measurement.scores` exposes the version, components, missing archive data and comparison key; `measurement.graph` records graph size and signature.

## Spam risk and toxicity

`score.ts` → `spamScore()`, `toxic.ts` → `domainToxicity()`

Spam scores the domain itself (TLD, name construction, anchors, title). Toxicity goes further and looks at **how** the domain links: sitewide from a footer, exclusively exact-match anchors, no topical relevance, high-risk subject matter. Verdicts: `review` (≥65, manual review — not auto-Disavow), `watch` (≥40), `ok`.

**What it does not measure:** it does not predict a penalty. It is a list for manual review — never submit a disavow file without checking it line by line.

## Keyword difficulty (0–100)

`serp-intel.ts` → `keywordDifficulty()`

Weighted strength of the domains in the top results (higher positions weigh more), adjusted for keyword length (long tail is easier) and SERP features (featured snippets and ads raise it, discussion results lower it).

**What it does not measure:** search volume or advertising competition. We have no access to volume data.

## Modelled traffic and CTR

`serp-intel.ts` → `positionCtr()`, `adjustedCtr()`

An averaged click-through curve for positions 1–20 taken from public studies, multiplied by SERP-feature coefficients (featured snippet −25%, ads −15%, knowledge panel −10%…).

**What it does not measure:** this is **not a visit count**. It is an ordering signal — it shows which position is worth how much relative to the others.

With Search Console connected, the report also states how far this curve sits from your site's measured reality (`search-console-insights.ts` → `modelAccuracy()`). Treat the modelled number with exactly as much confidence as that comparison earns.

## SERP visibility (0–100)

`keywords.ts` → `visibilityScore()`

For each keyword we take the best position across all engines, score it inversely to the position, and average over the number of keywords checked.

**What it does not measure:** it depends on the successful keyword/engine cohort, market, device and depth. Adding an engine, changing page metadata or recovering a failed query can move visibility with no ranking change for previously measured queries. `measurement.visibility` records requested and successful cohorts and failed-query coverage. A score with `measured: false` is unknown, even if the compatibility numeric value is zero. Visibility does not establish backlink causation.

## Competitor share of voice

`serp-intel.ts` → `buildSerpCompetitors()`

The sum of adjusted CTR across every appearance of a domain, divided by the sum for the whole set (target included). First position weighs many times more than tenth.

## Keyword clustering

`serp-cluster.ts` → `clusterKeywords()`

Two keywords land in the same cluster when they share **at least 3 URLs in the top 10**. This is a chosen clustering threshold; its suitability depends on the query set.

**What it does not measure:** it does not understand meaning — it relies purely on what the search engine shows.

## Footprint (0–100)

`scorecard.ts` → `buildFootprint()`

Review cues from the current verified sample: shared /24 ranges, sitewide links, anchor concentration, single-page domains and follow classifications. These rules have not been calibrated to penalty risk. Missing subnet measurements are null, not perfect diversity; no current domains means `status: "unknown"`, not low risk. Partial feature coverage is `inconclusive`. Consult `coverage` before interpreting `score`.

**What it does not measure:** a high score does not mean "you will be penalised". It indicates that chosen sample-review rules fired. Shared hosting, sector and language can explain those observations without wrongdoing.

## Anchor audit (0–100)

`toxic.ts` → `buildAnchorAudit()`

Compares the share of each anchor type against chosen review ranges (brand 30–70%, exact-match 0–12%, bare URLs 10–40%…) plus a Shannon diversity index.

The 12% exact-match line is a **heuristic review cue**, not proof that links were bought. Profiles vary by niche and language.

## Link velocity

`segments.ts` → `buildVelocity()`

Velocity is currently **unknown**. Domain archive age is not a link-acquisition date, and differences in sampled discovery counts are not dated acquisition cohorts. The compatibility numeric fields remain zero with `verdict: "unknown"`; they are not measured zero acquisition. No bought-links warning is derived from archive age. The UI, text CLI and standalone HTML show unknown and suppress acquisition/change numbers.

`domainFirstArchivedAt` describes the source domain, while `evidence.observedAt` dates the representation observed in this run. The deprecated `firstSeen` link field remains null because lifetime first observation is not established here. Archive recovery candidates retain their snapshot date in `lastSeen`. `analytics.growth` is retained for compatibility as a domain-archive-age distribution, labeled accordingly; it is not a growth chart.

## Internal structure score (0–100)

`site-audit.server.ts` → `runSiteAudit()`

Starts at 100 and subtracts for structural problems found while crawling the site itself: orphan pages with no internal links, pages four or more clicks deep, broken internal links, `noindex` pages that hold backlinks, pages with backlinks but almost no internal links, and internal links routed through redirects.

**What it does not measure:** the automatic scan has a small configured page budget (the crawler also exposes explicit bounded larger limits) and starts from the home page, so on large sites it describes the main structure rather than every page.

## Measured performance (Search Console)

`search-console-insights.ts`

Unlike everything above, these are **not estimates** — they come from the search engine's own reporting for a property you own.

- **Striking distance:** queries at positions 3.5–15 with at least 20 impressions. Upside = impressions × (CTR at position 3 − current CTR).
- **CTR anomalies:** position ≤10, at least 50 impressions, actual CTR at least 2 points below the curve and at least 5 clicks lost.
- **Decay:** at least 3 clicks lost against the previous window of equal length; flagged as `positionStable` when the position moved by less than 1.

**What it does not measure:** Search Console lags about two days, samples long-tail queries, and hides some queries entirely for privacy. The totals are real; the completeness is not guaranteed.

## Visibility index (0–100)

`scorecard.ts` → `buildScorecard()`

| Component             | Points | Source                                   |
| --------------------- | ------ | ---------------------------------------- |
| Link strength         | 25     | current sample index + referring domains |
| Profile quality       | 15     | profile health + anchor audit            |
| SERP visibility       | 25     | visibility + modelled traffic            |
| On-page and structure | 10     | landing-page audit + internal structure  |
| Safety                | 15     | toxicity + footprint (subtracted)        |
| Momentum and brand    | 10     | link velocity + brand SERP control       |

Each component exposes `status`, `availableMax` and its unchanged original `max`. The card exposes a versioned uncalibrated method, `status` and `coverage`. Missing inputs contribute zero credits and zero available points; the remaining components are **not renormalized to 100**. An unavailable on-page audit, unknown velocity or absent brand query is not a neutral or favorable measurement. Archive fallback HTML never supplies the current on-page score.

UI, CLI and HTML suppress the grade when coverage is incomplete or legacy qualification fields are absent. Legacy numeric zeros are compatibility placeholders when status is unknown/inconclusive, not measured zero risk or a fully observed poor score. Raw JSON consumers must inspect the associated status and coverage rather than interpreting those numbers alone. Full-coverage grade thresholds remain A ≥80, B ≥65, C ≥48, D ≥32, E below; the grades are still uncalibrated.

**What it does not measure:** this is an uncalibrated internal heuristic, not a progress measure. Changing discovery coverage, enrichment or keyword measurement changes its inputs. The same domain and keyword set alone do not establish comparability.

## Action plan priority

`plan.ts` → `buildActionPlan()`

`priority = impact × effort weight`, where the weight is 1.0 (low), 0.75 (medium), 0.55 (high). That is why recovering a lost link outranks expensive outreach of similar impact.

Actions derived from Search Console data carry higher impact than modelled ones, because the upside behind them is measured rather than inferred.

## Evidence, identity and coverage

Provider API assertions appear in `providerReports` as `verified: false`, `state: "reported"`, and `evidence.kind: "provider_report"`. They enter the candidate queue and count as live backlinks only after fetched HTML confirms an actual anchor. A failed or skipped fetch never upgrades a provider assertion. Archive recovery candidates use `archive_anchor`; they do not prove a live link.

Exact source-target relation IDs use `exact-http-url-v2` and ignore fragments only. Path/query case, parameter order, duplicate parameters, tracking/business parameters, protocol, www and trailing slashes remain significant. Anchor changes do not create a new pair. Raw HTML href attributes and their resolved URLs are separate evidence fields. Older IDs cannot be safely migrated from the lossy old normalized value alone.

Discovery confirmation bypasses response caches and requests revalidation; an old cached response cannot acquire a fresh observation timestamp. Exact href and document-base decoding uses the pinned runtime `entities` HTML attribute decoder, with case-sensitive named references and a single decoding pass.

`measurement` is a versioned run manifest. It separates observed pairs/domains before presentation limits from displayed pairs and omitted counts. Existing `stats` and analytics continue to describe the displayed report, not the whole web. The per-source funnel records returned candidate rows, duplicate/excluded/domain-cap/limit counts, admission, skipped waves/time, attempted and completed fetches, valid HTML, errors, confirmed pairs/domains and displayed pairs. Sources can overlap: their counts must not be added to infer unique web coverage. Counts start at candidates returned by each adapter; upstream source pagination, adapter filtering and the unknown web population are outside this denominator.

Heuristic-score comparison requires a known identical source revision, extraction/identity/domain policies, scoring version, source/budget policy, graph, all selection/analytics inputs and the exact ordered displayed/scored cohort signature. Visibility comparison requires the same successful query cohort and method. `measurementComparability` implements these conservative gates. Persisted cohort manifests support separate relation comparisons on an explicit common scope; legacy summaries without manifests cannot establish acquisition/loss or score deltas. The UI labels old aggregate history as changing discovery samples. See [evidence ledger](evidence-ledger.md).

Domain grouping uses a vendored Public Suffix List snapshot (ICANN and private rules, including wildcard/exception handling), pinned to upstream revision `3929462` dated 2026-10-07. The policy identifier records this snapshot; grouping across different policy versions requires an explicit compatibility decision. Exact URL pair identity remains separate and preserves schemes, subdomains, paths and query strings.

Ordinary scans and backlink verification have no automatic rendered-DOM fallback. The separate [isolated renderer](../renderer/README.md) requires its exact qualified runtime and brokers permitted resources through pinned DNS, SSRF/robots checks and bounded container controls. Its fixed snapshot window and blocked/pending resources remain visible. HTML absence stays scoped to fetched HTML; a rendered anchor does not establish indexability or exhaustive rendered-page absence.
