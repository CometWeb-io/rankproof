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

| Component | Points | Source |
| --- | --- | --- |
| Link strength | 25 | DR + number of referring domains |
| Profile quality | 15 | profile health + anchor audit |
| SERP visibility | 25 | visibility + modelled traffic |
| On-page and structure | 10 | landing-page audit + internal structure |
| Safety | 15 | toxicity + footprint (subtracted) |
| Momentum and brand | 10 | link velocity + brand SERP control |

Grades: A ≥80, B ≥65, C ≥48, D ≥32, E below.

**What it does not measure:** this is an **internal index, comparable between scans of the same domain**. Comparing two different sites only makes sense with the same keyword set and market.

## Action plan priority

`plan.ts` → `buildActionPlan()`

`priority = impact × effort weight`, where the weight is 1.0 (low), 0.75 (medium), 0.55 (high). That is why recovering a lost link outranks expensive outreach of similar impact.

Actions derived from Search Console data carry higher impact than modelled ones, because the upside behind them is measured rather than inferred.
