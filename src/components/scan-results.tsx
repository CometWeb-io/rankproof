import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  ArrowUpRight,
  BookOpenText,
  Download,
  FileJson,
  Filter,
  Gauge,
  Globe,
  Link2,
  Network,
  Newspaper,
  Radar,
  Search,
  ShieldCheck,
  ShieldOff,
  Server,
  FileText,
  Sparkles,
  Swords,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
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
  gapCsv,
  reportHtml,
  reportJson,
  targetPagesCsv,
} from "@/lib/backlinks/export";

import { scanLinkGap } from "@/lib/backlinks/scan";
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
import type {
  AnchorType,
  Backlink,
  CountStat,
  Issue,
  LinkGapReport,
  LinkPlacement,
  TrendPoint,
  LinkRel,
  ScanReport,
} from "@/lib/backlinks/types";


const SOURCE_LABEL: Record<string, string> = {
  wikipedia: "Wikipedia",
  "hacker-news": "Hacker News",
  reddit: "Reddit",
  bluesky: "Bluesky",
  stackexchange: "Stack Exchange",
  bing: "Bing",
  duckduckgo: "DuckDuckGo",
  mojeek: "Mojeek",
  news: "News",
  urlscan: "urlscan",
  github: "GitHub",
  commoncrawl: "Common Crawl",
  graph: "Graph / partner",
  sitemap: "Sitemap",
  archive: "Archive",
  lookup: "Report",
  page: "Deep scan",
};

const PLACEMENT_LABEL: Record<LinkPlacement, string> = {
  content: "in content",
  navigation: "menu",
  footer: "footer",
  sidebar: "sidebar",
  comment: "comment",
  unknown: "unknown",
};

const ANCHOR_LABEL: Record<AnchorType, string> = {
  brand: "brand",
  "exact-match": "exact-match",
  url: "URL",
  generic: "generic",
  image: "image",
  empty: "empty",
  "long-tail": "long tail",
};

const FLAG_LABEL: Record<string, string> = {
  "broken-target": "broken target",
  "noindex-source": "noindex source",
  "page-level-nofollow": "page nofollow",
  boilerplate: "boilerplate",
  sitewide: "sitewide",
  "spam-risk": "spam risk",
  "high-authority": "high authority",
  "image-link": "image link",
  lost: "lost",
  reciprocal: "reciprocal",
  "redirected-target": "redirected target",
  "off-topic": "off-topic",
  "serp-coranker": "co-ranks",
};


type Tab =
  | "overview"
  | "plan"
  | "performance"
  | "structure"
  | "serp"
  | "keywords"
  | "links"
  | "domains"
  | "pages"
  | "anchors"
  | "toxic"
  | "outbound"
  | "gap"
  | "prospects"
  | "mentions"
  | "issues"
  | "sources";


type LinkFilter =
  | "all"
  | "dofollow"
  | "nofollow"
  | "content"
  | "authority"
  | "ontopic"
  | "risk"
  | "broken"
  | "lost"
  | "new";

type SortKey = "score" | "authority" | "relevance" | "domain" | "recent";

function relVariant(item: Backlink): "follow" | "nofollow" | "default" {
  if (item.effectiveFollow) return "follow";
  return "nofollow";
}

function relLabel(rel: LinkRel): string {
  if (rel === "dofollow") return "dofollow";
  if (rel === "sponsored") return "sponsored";
  if (rel === "ugc") return "ugc";
  return "nofollow";
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

/* ------------------------------------------------------------------ */
/* Elementy pomocnicze                                                 */
/* ------------------------------------------------------------------ */

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "follow" | "nofollow" | "default";
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-[var(--shadow-panel)]">
      <p className="text-xs font-medium tracking-wide text-muted uppercase">{label}</p>
      <p
        className={cn(
          "mt-2 font-mono text-3xl tabular-nums tracking-tight",
          tone === "follow" && "text-follow",
          tone === "nofollow" && "text-nofollow",
          (!tone || tone === "default") && "text-fg",
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-subtle">{hint}</p> : null}
    </div>
  );
}

function Meter({
  value,
  max = 100,
  tone = "default",
}: {
  value: number;
  max?: number;
  tone?: "default" | "risk" | "good";
}) {
  const width = Math.max(2, Math.min(100, Math.round((value / max) * 100)));
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
      <span
        className={cn(
          "block h-full rounded-full",
          tone === "risk" && "bg-nofollow",
          tone === "good" && "bg-follow",
          tone === "default" && "bg-fg-soft",
        )}
        style={{ width: `${width}%` }}
      />
    </span>
  );
}

