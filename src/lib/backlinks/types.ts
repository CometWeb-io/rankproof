export type LinkRel = "dofollow" | "nofollow" | "sponsored" | "ugc";

export type DiscoverySource =
  | "wikipedia"
  | "hacker-news"
  | "reddit"
  | "bluesky"
  | "stackexchange"
  | "bing"
  | "duckduckgo"
  | "mojeek"
  | "news"
  | "urlscan"
  | "github"
  | "commoncrawl"
  | "graph"
  | "sitemap"
  | "archive"
  | "lookup"
  | "page";

export type SourceStatus = "ok" | "empty" | "error" | "skipped";

/** Where in the document the link was found — this decides its real value. */
export type LinkPlacement = "content" | "navigation" | "footer" | "sidebar" | "comment" | "unknown";

/** Anchor type — the basis of the profile naturalness audit. */
export type AnchorType =
  | "brand"
  | "exact-match"
  | "url"
  | "generic"
  | "image"
  | "empty"
  | "long-tail";

export type LinkFlag =
  | "broken-target"
  | "noindex-source"
  | "page-level-nofollow"
  | "boilerplate"
  | "sitewide"
  | "spam-risk"
  | "high-authority"
  | "image-link"
  | "lost"
  | "reciprocal"
  | "redirected-target"
  | "off-topic"
  | "serp-coranker";

export type Backlink = {
  /** Stable record identifier (host + path + target + anchor). */
  id: string;
  sourceUrl: string;
  sourceHost: string;
  /** Registrable domain (eTLD+1) — used to count referring domains. */
  sourceDomain: string;
  sourceTitle: string;
  sourceLang: string | null;
  targetUrl: string;
  targetPath: string;
  anchor: string;
  anchorType: AnchorType;
  rel: LinkRel;
  /** false, gdy strona ma meta robots nofollow/noindex albo rel != dofollow. */
  effectiveFollow: boolean;
  placement: LinkPlacement;
  /** A link repeated across many pages of the same domain. */
  sitewide: boolean;
  discoveredVia: DiscoverySource;
  wikiLang?: string;
  verified: boolean;
  /** First sighting of the source page in the Internet Archive (YYYY-MM-DD). */
  firstSeen: string | null;
  httpStatus: number | null;
  /** Status of the target URL — reveals broken backlinks. */
  targetStatus: number | null;
  /** 0–100, quality of the referring domain (an authority proxy). */
  domainScore: number;
  /** 0–100, spam risk. */
  spamScore: number;
  /** 0–100, topical relevance of the source page to the target. */
  relevance: number;
  /** Final target URL after redirects (when different from the linked one). */
  targetFinalUrl: string | null;
  /** live = confirmed now, lost = present in the archive but gone today. */
  state: LinkState;
  /** Date of the last confirmation (archive) for lost links. */
  lastSeen: string | null;
  flags: LinkFlag[];
};

export type LinkState = "live" | "lost";

export type Mention = {
  sourceUrl: string;
  sourceHost: string;
  sourceDomain: string;
  sourceTitle: string;
  snippet: string;
  discoveredVia: DiscoverySource;
  /** True when the page mentions the brand without linking — a recovery opportunity. */
  linkOpportunity: boolean;
};

export type SourceReport = {
  id: string;
  label: string;
  status: SourceStatus;
  found: number;
  ms: number;
  detail?: string;
};

export type SiteSnapshot = {
  host: string;
  domain: string;
  url: string;
  title: string | null;
  description: string | null;
  lang: string | null;
  status: number | null;
  https: boolean;
  canonical: string | null;
  robotsNoindex: boolean;
  archivedAt: string | null;
  archiveFirstSeen: string | null;
  archiveUrl: string | null;
  parked: boolean;
  redirectHost: string | null;
  usedArchive: boolean;
  subdomains: string[];
  sitemapUrls: number;
  indexedPages: number;
  /** Domain Rating proxy (0–100) computed from the discovered link graph. */
  domainRating: number;
  /** Number of domains the target itself links out to. */
  outboundDomains: number;
};

export type ReferringDomain = {
  domain: string;
  links: number;
  pages: number;
  dofollow: number;
  contentLinks: number;
  domainScore: number;
  spamScore: number;
  tld: string;
  firstSeen: string | null;
  sources: DiscoverySource[];
  sampleUrl: string;
  sampleAnchor: string;
  sitewide: boolean;
  /** Rank from PageRank computed over the discovered domain graph (0-100). */
  rank: number;
  ips: string[];
  subnet: string | null;
  lostLinks: number;
  reciprocal: boolean;
  /** Average topical relevance of links from this domain (0–100). */
  relevance: number;
};

