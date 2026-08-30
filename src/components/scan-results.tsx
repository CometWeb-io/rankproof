import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  Download,
  FileJson,
  Filter,
  Gauge,
  Globe,
  Link2,
  Search,
  ShieldCheck,
  ShieldOff,
  Server,
  FileText,
} from "lucide-react";
import { BacklinkRow } from "@/components/scan/backlink-row";
import { GrowthChart, TrendChart } from "@/components/scan/charts";
import { DiffStrip } from "@/components/scan/diff-strip";
import { IssueCard } from "@/components/scan/issue-card";
import { ANCHOR_LABEL, PLACEMENT_LABEL, SOURCE_LABEL } from "@/components/scan/labels";
import { LinkGapPanel } from "@/components/scan/link-gap-panel";
import { TabNav } from "@/components/scan/tab-nav";
import type { LinkFilter, SortKey, Tab, TabItem } from "@/components/scan/types";
import { DistributionList, Meter, StatCard } from "@/components/scan/ui-primitives";
import { formatDate, percent } from "@/components/scan/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  anchorsCsv,
  backlinksCsv,
  disavowFile,
  domainsCsv,
  download,
  reportHtml,
  reportJson,
  targetPagesCsv,
} from "@/lib/backlinks/export";
import { KeywordsTab, OnPagePanel, ProspectsTab, SerpOverviewHint, SerpTab } from "@/components/scan-serp";
import { ToxicTab } from "@/components/scan-toxic";
import { PlanTab } from "@/components/scan-plan";
import { BrandSerpPanel, FootprintPanel, ScorecardPanel } from "@/components/scan-brand";
import {
  EngineHealthPanel,
  SearchConsolePanel,
  SiteAuditPanel,
} from "@/components/scan-insights";
import type { ScanDiff } from "@/lib/backlinks/history";
import type { ScanReport } from "@/lib/backlinks/types";

export { EmptyGuide, ScanSkeleton } from "@/components/scan/empty-states";


/* ------------------------------------------------------------------ */
/* Main view                                                        */
/* ------------------------------------------------------------------ */

