import type {
  ActionEffort,
  BrandSerp,
  SearchConsoleInsights,
  SiteAudit,
  ActionItem,
  ActionPlan,
  AnchorAudit,
  Analytics,
  FeaturedOpportunity,
  KeywordCluster,
  KeywordStat,
  LinkVelocity,
  OnPageAudit,
  ScanStats,
  SegmentStat,
  SerpProspect,
  SerpSnapshot,
  ToxicReport,
} from "./types.ts";
import { plural } from "./text.ts";

const EFFORT_WEIGHT: Record<ActionEffort, number> = {
  low: 1,
  medium: 0.75,
  high: 0.55,
};

function action(
  item: Omit<ActionItem, "priority"> & { priority?: number },
): ActionItem {
  return {
    ...item,
    priority: Math.max(
      1,
      Math.min(100, Math.round(item.impact * EFFORT_WEIGHT[item.effort])),
    ),
  };
}

export type PlanInput = {
  host: string;
  stats: Pick<ScanStats, "backlinks" | "brokenLinks">;
  analytics: Analytics;
  serp: SerpSnapshot;
  keywords: KeywordStat[];
  clusters: KeywordCluster[];
  featured: FeaturedOpportunity[];
  prospects: SerpProspect[];
  toxic: ToxicReport;
  anchorAudit: AnchorAudit;
  segments: SegmentStat[];
  velocity: LinkVelocity;
  brandSerp?: BrandSerp | null;
  onPage: OnPageAudit | null;
  siteAudit?: SiteAudit | null;
  searchConsole?: SearchConsoleInsights | null;
};

/**
 * Turns the whole report into one ordered task list. Priority is impact
 * weighted against effort, so cheap and effective work rises to the top
 * (recovering a lost link, an unlinked mention, a keyword just outside the top 3),
 * a nie te najbardziej efektowne.
 */