export type TargetPageStat = {
  path: string;
  url: string;
  /** URL Rating equivalent: the strength of a specific page. */
  urlRating: number;
  links: number;
  domains: number;
  dofollow: number;
  bestDomainScore: number;
  status: number | null;
};

export type OutboundDomain = {
  domain: string;
  links: number;
  reciprocal: boolean;
  sampleUrl: string;
  /** HTTP status of a sample URL — detects broken outbound links. */
  status: number | null;
};

export type LinkGapDomain = {
  domain: string;
  domainScore: number;
  /** 0–100: how many competitors have this link × domain quality. */
  priority: number;
  /** Competitors that have a link from this domain. */
  competitors: string[];
  sampleUrl: string;
  dofollow: boolean;
};

export type LinkGapReport = {
  target: string;
  competitors: {
    host: string;
    referringDomains: number;
    backlinks: number;
    domainRating: number;
    error?: string;
  }[];
  shared: string[];
  gap: LinkGapDomain[];
  unique: string[];
  queriedAt: string;
};

export type AnchorStat = {
  text: string;
  type: AnchorType;
  count: number;
  domains: number;
  share: number;
};

export type CountStat = { key: string; count: number; share: number };

export type Issue = {
  id: string;
  severity: "high" | "medium" | "low" | "info";
  title: string;
  detail: string;
  count: number;
  samples: string[];
};

export type HealthScore = {
  total: number;
  grade: "A" | "B" | "C" | "D" | "E";
  parts: {
    key: string;
    label: string;
    score: number;
    max: number;
    hint: string;
  }[];
};

export type Analytics = {
  referringDomains: ReferringDomain[];
  anchors: AnchorStat[];
  anchorTypes: CountStat[];
  placements: CountStat[];
  rels: CountStat[];
  tlds: CountStat[];
  languages: CountStat[];
  sources: CountStat[];
  topTargetPages: CountStat[];
  /** Distribution of referring domains by first sighting in the archive (by year). */
  growth: CountStat[];
  targetPages: TargetPageStat[];
  outbound: OutboundDomain[];
  issues: Issue[];
  health: HealthScore;
};

/* ------------------------------------------------------------------ */
/* SERP / keywords / on-page                                     */
/* ------------------------------------------------------------------ */

export type SerpEngine = "bing" | "duckduckgo" | "mojeek" | "brave" | "google";

/** Measurement market — the country and language positions are checked in. */
export type SerpMarket = "pl" | "us" | "gb" | "de" | "fr" | "es";

/** Device: a mobile SERP is often shorter and arranged differently. */
export type SerpDevice = "desktop" | "mobile";

/**
 * Why a SERP query returned what it returned. Distinguishing a real empty
 * result from a block is the difference between "you rank nowhere" and
 * "we could not measure".
 */
export type SerpStatus =
  | "ok"
  | "no-results"
  | "blocked"
  | "rate-limited"
  | "parser-failed"
  | "empty-response"
  | "not-configured"
  | "error";

/** SERP elements other than the ten blue links — they take CTR away. */
export type SerpFeature =
  | "featured"
  | "paa"
  | "knowledge"
  | "news"
  | "video"
  | "images"
  | "ads"
  | "shopping"
  | "local"
  | "sitelinks"
  | "discussions";

/** Keyword intent — it decides whether the keyword is worth fighting for. */
export type KeywordIntent =
  | "brand"
  | "informational"
  | "commercial"
  | "transactional"
  | "navigational"
  | "local";

export type SerpHit = {
  position: number;
  url: string;
  host: string;
  domain: string;
  title: string;
  snippet: string;
  isTarget: boolean;
  /** 0–100, strength of the result's domain — the basis of keyword difficulty. */
  domainScore: number;
  /** Estimated share of clicks for this position (0–100). */
  ctr: number;
};

export type SerpQuery = {
  keyword: string;
  engine: SerpEngine;
  /** 1–10, null = the target is outside this engine's top 10. */
  targetPosition: number | null;
  results: SerpHit[];
  features: SerpFeature[];
  /** Related searches from the bottom of the SERP. */
  related: string[];
  /** Questions ("people also ask") — ready-made H2 headings. */
  questions: string[];
  /** How many results were actually checked (10 = one page, 20 = two pages). */
  depth: number;
  /** 0–100: how strong the domains holding the top are — a Keyword Difficulty proxy. */
  difficulty: number;
  market: SerpMarket;
  device: SerpDevice;
  status: SerpStatus;
  ms: number;
};

