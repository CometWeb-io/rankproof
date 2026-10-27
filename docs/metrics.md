# Metric methodology

This document describes **how every number is calculated and what it does not measure**. Without that, metrics are just decorative progress bars.

Overriding principle: everything below is an approximation built from open data. Some names resemble commercial tools, but the methods differ — do not compare these values one-to-one with Ahrefs, Semrush or Majestic.

---

## Domain score (DS, 0–100)

`src/lib/backlinks/score.ts` → `domainScore()`

Built from: the top-level domain (government and education rank higher, risky TLDs lower), age in the Internet Archive, presence in Wikipedia, number of linking pages, HTTPS, and penalties for name construction (many hyphens, long digit strings, deep subdomains).

**What it does not measure:** real traffic, or authority in Google's eyes. It is a heuristic for ordering a list, not an oracle.

## Domain Rating and URL Rating

`src/lib/backlinks/graph.ts`

PageRank computed over **the domain graph discovered during this scan**, rescaled to 0–100. The more strong domains link in, the higher the value.

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

Two keywords land in the same cluster when they share **at least 3 URLs in the top 10**. This is the industry-standard threshold: lower merges unrelated topics, higher splits genuine clusters.

**What it does not measure:** it does not understand meaning — it relies purely on what the search engine shows.

## Footprint (0–100)

`scorecard.ts` → `buildFootprint()`

Concentration of domains in a single /24 subnet, share of sitewide links, excess exact-match anchors, domains linking from a single page, suspicious absence of nofollow.

**What it does not measure:** a high score does not mean "you will be penalised". It means the profile deviates from natural dispersion and it is worth knowing why.

## Anchor audit (0–100)

`toxic.ts` → `buildAnchorAudit()`

Compares the share of each anchor type against natural-profile ranges (brand 30–70%, exact-match 0–12%, bare URLs 10–40%…) plus a Shannon diversity index.

The 12% exact-match line is a **heuristic review cue**, not proof that links were bought. Profiles vary by niche and language.

## Link velocity

`segments.ts` → `buildVelocity()`

Velocity is currently **unknown**. Domain archive age is not a link-acquisition date, and differences in sampled discovery counts are not dated acquisition cohorts. The compatibility numeric fields remain zero with `verdict: "unknown"`; they are not measured zero acquisition. No bought-links warning is derived from archive age. The UI, text CLI and standalone HTML show unknown and suppress acquisition/change numbers.

`domainFirstArchivedAt` describes the source domain, while `evidence.observedAt` dates the representation observed in this run. The deprecated `firstSeen` link field remains null because lifetime first observation is not established here. Archive recovery candidates retain their snapshot date in `lastSeen`. `analytics.growth` is retained for compatibility as a domain-archive-age distribution, labeled accordingly; it is not a growth chart.

## Internal structure score (0–100)

`site-audit.server.ts` → `runSiteAudit()`

Starts at 100 and subtracts for structural problems found while crawling the site itself: orphan pages with no internal links, pages four or more clicks deep, broken internal links, `noindex` pages that hold backlinks, pages with backlinks but almost no internal links, and internal links routed through redirects.

**What it does not measure:** the crawl is capped (about 120 pages) and starts from the home page, so on large sites it describes the main structure rather than every page.

## Measured performance (Search Console)

`search-console-insights.ts`

Unlike everything above, these are **not estimates** — they come from the search engine's own reporting for a property you own.

- **Striking distance:** queries at positions 3.5–15 with at least 20 impressions. Upside = impressions × (CTR at position 3 − current CTR).
- **CTR anomalies:** position ≤10, at least 50 impressions, actual CTR at least 2 points below the curve and at least 5 clicks lost.
- **Decay:** at least 3 clicks lost against the previous window of equal length; flagged as `positionStable` when the position moved by less than 1.

**What it does not measure:** Search Console lags about two days, samples long-tail queries, and hides some queries entirely for privacy. The totals are real; the completeness is not guaranteed.

## Visibility index (0–100)

`scorecard.ts` → `buildScorecard()`

| Component             | Points | Source                                  |
| --------------------- | ------ | --------------------------------------- |
| Link strength         | 25     | DR + number of referring domains        |
| Profile quality       | 15     | profile health + anchor audit           |
| SERP visibility       | 25     | visibility + modelled traffic           |
| On-page and structure | 10     | landing-page audit + internal structure |
| Safety                | 15     | toxicity + footprint (subtracted)       |
| Momentum and brand    | 10     | link velocity + brand SERP control      |

Grades: A ≥80, B ≥65, C ≥48, D ≥32, E below.

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