function DistributionList({
  title,
  stats,
  labelMap,
  empty,
}: {
  title: string;
  stats: CountStat[];
  labelMap?: Record<string, string>;
  empty?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-xs font-medium tracking-wide text-muted uppercase">{title}</p>
      {stats.length === 0 ? (
        <p className="mt-3 text-sm text-subtle">{empty ?? "No data"}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2.5">
          {stats.map((stat) => (
            <li key={stat.key}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-sm text-fg-soft">
                  {labelMap?.[stat.key] ?? stat.key}
                </span>
                <span className="font-mono text-xs tabular-nums text-muted">
                  {stat.count} · {stat.share}%
                </span>
              </div>
              <div className="mt-1">
                <Meter value={stat.share} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BacklinkRow({ item, isNew }: { item: Backlink; isNew: boolean }) {
  return (
    <article className="grid gap-3 border-b border-border py-4 last:border-b-0 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto] md:items-start">
      <div className="min-w-0">
        <a
          href={item.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="group inline-flex max-w-full items-start gap-1.5 text-sm font-medium text-fg hover:text-fg-soft"
        >
          <span className="truncate">{item.sourceTitle || item.sourceHost}</span>
          <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-subtle group-hover:text-fg" />
        </a>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-muted">
          <span className="truncate">{item.sourceHost}</span>
          <span className="text-subtle">·</span>
          <span title="Domain score (0–100)">DS {item.domainScore}</span>
          <span className="text-subtle">·</span>
          <span title="Topical relevance (0–100)">TM {item.relevance}</span>
          {item.firstSeen ? (
            <>
              <span className="text-subtle">·</span>
              <span title="First seen in the archive">since {item.firstSeen.slice(0, 4)}</span>
            </>
          ) : null}
          {item.sourceLang ? (
            <>
              <span className="text-subtle">·</span>
              <span>{item.sourceLang}</span>
            </>
          ) : null}
        </p>
        <div className="mt-2 max-w-[220px]">
          <Meter
            value={item.domainScore}
            tone={item.spamScore >= 55 ? "risk" : item.domainScore >= 70 ? "good" : "default"}
          />
        </div>
      </div>

      <div className="min-w-0">
        <p className="text-xs text-subtle">Link target</p>
        <p className="truncate font-mono text-xs text-fg-soft">{item.targetPath}</p>
        {item.anchor ? (
          <p className="mt-1 truncate text-sm text-muted">„{item.anchor}”</p>
        ) : (
          <p className="mt-1 text-sm text-subtle">no text anchor</p>
        )}
        <p className="mt-1 text-xs text-subtle">
          {ANCHOR_LABEL[item.anchorType]} · {PLACEMENT_LABEL[item.placement]}
          {item.targetStatus ? ` · HTTP ${item.targetStatus}` : ""}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        {isNew ? <Badge variant="accent">new</Badge> : null}
        {item.state === "lost" ? (
          <Badge variant="nofollow">lost{item.lastSeen ? ` · ${item.lastSeen}` : ""}</Badge>
        ) : (
          <Badge variant={relVariant(item)}>{relLabel(item.rel)}</Badge>
        )}
        <Badge>{SOURCE_LABEL[item.discoveredVia] ?? item.discoveredVia}</Badge>
        {item.flags
          .filter((flag) => flag !== "sitewide" || item.sitewide)
          .slice(0, 2)
          .map((flag) => (
            <Badge
              key={flag}
              variant={
                flag === "high-authority"
                  ? "follow"
                  : flag === "broken-target" || flag === "spam-risk"
                    ? "nofollow"
                    : "default"
              }
            >
              {FLAG_LABEL[flag] ?? flag}
            </Badge>
          ))}
      </div>
    </article>
  );
}

function IssueCard({ issue }: { issue: Issue }) {
  const tone =
    issue.severity === "high"
      ? "border-nofollow/40 bg-nofollow/10"
      : issue.severity === "medium"
        ? "border-border-strong bg-surface-2"
        : "border-border bg-surface";
  return (
    <div className={cn("rounded-lg border p-4", tone)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <AlertTriangle
            className={cn(
              "mt-0.5 size-4 shrink-0",
              issue.severity === "high" ? "text-nofollow" : "text-muted",
            )}
          />
          <p className="text-sm font-medium text-fg">{issue.title}</p>
        </div>
        <Badge variant={issue.severity === "high" ? "nofollow" : "default"}>{issue.count}</Badge>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted">{issue.detail}</p>
      {issue.samples.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1">
          {issue.samples.map((sample) => (
            <li key={sample} className="truncate font-mono text-xs text-subtle">
              {sample}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function DiffStrip({
  diff,
  ratingDelta,
  visibilityDelta,
  persisted,
}: {
  diff: ScanDiff;
  ratingDelta?: number;
  visibilityDelta?: number;
  persisted?: boolean;
}) {
  const positive = diff.backlinkDelta >= 0;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border bg-surface-2 px-5 py-3 text-sm">
      <span className="flex items-center gap-2 text-muted">
        {positive ? (
          <TrendingUp className="size-4 text-follow" />
        ) : (
          <TrendingDown className="size-4 text-nofollow" />
        )}
        Zmiana od {formatDate(diff.previousAt)}
      </span>
      <span className="font-mono text-xs text-fg-soft">
        links {diff.backlinkDelta >= 0 ? "+" : ""}
        {diff.backlinkDelta}
      </span>
      <span className="font-mono text-xs text-fg-soft">
        domeny {diff.domainDelta >= 0 ? "+" : ""}
        {diff.domainDelta}
      </span>
      <span className="font-mono text-xs text-follow">nowe {diff.newLinks}</span>
      <span className="font-mono text-xs text-nofollow">lost {diff.lostLinks}</span>
      <span className="font-mono text-xs text-muted">
        kondycja {diff.healthDelta >= 0 ? "+" : ""}
        {diff.healthDelta}
      </span>
      {ratingDelta !== undefined ? (
        <span className="font-mono text-xs text-muted">
          DR {ratingDelta >= 0 ? "+" : ""}
          {ratingDelta}
        </span>
      ) : null}
      {visibilityDelta !== undefined ? (
        <span className="font-mono text-xs text-muted">
          SERP {visibilityDelta >= 0 ? "+" : ""}
          {visibilityDelta}
        </span>
      ) : null}
      {persisted ? <Badge>historia w bazie</Badge> : null}
    </div>
  );
}

function GrowthChart({ stats }: { stats: CountStat[] }) {
  const max = Math.max(...stats.map((s) => s.count), 1);
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-xs font-medium tracking-wide text-muted uppercase">
        Referring domain growth (first seen in the archive)
      </p>
      {stats.length === 0 ? (
        <p className="mt-3 text-sm text-subtle">No domain-age data yet.</p>
      ) : (
        <div className="mt-4 flex h-32 items-end gap-1.5">
          {stats.map((stat) => (
            <div key={stat.key} className="flex flex-1 flex-col items-center gap-1">
              <span className="font-mono text-[10px] tabular-nums text-subtle">{stat.count}</span>
              <span
                className="w-full rounded-t bg-fg-soft/70"
                style={{ height: `${Math.max(4, (stat.count / max) * 100)}%` }}
              />
              <span className="font-mono text-[10px] text-subtle">
                {stat.key === "nieznany" ? "?" : stat.key.slice(2)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TrendChart({ points }: { points: TrendPoint[] }) {
  if (points.length < 2) return null;
  const max = Math.max(...points.map((p) => p.referringDomains), 1);
  const maxDr = Math.max(...points.map((p) => p.domainRating), 1);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium tracking-wide text-muted uppercase">
          Profile trend ({points.length} scans)
        </p>
        <p className="font-mono text-xs text-muted">
          domains {first.referringDomains} → {last.referringDomains} · DR {first.domainRating} →{" "}
          {last.domainRating}
        </p>
      </div>
      <div className="mt-4 flex h-28 items-end gap-1">
        {points.map((point) => (
          <div
            key={point.at}
            className="group relative flex flex-1 flex-col justify-end gap-0.5"
            title={`${new Date(point.at).toLocaleDateString()} · ${point.referringDomains} referring domains · DR ${point.domainRating}`}
          >
            <span
              className="w-full rounded-t bg-fg-soft/70"
              style={{ height: `${Math.max(4, (point.referringDomains / max) * 78)}%` }}
            />
            <span
              className="w-full rounded-t bg-follow/60"
              style={{ height: `${Math.max(2, (point.domainRating / maxDr) * 22)}%` }}
            />
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-subtle">
        Top bars: referring domains. Bottom: Domain Rating. History is stored server-side, so the
        trend follows you to another device.
      </p>
    </div>
  );
}

function LinkGapPanel({ host }: { host: string }) {
  const runGap = useServerFn(scanLinkGap);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gap, setGap] = useState<LinkGapReport | null>(null);

  async function run() {
    const competitors = value
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 5);
    if (competitors.length === 0) {
      setError("Enter 1–5 competitor domains, separated by commas.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await runGap({ data: { url: host, competitors } });
      if (!result.ok) {
        setGap(null);
        setError(result.error);
        return;
      }
      setGap(result.report);
    } catch (err) {
      setGap(null);
      setError(err instanceof Error ? err.message : "The analysis failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-border bg-surface p-5">
        <div className="flex items-center gap-2">
          <Swords className="size-4 text-fg-soft" />
          <p className="text-sm font-medium text-fg">Link gap vs competitors</p>
        </div>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          Give us up to five competitor domains. We run a quick scan on each and show the domains that
          link to them but not to you, most frequent first. That is a ready-made target list for
          outreachu.
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="rival.com, other.com"
            disabled={loading}
          />
          <Button onClick={() => void run()} disabled={loading} className="sm:w-52">
            {loading ? <Radar className="animate-spin" /> : <Users />}
            {loading ? "Analysing…" : "Compare profiles"}
          </Button>
        </div>
        {error ? (
          <p className="mt-3 text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {gap ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {gap.competitors.map((competitor) => (
              <div key={competitor.host} className="rounded-lg border border-border bg-surface p-4">
                <p className="truncate font-mono text-sm text-fg">{competitor.host}</p>
                {competitor.error ? (
                  <p className="mt-2 text-xs text-nofollow">{competitor.error}</p>
                ) : (
                  <p className="mt-2 font-mono text-xs text-muted">
                    DR {competitor.domainRating} · {competitor.referringDomains} domen ·{" "}
                    {competitor.backlinks} links
                  </p>
                )}
              </div>
            ))}
            <div className="rounded-lg border border-border bg-surface-2 p-4">
              <p className="text-xs text-muted uppercase">Shared domains</p>
              <p className="mt-2 font-mono text-2xl tabular-nums text-fg">{gap.shared.length}</p>
              <p className="mt-1 text-xs text-subtle">{gap.unique.length} domen tylko u Ciebie</p>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-4">
              <p className="text-sm text-muted">{gap.gap.length} domen do zdobycia</p>
              <Button
                variant="outline"
                size="sm"
                disabled={gap.gap.length === 0}
                onClick={() =>
                  download(`rankproof-luka-${gap.target}.csv`, gapCsv(gap), "text/csv")
                }
              >
                <Download />
                Eksport CSV
              </Button>
            </div>
            {gap.gap.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted">
                No domains found that link to the competitors while skipping you.
              </p>
            ) : (
              gap.gap.slice(0, 80).map((row) => (
                <article
                  key={row.domain}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
                >
                  <div className="min-w-0">
                    <a
                      href={row.sampleUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 font-mono text-sm text-fg hover:text-fg-soft"
                    >
                      {row.domain}
                      <ArrowUpRight className="size-3.5 text-subtle" />
                    </a>
                    <p className="mt-1 text-xs text-subtle">
                      links to: {row.competitors.join(", ")}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={row.dofollow ? "follow" : "default"}>
                      {row.dofollow ? "dofollow" : "nofollow"}
                    </Badge>
                    <Badge variant={row.competitors.length > 1 ? "accent" : "default"}>
                      {row.competitors.length} z {gap.competitors.length}
                    </Badge>
                    <span className="font-mono text-xs tabular-nums text-muted">
                      priority {row.priority} · DS {row.domainScore}
                    </span>
                  </div>
                </article>
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

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
              {target.parked ? <Badge variant="nofollow">zaparkowana</Badge> : null}
              {target.usedArchive ? <Badge>kopia archiwalna</Badge> : null}
              {target.redirectHost ? (
                <Badge variant="nofollow">→ {target.redirectHost}</Badge>
              ) : null}
              {target.subdomains.length > 0 ? (
                <Badge>{target.subdomains.length} subdomen</Badge>
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

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        {(
          [
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
          ] as const
        ).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "h-11 rounded-full border px-4 text-sm font-medium transition-colors duration-[var(--motion-quick)]",
              tab === id
                ? "border-fg-soft bg-fg text-accent-fg"
                : "border-border bg-surface text-muted hover:text-fg",
            )}
          >
            {label}
            {count > 0 ? (
              <span className="ml-2 font-mono text-xs tabular-nums opacity-70">{count}</span>
            ) : null}
          </button>
        ))}
      </div>

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
                  {domain.reciprocal ? <Badge>wzajemny</Badge> : null}
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
                  <span>{page.domains} domen</span>
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
                  {item.reciprocal ? <Badge variant="accent">wzajemny</Badge> : null}
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
                        : "pusto"}
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

export function ScanSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-live="polite" aria-busy="true">
      <div className="h-40 animate-pulse rounded-xl bg-surface-2" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-surface-2" />
        ))}
      </div>
      <div className="flex items-start gap-3 text-sm text-muted">
        <Radar className="mt-0.5 size-4 shrink-0 animate-spin" />
        <p className="leading-relaxed">
          Reading the page, sitemap and archive, extracting keywords from titles and H1s, asking
          Bing and DuckDuckGo for positions, then reaching out to Wikipedia, GitHub, Reddit and the
          remaining sources. Every candidate is opened as HTML — anchor, section, meta robots and
          target status included…
        </p>
      </div>
      <div className="h-72 animate-pulse rounded-xl bg-surface-2" />
    </div>
  );
}

export function EmptyGuide() {
  const items = [
    {
      icon: BookOpenText,
      title: "The target's graph, not guesswork",
      body: "We start from the live site, its sitemap, subdomains and Internet Archive copies. From the highest-value pages (services, portfolio, case studies, blog) we build a graph of partners — the richest source of genuine backlinks.",
    },
    {
      icon: Network,
      title: "Thirteen open sources",
      body: "Wikipedia and Wikimedia, GitHub, Hacker News, Reddit, Stack Exchange, Bluesky, Bing, DuckDuckGo, Mojeek, Google News, GDELT, urlscan.io and Common Crawl. Each result is a candidate, not a finished link.",
    },
    {
      icon: ShieldCheck,
      title: "Verification in three waves",
      body: "We open the candidate page and look for an a href pointing at the target. We check rel, meta robots, the document section (content, footer, menu), language and the status of the target URL. If a domain does link, we go deeper into its pages.",
    },
    {
      icon: Sparkles,
      title: "SERP and keywords, not just a link list",
      body: "From titles, H1s and exact-match anchors we build a keyword list, check the top 10 in Bing and DuckDuckGo, compute visibility, and point out pages that already rank but do not link to you.",
    },
  ];
  return (
    <section className="grid gap-3 md:grid-cols-2">
      {items.map((item) => (
        <div key={item.title} className="rounded-xl border border-border bg-surface p-5">
          <item.icon className="size-5 text-fg-soft" />
          <h3 className="mt-4 text-sm font-medium text-fg">{item.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted">{item.body}</p>
        </div>
      ))}
      <div className="rounded-xl border border-border bg-surface-2 p-5 md:col-span-2">
        <div className="flex items-start gap-3">
          <ShieldOff className="mt-0.5 size-4 shrink-0 text-muted" />
          <p className="text-sm leading-relaxed text-muted">
            This is not a full index of the web. RankProof goes deep into one site&rsquo;s graph and
            verifies every link in the source HTML, instead of pretending to billions of URLs from a
            paid database. For a small site the result may be short — and then it is honest.
          </p>
        </div>
      </div>
      <div className="rounded-xl border border-border bg-surface p-5 md:col-span-2">
        <div className="flex items-start gap-3">
          <Newspaper className="mt-0.5 size-4 shrink-0 text-fg-soft" />
          <p className="text-sm leading-relaxed text-muted">
            Results export to CSV (links and domains separately) or to JSON with the full report —
            domain scores, flags and profile analytics included.
          </p>
        </div>
      </div>
    </section>
  );
}