/** A domain that regularly ranks for the same keywords as the target. */
export type SerpCompetitor = {
  domain: string;
  host: string;
  /** How many times it appeared across the checked SERPs. */
  appearances: number;
  /** Across how many distinct keywords. */
  keywords: number;
  bestPosition: number;
  avgPosition: number;
  /** 0–100, share of visibility across the checked keyword set. */
  shareOfVoice: number;
  /** 0–100, how many of the target's keywords this domain covers. */
  overlap: number;
  domainScore: number;
  sampleUrl: string;
  sampleKeyword: string;
  /** True when this domain already links to the target. */
  linksToTarget: boolean;
};

/** Two URLs from the same site on one query — a search-intent overlap. */
export type Cannibalization = {
  keyword: string;
  engine: SerpEngine;
  urls: { url: string; position: number }[];
};

export type RankMoveState = "up" | "down" | "new" | "lost" | "stable";

/** Position change relative to the previous scan. */
export type RankMove = {
  keyword: string;
  engine: SerpEngine;
  previous: number | null;
  current: number | null;
  /** Dodatnie = awans (np. z 8 na 3 daje +5). */
  change: number | null;
  state: RankMoveState;
};

/** A keyword idea from search-engine autocomplete — no API, no fees. */
export type KeywordIdea = {
  keyword: string;
  source: "autocomplete" | "related" | "question" | "modifier";
  seed: string;
  /** 0–100 priority: length, intent and how many sources suggested it. */
  score: number;
  intent: KeywordIntent;
  words: number;
};

export type KeywordSource = "title" | "h1" | "meta" | "content" | "anchor" | "brand";

export type KeywordStat = {
  keyword: string;
  source: KeywordSource;
  /** Frequency / weight of the keyword on the page and in anchors. */
  weight: number;
  bestPosition: number | null;
  engines: { engine: SerpEngine; position: number | null }[];
  /** Sum of scores for domains linking with this anchor. */
  linkEquity: number;
  matchingAnchors: number;
  /** 0–100, strength of the top results for this keyword (a Keyword Difficulty proxy). */
  difficulty: number;
  /** Estimated traffic share from the current position (0–100). */
  trafficShare: number;
  intent: KeywordIntent;
  /** 0–100: upside potential (low position combined with existing links). */
  opportunity: number;
};

export type ProspectReason = "serp-coranker" | "unlinked-mention" | "lost-link";

export type SerpProspect = {
  url: string;
  host: string;
  domain: string;
  title: string;
  keyword: string;
  position: number | null;
  engine: SerpEngine | null;
  reason: ProspectReason;
  domainScore: number;
  snippet: string;
  /** 0–100: how worthwhile sending an email here actually is. */
  priority: number;
  /** Guessed contact-page URL for outreach. */
  contactUrl: string | null;
};

export type OnPageAudit = {
  title: string | null;
  titleLength: number;
  description: string | null;
  descriptionLength: number;
  h1: string[];
  h2: string[];
  canonical: string | null;
  canonicalOk: boolean;
  robotsNoindex: boolean;
  ogTitle: string | null;
  ogImage: boolean;
  schemaTypes: string[];
  wordCount: number;
  internalLinks: number;
  externalLinks: number;
  https: boolean;
  lang: string | null;
  issues: Issue[];
  score: number;
};

export type SerpSnapshot = {
  queries: SerpQuery[];
  visibility: number;
  ranked: number;
  top3: number;
  top10: number;
  /** Average position across keywords the target ranks for at all. */
  avgPosition: number;
  /** Sum of estimated CTR shares — a proxy for organic traffic. */
  trafficScore: number;
  engines: SerpEngine[];
  competitors: SerpCompetitor[];
  cannibalization: Cannibalization[];
  /** Per-engine health so a silent block never reads as "no visibility". */
  engineHealth: { engine: SerpEngine; status: SerpStatus; queries: number; hits: number }[];
  moves: RankMove[];
  market: SerpMarket;
  device: SerpDevice;
  clusters: KeywordCluster[];
  contentGaps: ContentGapTerm[];
  featured: FeaturedOpportunity[];
  buckets: PositionBucket[];
  consensus: EngineConsensus[];
  /** Related keywords and questions gathered from every SERP. */
  related: string[];
  questions: string[];
};

