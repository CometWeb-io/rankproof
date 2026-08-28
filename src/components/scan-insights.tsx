import { Activity, AlertTriangle, ArrowUpRight, Link2, MousePointerClick, Network } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { download, searchConsoleCsv, siteAuditCsv } from "@/lib/backlinks/export";
import type {
  SearchConsoleInsights,
  SerpSnapshot,
  SerpStatus,
  SiteAudit,
} from "@/lib/backlinks/types";

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

const STATUS_LABEL: Record<SerpStatus, string> = {
  ok: "working",
  "no-results": "no results",
  blocked: "blocked",
  "rate-limited": "rate limited",
  "parser-failed": "parser out of date",
  "empty-response": "empty response",
  "not-configured": "not configured",
  error: "request failed",
};

/**
 * Engine health. A CAPTCHA and a genuine zero look identical in the numbers,
 * so we say which one happened instead of letting the user assume.
 */
export function EngineHealthPanel({ snapshot }: { snapshot: SerpSnapshot }) {
  if (snapshot.engineHealth.length === 0) return null;
  const broken = snapshot.engineHealth.filter((item) => item.status !== "ok");
  if (broken.length === 0) return null;

  return (
    <div className="rounded-xl border border-nofollow/40 bg-nofollow/5 p-5">
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 text-nofollow" />
        <p className="text-sm font-medium text-fg">Measurement problems</p>
      </div>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        These engines did not return usable results, so the visibility figures below are based on
        fewer sources than intended. This is a limit of the measurement, not a statement about your
        site.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {snapshot.engineHealth.map((item) => (
          <li
            key={item.engine}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2"
          >
            <span className="text-sm text-fg">{item.engine}</span>
            <span className="flex items-center gap-2">
              <Badge variant={item.status === "ok" ? "follow" : "nofollow"}>
                {STATUS_LABEL[item.status]}
              </Badge>
              <span className="font-mono text-xs text-muted">
                {item.queries} queries · {item.hits} results
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-subtle">
        Run <span className="font-mono">npm run cli -- doctor</span> to check whether the engine is
        blocking you or the parser needs updating.
      </p>
    </div>
  );
}

/** Real clicks and impressions from a connected Search Console account. */
export function SearchConsolePanel({
  insights,
  host,
}: {
  insights: SearchConsoleInsights;
  host: string;
}) {
  if (!insights.connected) {
    return (
      <div className="rounded-xl border border-border bg-surface-2 p-5">
        <p className="text-sm font-medium text-fg">Search Console is not connected</p>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          {insights.hint} Connecting an account replaces several estimates with measured data — real
          clicks, impressions and Google positions. See <span className="font-mono">docs/search-console.md</span>.
        </p>
      </div>
    );
  }

  const totals = insights.providers
    .filter((provider) => provider.connected)
    .map((provider) => ({ source: provider.source, ...provider.totals, days: provider.days }));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {totals.map((item) => (
          <div key={item.source} className="rounded-lg border border-border bg-surface p-4">
            <p className="text-xs font-medium tracking-wide text-muted uppercase">
              {item.source === "google" ? "Google" : "Bing"} · {item.days} days
            </p>
            <p className="mt-2 font-mono text-3xl tabular-nums text-fg">{item.clicks}</p>
            <p className="mt-1 text-xs text-subtle">
              {item.impressions} impressions · CTR {item.ctr}% · avg #{item.position}
            </p>
          </div>
        ))}
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">CTR model check</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">
            {insights.accuracy.verdict === "unknown" ? "—" : `±${insights.accuracy.meanAbsoluteError}`}
          </p>
          <p className="mt-1 text-xs text-subtle">
            {insights.accuracy.verdict === "unknown"
              ? "not enough data"
              : `our estimate is ${insights.accuracy.verdict} (${insights.accuracy.samples} queries)`}
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-surface-2 p-5">
        <p className="text-sm leading-relaxed text-muted">{insights.hint}</p>
      </div>

      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => download(`rankproof-${host}-search-console.csv`, searchConsoleCsv(insights), "text/csv")}
        >
          Export CSV
        </Button>
      </div>

      {insights.striking.length > 0 ? (
        <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
          <div className="flex items-center gap-2 border-b border-border py-4">
            <MousePointerClick className="size-4 text-fg-soft" />
            <div>
              <p className="text-sm font-medium text-fg">Within reach of the top three</p>
              <p className="mt-1 text-xs text-muted">
                Already earning impressions — the traffic upside here is measured, not modelled.
              </p>
            </div>
          </div>
          {insights.striking.map((row) => (
            <article
              key={row.query}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-fg">{row.query}</span>
              <span className="flex items-center gap-2 font-mono text-xs text-muted">
                <Badge variant="accent">#{row.position}</Badge>
                {row.impressions} impr · {row.clicks} clicks
                <Badge variant="follow">+{row.potentialClicks}</Badge>
              </span>
            </article>
          ))}
        </div>
      ) : null}

      {insights.ctrAnomalies.length > 0 ? (
        <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
          <div className="flex items-center gap-2 border-b border-border py-4">
            <Activity className="size-4 text-fg-soft" />
            <div>
              <p className="text-sm font-medium text-fg">Ranking fine, nobody clicks</p>
              <p className="mt-1 text-xs text-muted">
                A title and description problem — no links or new content required.
              </p>
            </div>
          </div>
          {insights.ctrAnomalies.map((row) => (
            <article
              key={row.query}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-fg">{row.query}</span>
              <span className="flex items-center gap-2 font-mono text-xs text-muted">
                #{row.position} · CTR {row.ctr}% vs {row.expectedCtr}%
                <Badge variant="nofollow">−{row.lostClicks} clicks</Badge>
              </span>
            </article>
          ))}
        </div>
      ) : null}

      {insights.comparison.length > 0 ? (
        <div className="rounded-xl border border-border bg-surface p-5">
          <p className="text-sm font-medium text-fg">Google vs. our measurement</p>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            We measure Bing, DuckDuckGo, Mojeek and Brave. This is how far those positions sit from
            what Google actually reports — useful context for every scraped number in this report.
          </p>
          <ul className="mt-3 grid gap-2 md:grid-cols-2">
            {insights.comparison.slice(0, 10).map((row) => (
              <li
                key={row.query}
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <span className="min-w-0 truncate text-sm text-fg">{row.query}</span>
                <span className="font-mono text-xs text-muted">
                  Google #{row.google} · ours #{row.measured}
                  <span className={cn("ml-2", Math.abs(row.gap) > 3 ? "text-nofollow" : "text-follow")}>
                    {row.gap > 0 ? `+${row.gap}` : row.gap}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Internal linking and technical hygiene of the site itself. */
export function SiteAuditPanel({ audit, host }: { audit: SiteAudit; host: string }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Structure score</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">{audit.score}</p>
          <div className="mt-2">
            <Meter value={audit.score} tone={audit.score >= 70 ? "good" : audit.score < 45 ? "risk" : "default"} />
          </div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Pages crawled</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">{audit.crawled}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Orphans</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">{audit.orphans}</p>
          <p className="mt-1 text-xs text-subtle">no internal links</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Avg. depth</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">{audit.avgDepth}</p>
          <p className="mt-1 text-xs text-subtle">max {audit.maxDepth} clicks</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Broken / redirects</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">
            {audit.brokenInternal}
            <span className="text-muted"> / {audit.redirectedInternal}</span>
          </p>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => download(`rankproof-${host}-site-audit.csv`, siteAuditCsv(audit), "text/csv")}
        >
          Export CSV
        </Button>
      </div>

      {audit.issues.length > 0 ? (
        <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
          <div className="flex items-center gap-2 border-b border-border py-4">
            <Network className="size-4 text-fg-soft" />
            <p className="text-sm font-medium text-fg">Structural problems</p>
          </div>
          {audit.issues.map((item) => (
            <article key={item.id} className="border-b border-border py-4 last:border-b-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-fg">{item.title}</p>
                <Badge variant={item.severity === "high" ? "nofollow" : "default"}>{item.severity}</Badge>
              </div>
              <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted">{item.detail}</p>
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
            </article>
          ))}
        </div>
      ) : null}

      <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
        <div className="flex items-center gap-2 border-b border-border py-4">
          <Link2 className="size-4 text-fg-soft" />
          <p className="text-sm font-medium text-fg">Most linked internal pages</p>
        </div>
        {audit.pages.slice(0, 25).map((page) => (
          <article
            key={page.url}
            className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <a
                href={page.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex max-w-full items-center gap-1.5 truncate text-sm text-fg hover:text-fg-soft"
              >
                {page.path}
                <ArrowUpRight className="size-3.5 shrink-0 text-subtle" />
              </a>
              {page.title ? <p className="mt-1 truncate text-xs text-subtle">{page.title}</p> : null}
            </div>
            <span className="flex shrink-0 items-center gap-2 font-mono text-xs text-muted">
              {page.noindex ? <Badge variant="nofollow">noindex</Badge> : null}
              {page.backlinks > 0 ? <Badge variant="follow">{page.backlinks} backlinks</Badge> : null}
              depth {page.depth} · in {page.inboundLinks} · out {page.outboundLinks}
            </span>
          </article>
        ))}
      </div>
    </div>
  );
}
