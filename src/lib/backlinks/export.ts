import { disavowFile as buildDisavow } from "./toxic.ts";
import type {
  KeywordIdea,
  LinkGapReport,
  RankMove,
  ScanReport,
  SearchConsoleInsights,
  SerpSnapshot,
  SiteAudit,
} from "./types.ts";

function csvCell(value: unknown): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export function backlinksCsv(report: ScanReport): string {
  const header = [
    "source_domain",
    "source_url",
    "title",
    "anchor",
    "anchor_type",
    "rel",
    "passes_value",
    "placement",
    "sitewide",
    "target_url",
    "target_status",
    "domain_score",
    "spam_score",
    "first_seen",
    "language",
    "discovery_source",
    "flags",
  ];
  const rows = report.backlinks.map((row) =>
    [
      row.sourceDomain,
      row.sourceUrl,
      row.sourceTitle,
      row.anchor,
      row.anchorType,
      row.rel,
      row.effectiveFollow ? "yes" : "no",
      row.placement,
      row.sitewide ? "yes" : "no",
      row.targetUrl,
      row.targetStatus ?? "",
      row.domainScore,
      row.spamScore,
      row.firstSeen ?? "",
      row.sourceLang ?? "",
      row.discoveredVia,
      row.flags.join(" "),
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export function domainsCsv(report: ScanReport): string {
  const header = [
    "domain",
    "links",
    "pages",
    "dofollow",
    "content_links",
    "domain_score",
    "spam_score",
    "tld",
    "first_seen",
    "sample_url",
    "sources",
  ];
  const rows = report.analytics.referringDomains.map((row) =>
    [
      row.domain,
      row.links,
      row.pages,
      row.dofollow,
      row.contentLinks,
      row.domainScore,
      row.spamScore,
      row.tld,
      row.firstSeen ?? "",
      row.sampleUrl,
      row.sources.join(" "),
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export function targetPagesCsv(report: ScanReport): string {
  const header = [
    "path",
    "url_rating",
    "links",
    "domains",
    "dofollow",
    "best_domain_score",
    "status",
  ];
  const rows = report.analytics.targetPages.map((row) =>
    [
      row.path,
      row.urlRating,
      row.links,
      row.domains,
      row.dofollow,
      row.bestDomainScore,
      row.status ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export function anchorsCsv(report: ScanReport): string {
  const header = ["anchor", "type", "count", "domains", "share_pct"];
  const rows = report.analytics.anchors.map((row) =>
    [row.text, row.type, row.count, row.domains, row.share].map(csvCell).join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export function keywordsCsv(report: ScanReport): string {
  const header = [
    "keyword",
    "source",
    "weight",
    "best_position",
    "bing",
    "duckduckgo",
    "mojeek",
    "brave",
    "difficulty",
    "intent",
    "traffic_share",
    "link_equity",
    "matching_anchors",
    "opportunity",
  ];
  const rows = report.keywords.map((row) => {
    const pos = (engine: string) =>
      row.engines.find((e) => e.engine === engine)?.position ?? "";
    return [
      row.keyword,
      row.source,
      row.weight,
      row.bestPosition ?? "",
      pos("bing"),
      pos("duckduckgo"),
      pos("mojeek"),
      pos("brave"),
      row.difficulty,
      row.intent,
      row.trafficShare,
      row.linkEquity,
      row.matchingAnchors,
      row.opportunity,
    ]
      .map(csvCell)
      .join(",");
  });
  return [header.join(","), ...rows].join("\n");
}

export function serpCsv(report: ScanReport): string {
  const header = [
    "keyword",
    "engine",
    "target_position",
    "result_position",
    "url",
    "domain",
    "title",
    "is_target",
    "domain_score",
    "ctr",
    "difficulty",
    "features",
  ];
  const rows = report.serp.queries.flatMap((query) =>
    query.results.map((hit) =>
      [
        query.keyword,
        query.engine,
        query.targetPosition ?? "",
        hit.position,
        hit.url,
        hit.domain,
        hit.title,
        hit.isTarget ? "yes" : "no",
        hit.domainScore,
        hit.ctr,
        query.difficulty,
        query.features.join(" "),
      ]
        .map(csvCell)
        .join(","),
    ),
  );
  return [header.join(","), ...rows].join("\n");
}

export function prospectsCsv(report: ScanReport): string {
  const header = [
    "priority",
    "reason",
    "domain",
    "url",
    "contact",
    "title",
    "keyword",
    "position",
    "engine",
    "domain_score",
    "snippet",
  ];
  const rows = report.prospects.map((row) =>
    [
      row.priority,
      row.reason,
      row.domain,
      row.url,
      row.contactUrl ?? "",
      row.title,
      row.keyword,
      row.position ?? "",
      row.engine ?? "",
      row.domainScore,
      row.snippet,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}


export function gapCsv(report: LinkGapReport): string {
  const header = ["priority", "domain", "domain_score", "dofollow", "competitors", "sample_url"];
  const rows = report.gap.map((row) =>
    [
      row.priority,
      row.domain,
      row.domainScore,
      row.dofollow ? "yes" : "no",
      row.competitors.join(" "),
      row.sampleUrl,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

/**
 * A disavow file in Google Search Console format. By default only domains with
 * a "disavow" verdict; `includeWatch` adds the ones flagged for observation.
 */
export function disavowFile(report: ScanReport, includeWatch = false): string {
  return buildDisavow(report.toxic, { host: report.target.host, includeWatch });
}

export function toxicCsv(report: ScanReport): string {
  const header = [
    "domain",
    "verdict",
    "toxicity",
    "spam_score",
    "domain_score",
    "relevance",
    "links",
    "sitewide",
    "reasons",
    "sample_url",
  ];
  const rows = report.toxic.domains.map((row) =>
    [
      row.domain,
      row.verdict,
      row.toxicity,
      row.spamScore,
      row.domainScore,
      row.relevance,
      row.links,
      row.sitewide ? "yes" : "no",
      row.reasons.join("; "),
      row.sampleUrl,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

/** Competitors visible in SERPs for the target keywords. */
export function serpCompetitorsCsv(snapshot: SerpSnapshot): string {
  const header = [
    "domain",
    "share_of_voice",
    "keywords",
    "appearances",
    "best_position",
    "avg_position",
    "keyword_coverage",
    "domain_score",
    "links_to_you",
    "sample_keyword",
    "sample_url",
  ];
  const rows = snapshot.competitors.map((row) =>
    [
      row.domain,
      row.shareOfVoice,
      row.keywords,
      row.appearances,
      row.bestPosition,
      row.avgPosition,
      `${row.overlap}%`,
      row.domainScore,
      row.linksToTarget ? "yes" : "no",
      row.sampleKeyword,
      row.sampleUrl,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

/** Gains and drops relative to the previous scan. */
export function rankMovesCsv(moves: RankMove[]): string {
  const header = ["keyword", "engine", "previous", "current", "change", "state"];
  const rows = moves.map((row) =>
    [
      row.keyword,
      row.engine,
      row.previous ?? "",
      row.current ?? "",
      row.change ?? "",
      row.state,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

/** The action plan as CSV — a backlog ready to paste into a task tracker. */
/** Query performance from connected search-engine accounts. */
export function searchConsoleCsv(insights: SearchConsoleInsights): string {
  const header = [
    "source",
    "query",
    "clicks",
    "impressions",
    "ctr",
    "position",
    "expected_ctr",
    "potential_clicks",
  ];
  const striking = new Map(insights.striking.map((row) => [row.query, row.potentialClicks]));
  const expected = new Map(insights.ctrAnomalies.map((row) => [row.query, row.expectedCtr]));
  const rows = insights.providers.flatMap((provider) =>
    provider.queries.map((row) => {
      const query = row.keys[0] ?? "";
      return [
        provider.source,
        query,
        row.clicks,
        row.impressions,
        row.ctr,
        row.position,
        expected.get(query) ?? "",
        striking.get(query) ?? "",
      ]
        .map(csvCell)
        .join(",");
    }),
  );
  return [header.join(","), ...rows].join("\n");
}

/** Internal pages with depth, inbound links and indexing state. */
export function siteAuditCsv(audit: SiteAudit): string {
  const header = [
    "path",
    "url",
    "title",
    "status",
    "depth",
    "inbound_links",
    "outbound_links",
    "external_links",
    "backlinks",
    "noindex",
    "redirected",
    "canonical",
  ];
  const rows = audit.pages.map((page) =>
    [
      page.path,
      page.url,
      page.title ?? "",
      page.status,
      page.depth,
      page.inboundLinks,
      page.outboundLinks,
      page.externalLinks,
      page.backlinks,
      page.noindex ? "yes" : "no",
      page.redirected ? "yes" : "no",
      page.canonical ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export function planCsv(report: ScanReport): string {
  const header = ["priority", "area", "task", "impact", "effort", "detail", "samples"];
  const rows = report.plan.items.map((row) =>
    [
      row.priority,
      row.area,
      row.title,
      row.impact,
      row.effort,
      row.detail,
      row.samples.join(" | "),
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

/** Keyword clusters split by strategy: one page versus separate pages. */
export function clustersCsv(report: ScanReport): string {
  const header = [
    "cluster",
    "keywords",
    "keyword_count",
    "strategy",
    "difficulty",
    "intent",
    "best_position",
    "shared_urls",
  ];
  const rows = report.serp.clusters.map((row) =>
    [
      row.head,
      row.keywords.join(" | "),
      row.keywords.length,
      row.strategy,
      row.difficulty,
      row.intent,
      row.bestPosition ?? "",
      row.sharedUrls.join(" "),
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

/** Terms competitors cover — the basis for expanding content. */
export function contentGapCsv(report: ScanReport): string {
  const header = ["term", "competitor_pages", "coverage", "on_target", "keywords"];
  const rows = report.serp.contentGaps.map((row) =>
    [
      row.term,
      row.competitorPages,
      `${row.coverage}%`,
      row.onTarget ? "yes" : "no",
      row.keywords.join(" | "),
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export function keywordIdeasCsv(ideas: KeywordIdea[]): string {
  const header = ["keyword", "score", "intent", "words", "source", "seed"];
  const rows = ideas.map((row) =>
    [row.keyword, row.score, row.intent, row.words, row.source, row.seed].map(csvCell).join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export function reportJson(report: ScanReport): string {
  return JSON.stringify(report, null, 2);
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * A standalone HTML report — a single file to send to a client or archive,
 * with no external dependencies and no scripts.
 */
export function reportHtml(report: ScanReport): string {
  const { stats, analytics, target } = report;
  const cards: [string, string | number][] = [
    ["Visibility index", `${report.scorecard.index}/100 (${report.scorecard.grade})`],
    ["Domain Rating", stats.domainRating],
    ["SERP visibility", `${stats.serpVisibility}/100`],
    ["On-page SEO", `${stats.onPageScore}/100`],
    ["Health", `${analytics.health.total}/100 (${analytics.health.grade})`],
    ["Backlinks", stats.backlinks],
    ["Referring domains", stats.referringDomains],
    ["Dofollow", stats.dofollow],
    ["In content", stats.contentLinks],
    ["Keywords in top 10", stats.rankedKeywords],
    ["Link opportunities", stats.prospects],
    ["Lost links", stats.lostLinks],
    ["Broken links", stats.brokenLinks],
    ["For review (toxic)", stats.toxicDomains],
    ["Footprint", `${report.footprint.score}/100 (${report.footprint.verdict})`],
    ["Link velocity", `${report.velocity.perMonth}/mo`],
    ["Plan tasks", stats.actions],
  ];


  const linkRows = report.backlinks
    .slice(0, 300)
    .map(
      (row) => `<tr>
        <td><a href="${esc(row.sourceUrl)}">${esc(row.sourceDomain)}</a><div class="s">${esc(row.sourceTitle)}</div></td>
        <td>${esc(row.anchor || "—")}<div class="s">${esc(row.anchorType)}</div></td>
        <td>${esc(row.targetPath)}</td>
        <td>${row.effectiveFollow ? "dofollow" : esc(row.rel)}</td>
        <td>${esc(row.placement)}</td>
        <td class="n">${row.domainScore}</td>
        <td class="n">${row.relevance}</td>
        <td>${row.state === "lost" ? "lost" : "active"}</td>
      </tr>`,
    )
    .join("");

  const domainRows = analytics.referringDomains
    .slice(0, 200)
    .map(
      (row) => `<tr>
        <td><a href="${esc(row.sampleUrl)}">${esc(row.domain)}</a></td>
        <td class="n">${row.domainScore}</td>
        <td class="n">${row.rank}</td>
        <td class="n">${row.links}</td>
        <td class="n">${row.dofollow}</td>
        <td class="n">${row.relevance}</td>
        <td class="n">${row.spamScore}</td>
        <td>${esc(row.subnet ?? "")}</td>
      </tr>`,
    )
    .join("");

  const issues = analytics.issues
    .map(
      (issue) =>
        `<li><strong>${esc(issue.title)}</strong> (${issue.count}) — ${esc(issue.detail)}</li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RankProof — ${esc(target.host)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 -apple-system, Segoe UI, Roboto, sans-serif; margin: 0 auto; max-width: 1100px; padding: 32px 20px 64px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 36px 0 10px; }
  .muted { opacity: .65; font-size: 13px; }
  .grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); margin-top: 20px; }
  .card { border: 1px solid rgba(128,128,128,.3); border-radius: 10px; padding: 12px 14px; }
  .card b { display: block; font-size: 22px; font-variant-numeric: tabular-nums; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border-bottom: 1px solid rgba(128,128,128,.25); padding: 7px 8px; text-align: left; vertical-align: top; }
  th { font-weight: 600; opacity: .7; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; }
  .s { opacity: .6; font-size: 11px; }
  a { color: inherit; }
  ul { padding-left: 18px; }
</style></head><body>
<h1>RankProof — ${esc(target.host)}</h1>
<p class="muted">${esc(target.title ?? "")} · report from ${esc(report.queriedAt)} · ${stats.pagesCrawled} target pages, ${stats.candidatesChecked} pages verified</p>
<div class="grid">${cards
    .map(([label, value]) => `<div class="card"><b>${esc(value)}</b>${esc(label)}</div>`)
    .join("")}</div>
<h2>Visibility index</h2>
<table><thead><tr><th>Component</th><th>Points</th><th>Comment</th></tr></thead><tbody>${report.scorecard.parts
    .map(
      (part) =>
        `<tr><td>${esc(part.label)}</td><td class="n">${part.score}/${part.max}</td><td class="s">${esc(part.hint)}</td></tr>`,
    )
    .join("")}</tbody></table>
${
  report.plan.items.length
    ? `<h2>Action plan</h2>
<table><thead><tr><th>#</th><th>Task</th><th>Area</th><th>Effort</th><th>Priority</th></tr></thead><tbody>${report.plan.items
        .map(
          (item, index) =>
            `<tr><td class="n">${index + 1}</td><td>${esc(item.title)}<div class="s">${esc(item.detail)}</div></td><td>${esc(item.area)}</td><td>${esc(item.effort)}</td><td class="n">${item.priority}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : ""
}
${
  report.brandSerp
    ? `<h2>Brand SERP — “${esc(report.brandSerp.keyword)}”</h2>
<p class="muted">Control ${report.brandSerp.control}% · ${report.brandSerp.owned} owned, ${report.brandSerp.thirdParty} third-party, ${report.brandSerp.risky} risky. ${esc(report.brandSerp.hint)}</p>
<table><thead><tr><th>#</th><th>Result</th><th>Type</th><th>Yours</th></tr></thead><tbody>${report.brandSerp.results
        .map(
          (row) =>
            `<tr><td class="n">${row.position}</td><td><a href="${esc(row.url)}">${esc(row.domain)}</a><div class="s">${esc(row.title)}</div></td><td>${esc(row.kind)}</td><td>${row.owned ? "yes" : "no"}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : ""
}
${
  report.serp.clusters.filter((cluster) => cluster.keywords.length > 1).length
    ? `<h2>Keyword clusters</h2>
<table><thead><tr><th>Cluster</th><th>Keywords</th><th>Strategy</th><th>Difficulty</th></tr></thead><tbody>${report.serp.clusters
        .filter((cluster) => cluster.keywords.length > 1)
        .map(
          (cluster) =>
            `<tr><td>${esc(cluster.head)}</td><td class="s">${esc(cluster.keywords.join(", "))}</td><td>${esc(cluster.strategy)}</td><td class="n">${cluster.difficulty}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : ""
}
${
  report.toxic.domains.filter((row) => row.verdict !== "ok").length
    ? `<h2>Risky domains</h2>
<table><thead><tr><th>Domain</th><th>Verdict</th><th>Toxicity</th><th>Reasons</th></tr></thead><tbody>${report.toxic.domains
        .filter((row) => row.verdict !== "ok")
        .slice(0, 60)
        .map(
          (row) =>
            `<tr><td>${esc(row.domain)}</td><td>${esc(row.verdict)}</td><td class="n">${row.toxicity}</td><td class="s">${esc(row.reasons.join(", "))}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : ""
}
${
  report.segments.length
    ? `<h2>Profile composition</h2>
<table><thead><tr><th>Segment</th><th>Domains</th><th>Share</th><th>Average DS</th></tr></thead><tbody>${report.segments
        .map(
          (segment) =>
            `<tr><td>${esc(segment.segment)}</td><td class="n">${segment.domains}</td><td class="n">${segment.share}%</td><td class="n">${segment.avgDomainScore}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : ""
}
${issues ? `<h2>Issues found</h2><ul>${issues}</ul>` : ""}
${
  report.keywords.length
    ? `<h2>Keywords and SERP</h2>
<table><thead><tr><th>Keyword</th><th>Source</th><th>Position</th><th>Link equity</th><th>Opportunity</th></tr></thead><tbody>${report.keywords
        .map(
          (row) =>
            `<tr><td>${esc(row.keyword)}</td><td>${esc(row.source)}</td><td class="n">${row.bestPosition ?? "—"}</td><td class="n">${row.linkEquity}</td><td class="n">${row.opportunity}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : ""
}
${
  report.prospects.length
    ? `<h2>Link opportunities</h2>
<table><thead><tr><th>Domain</th><th>Reason</th><th>Keyword</th><th>DS</th></tr></thead><tbody>${report.prospects
        .slice(0, 40)
        .map(
          (row) =>
            `<tr><td><a href="${esc(row.url)}">${esc(row.domain)}</a></td><td>${esc(row.reason)}</td><td>${esc(row.keyword)}</td><td class="n">${row.domainScore}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : ""
}
<h2>Referring domains</h2>

<table><thead><tr><th>Domain</th><th>DS</th><th>PR</th><th>Links</th><th>Dofollow</th><th>Topic</th><th>Spam</th><th>Subnet</th></tr></thead><tbody>${domainRows}</tbody></table>
<h2>Backlinks</h2>
<table><thead><tr><th>Source</th><th>Anchor</th><th>Target</th><th>Rel</th><th>Placement</th><th>DS</th><th>Topic</th><th>State</th></tr></thead><tbody>${linkRows}</tbody></table>
<p class="muted">Generated by RankProof. Every link was confirmed in the source page HTML; DS/PR/DR are approximations computed from open data.</p>
</body></html>`;
}

export function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