/* ------------------------------------------------------------------ */
/* Keyword clusters, content gaps and featured-snippet opportunities                   */
/* ------------------------------------------------------------------ */

/** A group of keywords the search engine answers with the same set of pages. */
export type KeywordCluster = {
  id: string;
  /** The keyword representing the cluster (strongest / shortest). */
  head: string;
  keywords: string[];
  /** URLs recurring in the top results of every keyword in the cluster. */
  sharedUrls: string[];
  /** How many URLs they share — the strength of the connection. */
  overlap: number;
  difficulty: number;
  intent: KeywordIntent;
  bestPosition: number | null;
  /** "one-page" = a single page serves the whole cluster, "split" = separate pages. */
  strategy: "one-page" | "split";
  hint: string;
};

/** A term that recurs among competitors and is missing from the target. */
export type ContentGapTerm = {
  term: string;
  /** On how many competitor pages it appears. */
  competitorPages: number;
  /** Share of competitor pages containing the term (0–100). */
  coverage: number;
  onTarget: boolean;
  keywords: string[];
};

/** A keyword where a featured snippet or question block can be taken. */
export type FeaturedOpportunity = {
  keyword: string;
  engine: SerpEngine;
  position: number;
  feature: SerpFeature;
  questions: string[];
  hint: string;
};

export type PositionBucket = { label: string; count: number; share: number };

/** Agreement between engines on the target's position — a stability measure. */
export type EngineConsensus = {
  keyword: string;
  positions: { engine: SerpEngine; position: number | null }[];
  spread: number;
  stable: boolean;
};

/* ------------------------------------------------------------------ */
/* Site audit — internal linking and technical hygiene                 */
/* ------------------------------------------------------------------ */

export type InternalPage = {
  url: string;
  path: string;
  title: string | null;
  status: number;
  /** Clicks from the home page. */
  depth: number;
  inboundLinks: number;
  outboundLinks: number;
  externalLinks: number;
  noindex: boolean;
  canonical: string | null;
  /** External backlinks pointing at this page. */
  backlinks: number;
  redirected: boolean;
};

export type SiteIssue = {
  id: string;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  count: number;
  samples: string[];
};

export type SiteAudit = {
  /** `failed` when the crawl threw or returned nothing usable — never silent null. */
  status?: "ok" | "failed";
  crawled: number;
  avgDepth: number;
  avgInboundLinks: number;
  maxDepth: number;
  /** Inventory URLs (sitemap / known) not reached from the homepage link graph. */
  orphans: number;
  brokenInternal: number;
  redirectedInternal: number;
  noindexPages: number;
  pages: InternalPage[];
  issues: SiteIssue[];
  /** 0–100 for internal structure health. */
  score: number;
};

/* ------------------------------------------------------------------ */
/* Search Console / Bing Webmaster — real owner-level data             */
/* ------------------------------------------------------------------ */

export type SearchConsoleSource = "google" | "bing";

export type SearchConsoleRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  /** Percentage, 0–100. */
  ctr: number;
  position: number;
};

export type SearchConsoleData = {
  source: SearchConsoleSource;
  connected: boolean;
  property: string | null;
  error: string | null;
  days: number;
  queries: SearchConsoleRow[];
  pages: SearchConsoleRow[];
  /** Same window, shifted back — used for real movement. */
  previousQueries: SearchConsoleRow[];
  totals: { clicks: number; impressions: number; ctr: number; position: number };
};

export type StrikingQuery = SearchConsoleRow & {
  query: string;
  /** Extra clicks available if the query reached position 3. */
  potentialClicks: number;
};

export type CtrAnomaly = {
  query: string;
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
  expectedCtr: number;
  gap: number;
  lostClicks: number;
};

export type DecayingQuery = {
  query: string;
  clicks: number;
  previousClicks: number;
  clickDelta: number;
  position: number;
  positionDelta: number;
  /** True when clicks fell but the position did not. */
  positionStable: boolean;
};

export type PositionComparison = {
  query: string;
  google: number;
  measured: number;
  gap: number;
  impressions: number;
};

