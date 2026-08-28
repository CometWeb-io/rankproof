import { useState } from "react";
import { Activity, Download, Layers, ListChecks, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { clustersCsv, contentGapCsv, download, planCsv } from "@/lib/backlinks/export";
import type {
  ActionArea,
  ActionEffort,
  ActionItem,
  ScanReport,
  SegmentStat,
} from "@/lib/backlinks/types";

const AREA_LABEL: Record<ActionArea, string> = {
  serp: "SERP",
  content: "content",
  links: "links",
  risk: "risk",
  "on-page": "on-page",
};

const EFFORT_LABEL: Record<ActionEffort, string> = {
  low: "low effort",
  medium: "medium effort",
  high: "high effort",
};

const SEGMENT_LABEL: Record<SegmentStat["segment"], string> = {
  media: "media",
  blog: "blogs",
  forum: "forums",
  "edu-gov": "edu / gov",
  directory: "directories",
  social: "social",
  shop: "shops",
  company: "company sites",
  code: "repositories",
  other: "other",
};

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

/**
 * The action plan tab: one task list sorted by impact weighted against
 * effort, plus context — link momentum and profile segments.
 */
export function PlanTab({ report }: { report: ScanReport }) {
  const [area, setArea] = useState<ActionArea | "all">("all");
  const { plan, velocity, segments } = report;
  const visible = area === "all" ? plan.items : plan.items.filter((item) => item.area === area);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Zadania</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">{plan.items.length}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Szybkie wygrane</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">{plan.quickWins}</p>
          <p className="mt-1 text-xs text-subtle">low effort, high impact</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Stan realizacji</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">{plan.coverage}</p>
          <div className="mt-2">
            <Meter value={plan.coverage} tone={plan.coverage >= 70 ? "good" : "default"} />
          </div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Link velocity</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">{velocity.perMonth}</p>
          <p className="mt-1 text-xs text-subtle">new domains / month</p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-surface p-5">
        <div className="flex items-center gap-2">
          <Activity className="size-4 text-fg-soft" />
          <p className="text-sm font-medium text-fg">Link profile momentum</p>
          <Badge
            variant={
              velocity.verdict === "growing"
                ? "follow"
                : velocity.verdict === "declining"
                  ? "nofollow"
                  : "default"
            }
          >
            {velocity.verdict === "unknown" ? "unknown" : velocity.verdict}
          </Badge>
        </div>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">{velocity.hint}</p>
        <p className="mt-2 font-mono text-xs text-subtle">
          {velocity.last12m} new domains in 12 months · change {velocity.trend}% · lost links{" "}
          {velocity.lostRatio}%
        </p>
      </div>

      {segments.length > 0 ? (
        <div className="rounded-xl border border-border bg-surface p-5">
          <div className="flex items-center gap-2">
            <Layers className="size-4 text-fg-soft" />
            <p className="text-sm font-medium text-fg">Profile composition by site type</p>
          </div>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {segments.map((segment) => (
              <li key={segment.segment} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-fg-soft">{SEGMENT_LABEL[segment.segment]}</span>
                  <Badge variant={segment.verdict === "high" ? "nofollow" : segment.verdict === "ok" ? "follow" : "default"}>
                    {segment.share}%
                  </Badge>
                </div>
                <div className="mt-2">
                  <Meter
                    value={segment.share}
                    tone={segment.verdict === "high" ? "risk" : segment.verdict === "ok" ? "good" : "default"}
                  />
                </div>
                <p className="mt-2 font-mono text-xs text-subtle">
                  {segment.domains} domains · {segment.links} links · DS {segment.avgDomainScore}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {(["all", "serp", "content", "links", "risk", "on-page"] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setArea(item)}
            className={cn(
              "h-9 rounded-full border px-3 text-xs transition-colors",
              area === item
                ? "border-fg-soft bg-fg text-accent-fg"
                : "border-border bg-surface-2 text-muted hover:text-fg",
            )}
          >
            {item === "all" ? "all" : AREA_LABEL[item]}
          </button>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={plan.items.length === 0}
          onClick={() => download(`rankproof-${report.target.host}-plan.csv`, planCsv(report), "text/csv")}
        >
          <Download />
          Plan CSV
        </Button>
      </div>

      <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
        <div className="flex items-center gap-2 border-b border-border py-4">
          <ListChecks className="size-4 text-fg-soft" />
          <p className="text-sm font-medium text-fg">What to do, in this order</p>
        </div>
        {visible.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted">
            Nothing to do in this area. It looks in order.
          </p>
        ) : (
          visible.map((item, index) => <PlanRow key={item.id} item={item} index={index + 1} />)
        )}
      </div>

      <ClustersPanel report={report} />
      <ContentGapPanel report={report} />
    </div>
  );
}

function PlanRow({ item, index }: { item: ActionItem; index: number }) {
  return (
    <article className="grid gap-3 border-b border-border py-4 last:border-b-0 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-start">
      <span className="font-mono text-sm tabular-nums text-subtle md:pt-0.5">{index}.</span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-fg">{item.title}</p>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted">{item.detail}</p>
        {item.samples.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.samples.map((sample) => (
              <span
                key={sample}
                className="max-w-full truncate rounded-full border border-border px-2.5 py-0.5 font-mono text-xs text-subtle"
              >
                {sample}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 md:flex-col md:items-end">
        <Badge variant="accent">{AREA_LABEL[item.area]}</Badge>
        <Badge variant={item.effort === "low" ? "follow" : "default"}>
          {item.effort === "low" ? (
            <span className="flex items-center gap-1">
              <Zap className="size-3" />
              {EFFORT_LABEL[item.effort]}
            </span>
          ) : (
            EFFORT_LABEL[item.effort]
          )}
        </Badge>
        <span className="font-mono text-xs tabular-nums text-muted">
          priority {item.priority} · impact {item.impact}
        </span>
      </div>
    </article>
  );
}

function ClustersPanel({ report }: { report: ScanReport }) {
  const clusters = report.serp.clusters.filter((cluster) => cluster.keywords.length > 1);
  if (clusters.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-4">
        <div>
          <p className="text-sm font-medium text-fg">Keyword clusters</p>
          <p className="mt-1 max-w-2xl text-xs text-muted">
            Keywords the search engine answers with the same pages — one piece of content can serve the whole cluster.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            download(`rankproof-${report.target.host}-clusters.csv`, clustersCsv(report), "text/csv")
          }
        >
          <Download />
          Clusters CSV
        </Button>
      </div>
      {clusters.slice(0, 12).map((cluster) => (
        <article key={cluster.id} className="border-b border-border py-4 last:border-b-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium text-fg">{cluster.head}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={cluster.strategy === "one-page" ? "follow" : "default"}>
                {cluster.strategy === "one-page" ? "one page" : "separate pages"}
              </Badge>
              <span className="font-mono text-xs tabular-nums text-muted">
                difficulty {cluster.difficulty} · {cluster.overlap} shared URLs
              </span>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {cluster.keywords.map((keyword) => (
              <span key={keyword} className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted">
                {keyword}
              </span>
            ))}
          </div>
          <p className="mt-2 text-xs text-subtle">{cluster.hint}</p>
        </article>
      ))}
    </div>
  );
}

function ContentGapPanel({ report }: { report: ScanReport }) {
  const missing = report.serp.contentGaps.filter((term) => !term.onTarget);
  if (missing.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-fg">Content gaps</p>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
            Terms that recur across the top-ranking pages and are missing from yours. This is the
            vocabulary the search engine expects on this topic — not a list to stuff.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            download(
              `rankproof-${report.target.host}-content-gaps.csv`,
              contentGapCsv(report),
              "text/csv",
            )
          }
        >
          <Download />
          Luki CSV
        </Button>
      </div>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {missing.slice(0, 24).map((term) => (
          <li
            key={term.term}
            className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
          >
            <span className="min-w-0 truncate text-sm text-fg">{term.term}</span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
              {term.competitorPages} pages · {term.coverage}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