export function ScanResults({ report, diff }: { report: ScanReport; diff?: ScanDiff | null }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [visible, setVisible] = useState(60);
  const [filter, setFilter] = useState<LinkFilter>("all");
  const [sort, setSort] = useState<SortKey>("score");
  const [query, setQuery] = useState("");

  const { analytics, stats, target } = report;

  // A diff computed server-side (persistent history) takes precedence over
  // the localStorage comparison.
  const effectiveDiff = useMemo<ScanDiff | null>(() => {
    if (report.delta) {
      return {
        previousAt: report.delta.previousAt,
        newLinks: report.delta.newLinks,
        lostLinks: report.delta.lostLinks,
        newDomains: report.delta.newDomains,
        lostDomains: report.delta.lostDomains,
        backlinkDelta: report.delta.backlinkDelta,
        domainDelta: report.delta.domainDelta,
        healthDelta: report.delta.healthDelta,
        newIds: new Set(report.delta.newIds),
      };
    }
    return diff ?? null;
  }, [diff, report.delta]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    let rows = report.backlinks.filter((item) => {
      if (needle) {
        const blob =
          `${item.sourceHost} ${item.sourceTitle} ${item.anchor} ${item.targetPath}`.toLowerCase();
        if (!blob.includes(needle)) return false;
      }
      switch (filter) {
        case "dofollow":
          return item.effectiveFollow;
        case "nofollow":
          return !item.effectiveFollow;
        case "content":
          return item.placement === "content";
        case "authority":
          return item.domainScore >= 70;
        case "risk":
          return item.spamScore >= 55;
        case "broken":
          return item.flags.includes("broken-target");
        case "lost":
          return item.state === "lost";
        case "ontopic":
          return item.relevance >= 45;
        case "new":
          return effectiveDiff ? effectiveDiff.newIds.has(item.id) : true;
        default:
          return true;
      }
    });
    rows = [...rows];
    if (sort === "authority") rows.sort((a, b) => b.domainScore - a.domainScore);
    if (sort === "relevance") rows.sort((a, b) => b.relevance - a.relevance);
    if (sort === "domain") rows.sort((a, b) => a.sourceDomain.localeCompare(b.sourceDomain));
    if (sort === "recent") {
      rows.sort((a, b) => (b.firstSeen ?? "").localeCompare(a.firstSeen ?? ""));
    }
    return rows;
  }, [effectiveDiff, filter, query, report.backlinks, sort]);

  const health = analytics.health;

  const tabs = useMemo<TabItem[]>(
    () => [
      ["overview", "Overview", 0],
      ["plan", "Action plan", report.plan.items.length],
      ["performance", "Search Console", report.searchConsole?.striking.length ?? 0],
      ["structure", "Structure", report.siteAudit?.issues.length ?? 0],
      ["serp", "SERP", report.serp.queries.length],
      ["keywords", "Keywords", report.keywords.length],
      ["links", "Backlinks", stats.backlinks],
      ["domains", "Domains", stats.referringDomains],
      ["pages", "Target pages", analytics.targetPages.length],
      ["anchors", "Anchors", analytics.anchors.length],
      ["toxic", "Risk", report.toxic.disavowCount + report.toxic.watchCount],
      ["outbound", "Outbound", stats.outboundDomains],
      ["gap", "Link gap", 0],
      ["prospects", "Prospects", stats.prospects],
      ["mentions", "Mentions", stats.mentions],
      ["issues", "Issues", analytics.issues.length],
      ["sources", "Sources", report.sources.length],
    ],
    [analytics, report, stats],
  );

  return (
    <section className="flex flex-col gap-6">
      {/* Report header */}
      <div className="rounded-xl border border-border bg-surface p-5 md:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-wide text-muted uppercase">Scan result</p>
            <h2 className="mt-1 font-display text-2xl font-medium tracking-tight text-fg md:text-3xl">
              {target.host}
            </h2>
            <p className="mt-1 line-clamp-2 text-sm text-muted">
              {target.title ?? "The page title could not be read"}
            </p>
            {target.description ? (
              <p className="mt-1 line-clamp-2 text-sm text-subtle">{target.description}</p>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              {target.robotsNoindex ? <Badge variant="nofollow">noindex</Badge> : null}
              {target.parked ? <Badge variant="nofollow">parked</Badge> : null}
              {target.usedArchive ? <Badge>kopia archiwalna</Badge> : null}
              {target.redirectHost ? (
                <Badge variant="nofollow">→ {target.redirectHost}</Badge>
              ) : null}
              {target.subdomains.length > 0 ? (
                <Badge>{target.subdomains.length} subdomains</Badge>
              ) : null}
              {target.indexedPages > 0 ? (
                <Badge>{target.indexedPages} known URLs</Badge>
              ) : null}
            </div>

            <p className="mt-3 text-xs text-subtle">
              {formatDate(report.queriedAt)}
              {target.status ? ` · HTTP ${target.status}` : ""}
              {target.https ? " · HTTPS" : " · no HTTPS"}
              {target.archiveFirstSeen
                ? ` · in archive since ${target.archiveFirstSeen.slice(0, 4)}`
                : ""}
              {` · ${stats.pagesCrawled} target pages · ${stats.candidatesChecked} pages verified · ${(
                stats.durationMs / 1000
              ).toFixed(1)} s`}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary" size="sm">
              <a href={target.url} target="_blank" rel="noreferrer">
                <Globe />
                Open site
              </a>
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={report.backlinks.length === 0}
              onClick={() =>
                download(`rankproof-${target.host}-backlinks.csv`, backlinksCsv(report), "text/csv")
              }
            >
              <Download />
              Links CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={analytics.referringDomains.length === 0}
              onClick={() =>
                download(`rankproof-${target.host}-domains.csv`, domainsCsv(report), "text/csv")
              }
            >
              <Download />
              Domains CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={analytics.targetPages.length === 0}
              onClick={() =>
                download(
                  `rankproof-${target.host}-pages.csv`,
                  targetPagesCsv(report),
                  "text/csv",
                )
              }
            >
              <Download />
              Pages CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={analytics.anchors.length === 0}
              onClick={() =>
                download(`rankproof-${target.host}-anchors.csv`, anchorsCsv(report), "text/csv")
              }
            >
              <Download />
              Anchors CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={stats.spamDomains === 0}
              onClick={() =>
                download(`disavow-${target.host}.txt`, disavowFile(report), "text/plain")
              }
            >
              <ShieldOff />
              Disavow
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                download(`rankproof-${target.host}.html`, reportHtml(report), "text/html")
              }
            >
              <FileText />
              HTML report
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                download(`rankproof-${target.host}.json`, reportJson(report), "application/json")
              }
            >
              <FileJson />
              JSON
            </Button>
          </div>
        </div>
      </div>

      {effectiveDiff ? (
        <DiffStrip
          diff={effectiveDiff}
          ratingDelta={report.delta?.ratingDelta}
          visibilityDelta={report.delta?.visibilityDelta}
          persisted={report.persisted}
        />
      ) : null}

      {/* Statystyki */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <div className="col-span-2 rounded-lg border border-border-strong bg-surface p-4 shadow-[var(--shadow-panel)] md:col-span-2">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">
            Domain Rating (proxy)
          </p>
          <div className="mt-2 flex items-end gap-3">
            <p className="font-mono text-4xl tabular-nums tracking-tight text-fg">
              {stats.domainRating}
            </p>
            <p className="pb-1 text-xs text-subtle">
              from the discovered graph · PageRank over {stats.referringDomains} domains
            </p>
          </div>
          <div className="mt-3">
            <Meter value={stats.domainRating} tone="good" />
          </div>
        </div>
        <StatCard
          label="Verified backlinks"
          value={stats.backlinks}
          hint={`${stats.contentLinks} in content`}
        />
        <StatCard
          label="Referring domains"
          value={stats.referringDomains}
          hint={`${stats.authorityDomains} strong`}
        />
        <StatCard
          label="Dofollow"
          value={`${percent(stats.dofollow, stats.backlinks)}%`}
          hint={`${stats.dofollow} of ${stats.backlinks}`}
          tone="follow"
        />
        <StatCard
          label="Profile health"
          value={`${health.total}`}
          hint={`grade ${health.grade} · avg domain ${stats.avgDomainScore}/100`}
        />
        <StatCard
          label="Broken links"
          value={stats.brokenLinks}
          hint={`${stats.sitewideLinks} sitewide links`}
          tone={stats.brokenLinks > 0 ? "nofollow" : "default"}
        />
        <StatCard
          label="Mentions"
          value={stats.mentions}
          hint={`${stats.spamDomains} risky domains`}
        />
        <StatCard
          label="Topical match"
          value={`${stats.avgRelevance}/100`}
          hint={`${stats.redirectedLinks} links via redirect`}
        />
        <StatCard
          label="SERP visibility"
          value={stats.serpVisibility}
          hint={`${stats.rankedKeywords} in the top 10`}
          tone={stats.serpVisibility >= 40 ? "follow" : "default"}
        />
        <StatCard
          label="On-page SEO"
          value={stats.onPageScore}
          hint={`${stats.prospects} link opportunities`}
        />
        <StatCard
          label="IPs / subnets"
          value={`${stats.referringIps}/${stats.referringSubnets}`}
          hint="unique addresses and /24 ranges"
        />
        <StatCard
          label="Lost links"
          value={stats.lostLinks}
          hint={`${stats.reciprocalDomains} reciprocal domains`}
          tone={stats.lostLinks > 0 ? "nofollow" : "default"}
        />
      </div>

      <TabNav tabs={tabs} active={tab} onChange={setTab} />

      {tab === "overview" ? (
        <div className="flex flex-col gap-4">
          <ScorecardPanel card={report.scorecard} />
          <EngineHealthPanel snapshot={report.serp} />
          <div className="rounded-xl border border-border bg-surface p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Gauge className="size-4 text-fg-soft" />
                <p className="text-sm font-medium text-fg">Link profile health</p>
              </div>
              <p className="font-mono text-2xl tabular-nums text-fg">
                {health.total}
                <span className="ml-2 text-sm text-muted">/ 100 · {health.grade}</span>
              </p>
            </div>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {health.parts.map((part) => (
                <li key={part.key} className="rounded-lg border border-border p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm text-fg-soft">{part.label}</span>
                    <span className="font-mono text-xs tabular-nums text-muted">
                      {part.score}/{part.max}
                    </span>
                  </div>
                  <div className="mt-2">
                    <Meter
                      value={part.score}
                      max={part.max}
                      tone={part.score / part.max > 0.66 ? "good" : "default"}
                    />
                  </div>
                  <p className="mt-2 text-xs text-subtle">{part.hint}</p>
                </li>
              ))}
            </ul>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <DistributionList
              title="Link placement"
              stats={analytics.placements}
              labelMap={PLACEMENT_LABEL}
            />
            <DistributionList title="Link type" stats={analytics.rels} />
            <DistributionList
              title="Anchor type"
              stats={analytics.anchorTypes}
              labelMap={ANCHOR_LABEL}
            />
            <DistributionList title="Top-level domains" stats={analytics.tlds} />
            <DistributionList title="Source page languages" stats={analytics.languages} />
            <DistributionList
              title="Most linked pages"
              stats={analytics.topTargetPages}
            />
          </div>

          {report.brandSerp ? <BrandSerpPanel brand={report.brandSerp} /> : null}
          <FootprintPanel footprint={report.footprint} />
          <TrendChart points={report.trend} />
          <GrowthChart stats={analytics.growth} />
          {report.onPage ? <OnPagePanel audit={report.onPage} /> : null}
          <SerpOverviewHint />

          {report.notes.length > 0 ? (
            <div className="rounded-xl border border-border bg-surface-2 p-5">
              <p className="text-xs font-medium tracking-wide text-muted uppercase">
                Scan notes
              </p>
              <ul className="mt-2 flex flex-col gap-1 text-sm text-muted">
                {report.notes.map((note) => (
                  <li key={note}>· {note}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === "plan" ? <PlanTab report={report} /> : null}
      {tab === "performance" ? (
        report.searchConsole ? (
          <SearchConsolePanel insights={report.searchConsole} host={report.target.host} />
        ) : (
          <div className="rounded-xl border border-border bg-surface-2 p-5">
            <p className="text-sm font-medium text-fg">No search-engine account connected</p>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
              Connecting Google Search Console or Bing Webmaster Tools replaces several estimates in
              this report with measured data: real clicks, impressions and Google positions. Setup
              takes a few minutes — see <span className="font-mono">docs/search-console.md</span>.
            </p>
          </div>
        )
      ) : null}
      {tab === "structure" ? (
        report.siteAudit ? (
          <SiteAuditPanel audit={report.siteAudit} host={report.target.host} />
        ) : (
          <p className="rounded-xl border border-border bg-surface py-12 text-center text-sm text-muted">
            The internal audit did not run for this scan.
          </p>
        )
      ) : null}
      {tab === "serp" ? <SerpTab report={report} /> : null}
      {tab === "toxic" ? <ToxicTab report={report} /> : null}
      {tab === "keywords" ? <KeywordsTab report={report} /> : null}
      {tab === "prospects" ? <ProspectsTab report={report} /> : null}

      {tab === "links" ? (
        <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
          <div className="flex flex-col gap-3 border-b border-border py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm text-muted">
                <Link2 className="size-4" />
                {filtered.length} of {stats.backlinks} records
              </div>
              <div className="flex items-center gap-2">
                <Filter className="size-4 text-subtle" />
                <select
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SortKey)}
                  className="h-9 rounded-full border border-border bg-surface px-3 text-xs text-muted focus-visible:outline-none"
                >
                  <option value="score">Sort: link value</option>
                  <option value="authority">Sort: domain score</option>
                  <option value="relevance">Sort: topical relevance</option>
                  <option value="domain">Sort: domain A–Z</option>
                  <option value="recent">Sort: source age</option>
                </select>
              </div>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter by domain, anchor or path…"
                  className="pl-9"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["all", "All"],
                  ["dofollow", "Dofollow"],
                  ["nofollow", "Nofollow"],
                  ["content", "In content"],
                  ["authority", "Strong domains"],
                  ["risk", "Risky"],
                  ["broken", "Broken"],
                  ["lost", "Lost"],
                  ["ontopic", "On topic"],
                  ...(effectiveDiff ? ([["new", "New"]] as const) : []),
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setFilter(id)}
                  className={cn(
                    "h-9 rounded-full border px-3 text-xs font-medium",
                    filter === id
                      ? "border-border-strong bg-surface-2 text-fg"
                      : "border-border text-muted hover:text-fg",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="py-12 text-center">
              <p className="mx-auto max-w-lg text-sm text-muted">
                No links match this filter. That does not mean the site has no profile — open sources cover
                a fraction of the web, and every record shown here was confirmed in the source
                page&rsquo;s HTML.
              </p>
            </div>
          ) : (
            <div>
              {filtered.slice(0, visible).map((item) => (
                <BacklinkRow
                  key={item.id}
                  item={item}
                  isNew={Boolean(effectiveDiff?.newIds.has(item.id))}
                />
              ))}
              {filtered.length > visible ? (
                <div className="flex justify-center py-5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setVisible((value) => value + 60)}
                  >
                    Show more ({filtered.length - visible})
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {tab === "domains" ? (
        <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
          {analytics.referringDomains.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted">
              No referring domains in this scan.
            </p>
          ) : (
            analytics.referringDomains.map((domain) => (
              <article
                key={domain.domain}
                className="grid gap-3 border-b border-border py-4 last:border-b-0 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto] md:items-center"
              >
                <div className="min-w-0">
                  <a
                    href={domain.sampleUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 font-mono text-sm text-fg hover:text-fg-soft"
                  >
                    {domain.domain}
                    <ArrowUpRight className="size-3.5 text-subtle" />
                  </a>
                  <p className="mt-1 truncate text-xs text-muted">
                    {domain.sampleAnchor ? `„${domain.sampleAnchor}”` : "no text anchor"}
                  </p>
                  <div className="mt-2 max-w-[240px]">
                    <Meter
                      value={domain.domainScore}
                      tone={
                        domain.spamScore >= 55
                          ? "risk"
                          : domain.domainScore >= 70
                            ? "good"
                            : "default"
                      }
                    />
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted">
                  <span title="Domain score">DS {domain.domainScore}</span>
                  <span title="Rank in the discovered graph (PageRank)">PR {domain.rank}</span>
                  <span>{domain.links} links</span>
                  <span>{domain.pages} pages</span>
                  <span>{domain.dofollow} dofollow</span>
                  <span title="Topical match">TM {domain.relevance}</span>
                  {domain.firstSeen ? <span>since {domain.firstSeen.slice(0, 4)}</span> : null}
                  {domain.subnet ? (
                    <span title="/24 subnet of the IP address">{domain.subnet}</span>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2 md:justify-end">
                  {domain.lostLinks > 0 ? (
                    <Badge variant="nofollow">lost {domain.lostLinks}</Badge>
                  ) : null}
                  {domain.reciprocal ? <Badge>reciprocal</Badge> : null}
                  {domain.spamScore >= 55 ? (
                    <Badge variant="nofollow">spam {domain.spamScore}</Badge>
                  ) : null}
                  {domain.sitewide ? <Badge>sitewide</Badge> : null}
                  <Badge>{domain.tld}</Badge>
                  <Badge variant={domain.dofollow > 0 ? "follow" : "default"}>
                    {domain.dofollow > 0 ? "passes value" : "nofollow"}
                  </Badge>
                </div>
              </article>
            ))
          )}
        </div>
      ) : null}

      {tab === "anchors" ? (
        <div className="rounded-xl border border-border bg-surface px-4 py-2 md:px-5">
          {analytics.anchors.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted">No anchor data yet.</p>
          ) : (
            analytics.anchors.map((anchor) => (
              <div key={anchor.text} className="border-b border-border py-4 last:border-b-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="truncate text-sm text-fg">„{anchor.text}”</p>
                  <div className="flex items-center gap-2">
                    <Badge>{ANCHOR_LABEL[anchor.type]}</Badge>
                    <span className="font-mono text-xs tabular-nums text-muted">
                      {anchor.count} × · {anchor.domains} domains · {anchor.share}%
                    </span>
                  </div>
                </div>
                <div className="mt-2">
                  <Meter
                    value={anchor.share}
                    tone={anchor.share > 35 && anchor.type === "exact-match" ? "risk" : "default"}
                  />
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}

      {tab === "pages" ? (
        <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
          <div className="flex items-center gap-2 border-b border-border py-4 text-sm text-muted">
            <Gauge className="size-4" />
            The target&rsquo;s strongest pages — URL Rating computed from the link profile
          </div>
          {analytics.targetPages.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted">
              No linked pages in this scan.
            </p>
          ) : (
            analytics.targetPages.map((page) => (
              <article
                key={page.path}
                className="grid gap-3 border-b border-border py-4 last:border-b-0 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] md:items-center"
              >
                <div className="min-w-0">
                  <a
                    href={page.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex max-w-full items-center gap-1.5 truncate font-mono text-sm text-fg hover:text-fg-soft"
                  >
                    {page.path}
                    <ArrowUpRight className="size-3.5 shrink-0 text-subtle" />
                  </a>
                  <div className="mt-2 max-w-[240px]">
                    <Meter value={page.urlRating} tone="good" />
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted">
                  <span title="URL Rating">UR {page.urlRating}</span>
                  <span>{page.links} links</span>
                  <span>{page.domains} domains</span>
                  <span>{page.dofollow} dofollow</span>
                </div>
                <div className="flex flex-wrap gap-2 md:justify-end">
                  {page.status && page.status >= 400 ? (
                    <Badge variant="nofollow">HTTP {page.status}</Badge>
                  ) : page.status ? (
                    <Badge variant="follow">HTTP {page.status}</Badge>
                  ) : null}
                  <Badge>best domain {page.bestDomainScore}</Badge>
                </div>
              </article>
            ))
          )}
        </div>
      ) : null}

      {tab === "outbound" ? (
        <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
          <div className="flex items-center gap-2 border-b border-border py-4 text-sm text-muted">
            <Server className="size-4" />
            Domains the audited site links out to ({stats.reciprocalDomains} reciprocal)
          </div>
          {analytics.outbound.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted">
              No outbound links detected on the pages we scanned.
            </p>
          ) : (
            analytics.outbound.map((item) => (
              <article
                key={item.domain}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
              >
                <a
                  href={item.sampleUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 font-mono text-sm text-fg hover:text-fg-soft"
                >
                  {item.domain}
                  <ArrowUpRight className="size-3.5 text-subtle" />
                </a>
                <div className="flex items-center gap-2">
                  {item.status && item.status >= 400 ? (
                    <Badge variant="nofollow">HTTP {item.status}</Badge>
                  ) : null}
                  {item.reciprocal ? <Badge variant="accent">reciprocal</Badge> : null}
                  <span className="font-mono text-xs tabular-nums text-muted">
                    {item.links} links
                  </span>
                </div>
              </article>
            ))
          )}
        </div>
      ) : null}

      {tab === "gap" ? <LinkGapPanel host={target.host} /> : null}

      {tab === "mentions" ? (
        <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
          {report.mentions.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted">
              No public mentions in news, Reddit, Bluesky or Hacker News.
            </p>
          ) : (
            report.mentions.map((item) => (
              <article key={item.sourceUrl} className="border-b border-border py-4 last:border-b-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <a
                    href={item.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-fg hover:text-fg-soft"
                  >
                    {item.sourceTitle}
                    <ArrowUpRight className="size-3.5 text-subtle" />
                  </a>
                  <div className="flex items-center gap-2">
                    {item.linkOpportunity ? <Badge variant="accent">link opportunity</Badge> : null}
                    <Badge>{SOURCE_LABEL[item.discoveredVia] ?? item.discoveredVia}</Badge>
                  </div>
                </div>
                <p className="mt-1 font-mono text-xs text-muted">{item.sourceHost}</p>
                <p className="mt-1 text-sm leading-relaxed text-subtle">{item.snippet}</p>
              </article>
            ))
          )}
        </div>
      ) : null}

      {tab === "issues" ? (
        <div className="grid gap-3 md:grid-cols-2">
          {analytics.issues.length === 0 ? (
            <div className="rounded-xl border border-border bg-surface p-6 md:col-span-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-follow" />
                <p className="text-sm text-fg">No problems detected in the profile.</p>
              </div>
            </div>
          ) : (
            analytics.issues.map((issue) => <IssueCard key={issue.id} issue={issue} />)
          )}
        </div>
      ) : null}

      {tab === "sources" ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {report.sources.map((source) => (
            <div key={source.id} className="rounded-lg border border-border bg-surface p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-fg">{source.label}</p>
                <Badge
                  variant={
                    source.status === "ok"
                      ? "follow"
                      : source.status === "error"
                        ? "nofollow"
                        : "default"
                  }
                >
                  {source.status === "ok"
                    ? "working"
                    : source.status === "error"
                      ? "error"
                      : source.status === "skipped"
                        ? "skipped"
                        : "empty"}
                </Badge>
              </div>
              <p className="mt-2 font-mono text-2xl tabular-nums text-fg">{source.found}</p>
              <p className="mt-1 text-xs text-subtle">
                {source.ms} ms{source.detail ? ` · ${source.detail}` : ""}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      <aside className="rounded-xl border border-border bg-surface-2 px-5 py-4 text-sm leading-relaxed text-muted">
        <p>
          Wikipedia, Reddit, Hacker News and Stack Exchange mark external links as{" "}
          <span className="text-fg-soft">nofollow</span> — they bring traffic and visibility, but
          pass no PageRank. The &ldquo;passes value&rdquo; column also accounts for the source
          page&rsquo;s meta robots: a dofollow link from a noindex page contributes nothing in
          practice. The domain score (DS) is an approximation built from public signals — age in the
          archive, TLD, presence in Wikipedia and the number of linking pages — not DR from a paid
          tool.
        </p>
      </aside>
    </section>
  );
}

