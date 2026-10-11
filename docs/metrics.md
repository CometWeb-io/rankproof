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

**What it does not measure:** the graph is incomplete — it covers only what we found and verified. For large sites the value will be understated.

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

**What it does not measure:** it depends directly on which keywords went into the measurement. Change the keyword set and the result changes — only compare scans of the same domain with the same set.

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

New domains in the last 12 months versus the 12 before, based on when each domain was first seen in the Internet Archive. With too few dates it falls back to scan history.

**What it does not measure:** the archive does not know the age of most small domains. For young sites the result is often unusable — which is why a `no-data` verdict exists.

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

**What it does not measure:** this is an **internal index, comparable between scans of the same domain**. Comparing two different sites only makes sense with the same keyword set and market.

## Action plan priority

`plan.ts` → `buildActionPlan()`

`priority = impact × effort weight`, where the weight is 1.0 (low), 0.75 (medium), 0.55 (high). That is why recovering a lost link outranks expensive outreach of similar impact.

Actions derived from Search Console data carry higher impact than modelled ones, because the upside behind them is measured rather than inferred.

## Confirmed lost backlinks versus unobserved links

An archived backlink is **not** automatically a lost backlink. RankProof only marks it lost after retrieving readable current HTML from the original source URL and confirming that no target-domain anchor remains. A 403, 429, network timeout, inaccessible page or very short response is **unknown**, not a lost link. An archived snapshot is historical evidence (`evidenceKind=archived-html`) and is not falsely presented as a currently verified backlink. Quick scans skip this extra network-intensive confirmation.

## Comparison of bounded scans (report format 7)

`scopeKey` describes profile, market, device, search engines and keywords, source health, crawl inclusion and scan caps. Persisted scan history stores the same scope in `scan_history.scan_scope`. The web and database diff return **no delta** for incompatible or legacy records. In a comparable scan, a link missing from the newly sampled results is counted as `notRediscoveredLinks`, **not** as a confirmed lost backlink (`lostLinks`). Real lost links require the separately verified archive-versus-live process. Cross-scan metrics can still fluctuate with a changing live index or adaptive time budget; compare trends as observed samples rather than census estimates.

## Coverage and censored counts

Reports include `coverage` with `sourceCandidates`, `reportedLinks`, `htmlVerified`, `apiObserved`, `archiveConfirmedLost` and `truncated`. The `completeness` marker is always `bounded-sample`. Discovery is not an exhaustive external link index, even when `truncated=false`: source blocks, search-engine indexes and page caps impose unseen-link uncertainty. The report headline link/domain totals describe only the retained sample. A scan where the retained set was truncated is not directly comparable to a non-truncated scan.

## Page URL versus domain scope (report format 8)

Passing `https://example.com/product?sku=A` now preserves the requested URL and adds an independent `requestedPage` HTML/on-page result. The backlink, SERP, link graph and site-wide score remain at the domain level. An inaccessible page is reported as `requestedPage.error`, not as a successful negative SEO diagnosis. This adds one HTML request only when the user specified a non-homepage path/query. Different requested pages have different scan scope fingerprints.

## Truncated page evidence

A bounded response sets `FetchResult.truncated` whenever the byte or useful-HTML limit ends the read before the response is complete. Truncated HTTP bodies are **not cached** as complete evidence. An incomplete source cannot be used as a confirmed unlinked-brand mention or to prove an archived backlink was removed. An explicitly requested subpage that exceeds its measurement limit yields an unknown/error state rather than an on-page score.

## Scope-consistent historical trends and rank moves

Persistent charts and before/after deltas now query only rows with the **same scan scope key**. Previously, a newer scan in a different market, profile or keyword set could hide an older comparable scan, and mixed scopes could appear on the same trend chart. Rank positions are stored and compared by collection scope; legacy position records without that key are not interpreted as rank moves. The local browser history retains separate entries for different scopes of the same host (within its 12-entry cap).

A source article redirecting to a different final URL (such as a homepage, login page or replacement article) cannot by itself establish that a backlink was **removed** from the original article. Link-loss confirmation therefore requires the readable current page to retain the original page identity. An unresolved redirect yields an unknown observation instead of a recovery recommendation.

Historical 'new link' identifiers are compared **within the same persisted sample cap**. The database stores at most 800 link IDs and local browser history stores at most 500; comparing additional unsaved IDs used to produce false 'new links' for every repeat scan in deep mode. Values outside the stored sample are neither confirmed new nor lost.

Rank movement requires a **successfully measured SERP**. Missing keyword rows, blocked search engines and timeouts do not constitute evidence of a ranking drop. Only `ok` and `no-results` records enter the persistent position history; an absent keyword is never automatically marked lost. A `lost` rank move means outside the checked result window in a completed measurement, not proof that the page disappeared from the search index.