export type SearchConsoleInsights = {
  connected: boolean;
  providers: SearchConsoleData[];
  striking: StrikingQuery[];
  ctrAnomalies: CtrAnomaly[];
  decaying: DecayingQuery[];
  comparison: PositionComparison[];
  /** How far our CTR model sits from this site's measured reality. */
  accuracy: {
    samples: number;
    meanAbsoluteError: number;
    bias: number;
    verdict: "close" | "optimistic" | "pessimistic" | "unknown";
  };
  hint: string;
};

/* ------------------------------------------------------------------ */
/* Brand SERP, footprint and visibility index                          */
/* ------------------------------------------------------------------ */

/** A result on the brand SERP that does not belong to you. */
export type BrandSerpResult = {
  url: string;
  domain: string;
  title: string;
  position: number;
  owned: boolean;
  /** Recognised type: social profile, directory, reviews, competitor. */
  kind: "profile" | "reviews" | "directory" | "media" | "competitor" | "other";
  /** True when the title or description suggests negative content. */
  risky: boolean;
};

/**
 * An audit of the SERP for your brand name — what someone who already knows
 * you sees. Controlling that first page is a separate goal from keyword traffic.
 */
export type BrandSerp = {
  keyword: string;
  engine: SerpEngine | null;
  /** 0–100: share of results you control. */
  control: number;
  owned: number;
  thirdParty: number;
  risky: number;
  results: BrandSerpResult[];
  hint: string;
};

/** A pattern that reveals an artificially built link profile. */
export type FootprintRisk = {
  /** 0–100, higher is worse. */
  score: number;
  /** Share of domains in the largest /24 subnet (0–100). */
  topSubnetShare: number;
  subnetDiversity: number;
  sitewideShare: number;
  exactAnchorShare: number;
  /** Domains that link from a single page only. */
  singlePageDomains: number;
  reasons: string[];
  verdict: "low" | "medium" | "high";
};

/**
 * One headline metric instead of five separate ones — it combines link
 * strength, visibility, page readiness and risk on a 0–100 scale.
 */
export type Scorecard = {
  index: number;
  grade: "A" | "B" | "C" | "D" | "E";
  parts: { key: string; label: string; score: number; max: number; hint: string }[];
  /** The largest point loss — the first thing to fix. */
  weakest: string;
};

/* ------------------------------------------------------------------ */
/* Domain segments, momentum and the action plan                           */
/* ------------------------------------------------------------------ */

export type DomainSegment =
  | "media"
  | "blog"
  | "forum"
  | "edu-gov"
  | "directory"
  | "social"
  | "shop"
  | "company"
  | "code"
  | "other";

export type SegmentStat = {
  segment: DomainSegment;
  domains: number;
  links: number;
  share: number;
  avgDomainScore: number;
  /** Recommended share within a healthy profile (0–100). */
  target: number;
  verdict: "ok" | "low" | "high";
};

/** Link acquisition momentum — pace and direction. */
export type LinkVelocity = {
  /** New domains in the last 12 months (from the archive). */
  last12m: number;
  /** Average number of new domains per month over that period. */
  perMonth: number;
  /** Change in pace versus the earlier period, as a percentage. */
  trend: number;
  lostRatio: number;
  verdict: "growing" | "stable" | "declining" | "unknown";
  hint: string;
};

export type ActionArea = "serp" | "content" | "links" | "risk" | "on-page";
export type ActionEffort = "low" | "medium" | "high";

/** A single action-plan item — a concrete "what to do tomorrow". */
export type ActionItem = {
  id: string;
  area: ActionArea;
  title: string;
  detail: string;
  /** 0–100, estimated impact on visibility. */
  impact: number;
  effort: ActionEffort;
  /** 0–100, execution order: impact weighted against effort. */
  priority: number;
  samples: string[];
};

export type ActionPlan = {
  items: ActionItem[];
  quickWins: number;
  /** 0–100, how much of the recommended state is already achieved. */
  coverage: number;
};

/* ------------------------------------------------------------------ */
/* Profile toxicity and anchors                                       */
/* ------------------------------------------------------------------ */

export type ToxicVerdict = "review" | "watch" | "ok";

export type ToxicDomain = {
  domain: string;
  links: number;
  /** 0–100, composite risk: spam + anchors + placement + missing topical fit. */
  toxicity: number;
  spamScore: number;
  domainScore: number;
  relevance: number;
  verdict: ToxicVerdict;
  reasons: string[];
  sampleUrl: string;
  sitewide: boolean;
};

export type ToxicReport = {
  domains: ToxicDomain[];
  disavowCount: number;
  watchCount: number;
  toxicLinks: number;
  /** 0–100, average profile toxicity (lower is better). */
  avgToxicity: number;
};