export function buildActionPlan(input: PlanInput): ActionPlan {
  const items: ActionItem[] = [];

  /* --- Szybkie wzrosty w SERP-ie ------------------------------------- */

  const striking = input.keywords
    .filter((row) => row.bestPosition !== null && row.bestPosition >= 4 && row.bestPosition <= 12)
    .sort((a, b) => (a.bestPosition ?? 99) - (b.bestPosition ?? 99));
  if (striking.length > 0) {
    items.push(
      action({
        id: "striking-distance",
        area: "serp",
        title: `${plural(striking.length, "keyword")} just outside the top`,
        detail:
          "These sit at positions 4–12. Reaching the top three yields several times more clicks than new content from scratch — expand the existing page and point 2–3 strong links at it.",
        impact: 88,
        effort: "medium",
        samples: striking.slice(0, 5).map((row) => `${row.keyword} (#${row.bestPosition})`),
      }),
    );
  }

  const easyWins = input.keywords
    .filter((row) => row.difficulty > 0 && row.difficulty <= 35 && (row.bestPosition ?? 99) > 10)
    .sort((a, b) => a.difficulty - b.difficulty);
  if (easyWins.length > 0) {
    items.push(
      action({
        id: "low-difficulty",
        area: "content",
        title: `${plural(easyWins.length, "easy keyword")} with no position`,
        detail:
          "Weak domains hold the SERP for these keywords and you have nothing there. One well-made page is usually enough.",
        impact: 72,
        effort: "medium",
        samples: easyWins.slice(0, 5).map((row) => `${row.keyword} (difficulty ${row.difficulty})`),
      }),
    );
  }

  if (input.featured.length > 0) {
    items.push(
      action({
        id: "featured",
        area: "content",
        title: `${plural(input.featured.length, "featured-snippet opportunity", "featured-snippet opportunities")}`,
        detail:
          "You are in the top 10 and the SERP has an answer or question block to take. A concise definition under the heading plus an FAQ section is the cheapest route to a spot above the organic results.",
        impact: 76,
        effort: "low",
        samples: input.featured.slice(0, 5).map((row) => `${row.keyword} (#${row.position})`),
      }),
    );
  }

  if (input.serp.cannibalization.length > 0) {
    items.push(
      action({
        id: "cannibalization",
        area: "serp",
        title: `Search-intent overlap on ${plural(input.serp.cannibalization.length, "query", "queries")}`,
        detail:
          "Two of your URLs compete for the same query and split the signals. Pick the primary page for the topic, then redirect or internally link the other one to it.",
        impact: 64,
        effort: "low",
        samples: input.serp.cannibalization.slice(0, 4).map((row) => row.keyword),
      }),
    );
  }

  const multiClusters = input.clusters.filter((cluster) => cluster.keywords.length > 1);
  if (multiClusters.length > 0) {
    items.push(
      action({
        id: "clusters",
        area: "content",
        title: `${plural(multiClusters.length, "cluster")} one page could serve`,
        detail:
          "The search engine answers these keywords with the same URLs — separate pages are unnecessary. One thorough piece collects all the traffic instead of splitting it across weaker articles.",
        impact: 70,
        effort: "medium",
        samples: multiClusters
          .slice(0, 4)
          .map((cluster) => `${cluster.head} + ${cluster.keywords.length - 1} more`),
      }),
    );
  }

  const downMoves = input.serp.moves.filter((move) => move.state === "down" || move.state === "lost");
  if (downMoves.length > 0) {
    items.push(
      action({
        id: "rank-drops",
        area: "serp",
        title: `${plural(downMoves.length, "drop")} since the last scan`,
        detail:
          "Check whether the target pages changed content, lost links, or are being cannibalised. Drops are easiest to reverse in the first few weeks.",
        impact: 74,
        effort: "medium",
        samples: downMoves
          .slice(0, 5)
          .map((move) => `${move.keyword}: ${move.previous ?? "?"} → ${move.current ?? "out"}`),
      }),
    );
  }

  /* --- Links ---------------------------------------------------------- */

  const lost = input.prospects.filter((row) => row.reason === "lost-link");
  if (lost.length > 0) {
    items.push(
      action({
        id: "recover-lost",
        area: "links",
        title: `Recover ${lost.length} lost links`,
        detail:
          "These pages used to link to you and no longer do. The editors already know your brand, so an email here converts better than anything else on this list.",
        impact: 82,
        effort: "low",
        samples: lost.slice(0, 5).map((row) => row.domain),
      }),
    );
  }

  const mentions = input.prospects.filter((row) => row.reason === "unlinked-mention");
  if (mentions.length > 0) {
    items.push(
      action({
        id: "unlinked-mentions",
        area: "links",
        title: `${plural(mentions.length, "unlinked mention")}`,
        detail:
          "Someone writes about you without linking. One short email asking to turn the name into a link is usually enough.",
        impact: 78,
        effort: "low",
        samples: mentions.slice(0, 5).map((row) => row.domain),
      }),
    );
  }

  const corankers = input.prospects.filter((row) => row.reason === "serp-coranker");
  if (corankers.length >= 3) {
    items.push(
      action({
        id: "coranker-outreach",
        area: "links",
        title: `${plural(corankers.length, "co-ranking domain")} to approach`,
        detail:
          "These sites rank for your keywords, so a link from them carries genuine topical relevance. Start with the highest priority.",
        impact: 66,
        effort: "high",
        samples: corankers.slice(0, 5).map((row) => `${row.domain} (${row.keyword || "SERP"})`),
      }),
    );
  }

  if (input.stats.brokenLinks > 0) {
    items.push(
      action({
        id: "broken-targets",
        area: "links",
        title: `${plural(input.stats.brokenLinks, "link")} leading nowhere`,
        detail:
          "Someone links to a URL that returns an error. A 301 redirect to the current page recovers that value in minutes.",
        impact: 80,
        effort: "low",
        samples: input.analytics.issues
          .find((issue) => issue.id.includes("broken"))
          ?.samples.slice(0, 4) ?? [],
      }),
    );
  }

  if (input.velocity.verdict === "declining") {
    items.push(
      action({
        id: "velocity",
        area: "links",
        title: "Link acquisition is slowing down",
        detail: input.velocity.hint,
        impact: 62,
        effort: "high",
        samples: [`${input.velocity.perMonth} new domains/month`, `change ${input.velocity.trend}%`],
      }),
    );
  }

  const weakSegments = input.segments.filter((segment) => segment.verdict === "high");
  if (weakSegments.length > 0) {
    items.push(
      action({
        id: "segment-balance",
        area: "links",
        title: "The link profile is one-sided",
        detail:
          "Too large a share from one type of site looks unnatural and limits reach. Add links from other segments — media, industry blogs, universities.",
        impact: 54,
        effort: "high",
        samples: weakSegments.map((segment) => `${segment.segment}: ${segment.share}%`),
      }),
    );
  }

  /* --- Risk ----------------------------------------------------------- */

  if (input.toxic.disavowCount > 0) {
    items.push(
      action({
        id: "disavow",
        area: "risk",
        title: `${plural(input.toxic.disavowCount, "high-risk domain")} (manual review)`,
        detail:
          "High toxicity is a review cue, not an automatic Disavow. Most sites never need Disavow — use it only for clear spam or manual-action risk. Check every domain before generating or submitting a file.",
        impact: 68,
        effort: "medium",
        samples: input.toxic.domains
          .filter((row) => row.verdict === "review")
          .slice(0, 5)
          .map((row) => `${row.domain} (tox ${row.toxicity})`),
      }),
    );
  }

  const exactRisk = input.anchorAudit.risks.find((risk) => risk.type === "exact-match");
  if (exactRisk && exactRisk.verdict === "high") {
    items.push(
      action({
        id: "anchor-overopt",
        area: "risk",
        title: `Exact-match anchors are ${exactRisk.share}% of the profile`,
        detail:
          "A natural profile stays below 12%. Build the next links on your brand name, bare URLs and longer phrases from the content until the share drops.",
        impact: 70,
        effort: "medium",
        samples: input.anchorAudit.overOptimized.slice(0, 4).map((row) => `${row.text} (${row.share}%)`),
      }),
    );
  }

  /* --- Measured data beats every estimate ----------------------------- */

  const gsc = input.searchConsole;
  if (gsc?.connected) {
    if (gsc.striking.length > 0) {
      const upside = gsc.striking.reduce((sum, row) => sum + row.potentialClicks, 0);
      items.push(
        action({
          id: "gsc-striking",
          area: "serp",
          title: `${plural(gsc.striking.length, "query", "queries")} within reach of the top three`,
          detail: `These already earn impressions in Google, so the upside is measured rather than guessed — roughly ${upside} extra clicks if each reached position 3. Strengthen the existing page instead of writing a new one.`,
          impact: 92,
          effort: "medium",
          samples: gsc.striking
            .slice(0, 5)
            .map((row) => `${row.query} (#${row.position}, +${row.potentialClicks} clicks)`),
        }),
      );
    }
    if (gsc.ctrAnomalies.length > 0) {
      const lost = gsc.ctrAnomalies.reduce((sum, row) => sum + row.lostClicks, 0);
      items.push(
        action({
          id: "gsc-ctr",
          area: "on-page",
          title: `${plural(gsc.ctrAnomalies.length, "query", "queries")} ranking well but getting no clicks`,
          detail: `About ${lost} clicks lost to titles and descriptions, not to rankings. Rewriting the snippet is the cheapest fix in this whole plan — no links, no new content.`,
          impact: 86,
          effort: "low",
          samples: gsc.ctrAnomalies
            .slice(0, 5)
            .map((row) => `${row.query} (#${row.position}, CTR ${row.ctr}% vs ${row.expectedCtr}%)`),
        }),
      );
    }
    const stableDecay = gsc.decaying.filter((row) => row.positionStable);
    if (stableDecay.length > 0) {
      items.push(
        action({
          id: "gsc-decay",
          area: "content",
          title: `${plural(stableDecay.length, "query", "queries")} losing clicks at a stable position`,
          detail:
            "The ranking held but the clicks left — usually a SERP layout change or a snippet that stopped matching intent. Compare the current result page with what you promise.",
          impact: 74,
          effort: "medium",
          samples: stableDecay.slice(0, 5).map((row) => `${row.query} (${row.clickDelta} clicks)`),
        }),
      );
    }
  }

  /* --- Internal structure --------------------------------------------- */

  const audit = input.siteAudit;
  if (audit) {
    for (const problem of audit.issues.filter((item) => item.severity === "high").slice(0, 3)) {
      items.push(
        action({
          id: `site-${problem.id}`,
          area: "on-page",
          title: problem.title,
          detail: problem.detail,
          impact: problem.id === "underlinked-money-pages" ? 84 : 76,
          effort: problem.id === "orphan-pages" ? "medium" : "low",
          samples: problem.samples.slice(0, 5),
        }),
      );
    }
  }

  /* --- On-page -------------------------------------------------------- */

  if (input.onPage && input.onPage.score < 70) {
    items.push(
      action({
        id: "onpage",
        area: "on-page",
        title: `On-page readiness: ${input.onPage.score}/100`,
        detail:
          "Before adding links, fix the basics on the landing page — title, description, a single H1 and structured data. Without those, part of the link value is wasted.",
        impact: 60,
        effort: "low",
        samples: input.onPage.issues.slice(0, 4).map((issue) => issue.title),
      }),
    );
  }

  const highIssues = input.analytics.issues.filter((issue) => issue.severity === "high");
  for (const issue of highIssues.slice(0, 3)) {
    if (items.some((item) => item.id === issue.id)) continue;
    items.push(
      action({
        id: `issue-${issue.id}`,
        area: "risk",
        title: issue.title,
        detail: issue.detail,
        impact: 58,
        effort: "medium",
        samples: issue.samples.slice(0, 4),
      }),
    );
  }

  const sorted = items.sort((a, b) => b.priority - a.priority || b.impact - a.impact);
  const quickWins = sorted.filter((item) => item.effort === "low").length;

  // Coverage: the fewer open high-impact tasks remain, the closer to done.
  const openImpact = sorted.reduce((sum, item) => sum + item.impact, 0);
  const coverage = Math.max(0, Math.min(100, 100 - Math.round(openImpact / 12)));

  return { items: sorted, quickWins, coverage };
}