export type AnchorRisk = {
  type: AnchorType;
  share: number;
  min: number;
  max: number;
  verdict: "ok" | "low" | "high";
  hint: string;
};

export type AnchorAudit = {
  risks: AnchorRisk[];
  /** Individual anchors with an unnaturally large share. */
  overOptimized: { text: string; share: number; domains: number }[];
  /** 0–100, anchor diversity (a rescaled Shannon index). */
  diversity: number;
  score: number;
};

export type ScanStats = {
  backlinks: number;
  referringDomains: number;
  dofollow: number;
  nofollow: number;
  mentions: number;
  pagesCrawled: number;
  candidatesChecked: number;
  brokenLinks: number;
  sitewideLinks: number;
  contentLinks: number;
  spamDomains: number;
  authorityDomains: number;
  uniqueAnchors: number;
  avgDomainScore: number;
  avgRelevance: number;
  domainRating: number;
  redirectedLinks: number;
  brokenOutbound: number;
  referringIps: number;
  referringSubnets: number;
  lostLinks: number;
  outboundDomains: number;
  reciprocalDomains: number;
  durationMs: number;
  serpVisibility: number;
  rankedKeywords: number;
  onPageScore: number;
  prospects: number;
  /** Szacowany ruch organiczny (suma CTR na sprawdzonych frazach). */
  serpTraffic: number;
  /** Number of domains recommended for disavowal. */
  toxicDomains: number;
  /** 0–100, quality of the anchor distribution. */
  anchorScore: number;
  /** Domains co-ranking on the target's keywords. */
  serpCompetitors: number;
  /** Topic clusters detected through SERP overlap. */
  keywordClusters: number;
  /** New referring domains per month (last 12 months). */
  linkVelocity: number;
  /** Tasks in the action plan. */
  actions: number;
  /** The headline visibility index (0–100). */
  visibilityIndex: number;
  /** Link profile footprint risk (0–100). */
  footprintRisk: number;
  /** Control over the brand SERP (0–100). */
  brandControl: number;
  /** Internal structure score from the site audit (0–100). */
  siteHealth: number;
  /** Pages crawled during the internal audit. */
  internalPages: number;
  /** Clicks reported by connected search-engine accounts. */
  realClicks: number;
};

export type ScanReport = {
  version: number;
  queriedAt: string;
  input: string;
  target: SiteSnapshot;
  sources: SourceReport[];
  backlinks: Backlink[];
  mentions: Mention[];
  stats: ScanStats;
  analytics: Analytics;
  notes: string[];
  /** Scan history for this domain (from the database, when available). */
  trend: TrendPoint[];
  /** Comparison with the previous scan, computed server-side. */
  delta: ScanDelta | null;
  /** Whether the report was written to persistent history. */
  persisted: boolean;
  serp: SerpSnapshot;
  keywords: KeywordStat[];
  prospects: SerpProspect[];
  onPage: OnPageAudit | null;
  toxic: ToxicReport;
  anchorAudit: AnchorAudit;
  segments: SegmentStat[];
  velocity: LinkVelocity;
  plan: ActionPlan;
  brandSerp: BrandSerp | null;
  footprint: FootprintRisk;
  scorecard: Scorecard;
  /** Owner-level performance data, when an account is connected. */
  searchConsole: SearchConsoleInsights | null;
  siteAudit: SiteAudit | null;
};

export type ScanResult = { ok: true; report: ScanReport } | { ok: false; error: string };

export type TrendPoint = {
  at: string;
  backlinks: number;
  referringDomains: number;
  domainRating: number;
  health: number;
  visibility: number;
};

export type ScanDelta = {
  previousAt: string;
  newLinks: number;
  lostLinks: number;
  newDomains: string[];
  lostDomains: string[];
  backlinkDelta: number;
  domainDelta: number;
  healthDelta: number;
  ratingDelta: number;
  visibilityDelta: number;
  /** Identifiers of links absent from the previous scan. */
  newIds: string[];
};

export type GapResult = { ok: true; report: LinkGapReport } | { ok: false; error: string };

export type SerpCheckResult =
  | { ok: true; snapshot: SerpSnapshot; keywords: KeywordStat[] }
  | { ok: false; error: string };

export type SuggestResult =
  | { ok: true; ideas: KeywordIdea[]; seeds: string[]; ms: number }
  | { ok: false; error: string };
