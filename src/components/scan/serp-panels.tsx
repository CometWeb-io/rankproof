import { ArrowDownRight, ArrowUpRight, Download, Minus, Swords, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FEATURE_LABEL } from "@/components/scan/serp-labels";
import { difficultyTone, posLabel } from "@/components/scan/serp-utils";
import { Meter } from "@/components/scan/ui-primitives";
import { cn } from "@/lib/utils";
import { download, rankMovesCsv } from "@/lib/backlinks/export";
import type { RankMove, SerpQuery, SerpSnapshot } from "@/lib/backlinks/types";

function MoveIcon({ state }: { state: RankMove["state"] }) {
  if (state === "up" || state === "new") return <ArrowUpRight className="size-3.5 text-follow" aria-hidden />;
  if (state === "down" || state === "lost") return <ArrowDownRight className="size-3.5 text-nofollow" aria-hidden />;
  return <Minus className="size-3.5 text-subtle" aria-hidden />;
}

export function RankMovesPanel({ moves, host }: { moves: RankMove[]; host: string }) {
  if (moves.length === 0) return null;
  const up = moves.filter((m) => m.state === "up").length;
  const down = moves.filter((m) => m.state === "down").length;
  const lost = moves.filter((m) => m.state === "lost").length;

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-fg">Gains and drops since the last scan</p>
          <p className="mt-1 font-mono text-xs text-muted">
            {up} up · {down} down · {lost} lost
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            download(`rankproof-${host}-rank-moves.csv`, rankMovesCsv(moves), "text/csv")
          }
        >
          <Download aria-hidden />
          Rank changes CSV
        </Button>
      </div>
      <ul className="mt-4 grid gap-2 md:grid-cols-2">
        {moves.slice(0, 12).map((move) => (
          <li
            key={`${move.engine}-${move.keyword}`}
            className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
          >
            <span className="min-w-0 truncate text-sm text-fg">{move.keyword}</span>
            <span className="flex shrink-0 items-center gap-2 font-mono text-xs text-muted">
              <MoveIcon state={move.state} />
              {posLabel(move.previous)} → {posLabel(move.current)}
              {move.change ? (
                <Badge variant={move.change > 0 ? "follow" : "nofollow"}>
                  {move.change > 0 ? `+${move.change}` : move.change}
                </Badge>
              ) : (
                <Badge variant={move.state === "new" ? "follow" : "nofollow"}>
                  {move.state === "new" ? "new" : "lost"}
                </Badge>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CannibalizationPanel({ snapshot }: { snapshot: SerpSnapshot }) {
  if (snapshot.cannibalization.length === 0) return null;
  return (
    <div className="rounded-xl border border-nofollow/40 bg-nofollow/5 p-5">
      <div className="flex items-center gap-2">
        <TriangleAlert className="size-4 text-nofollow" aria-hidden />
        <p className="text-sm font-medium text-fg">Possible keyword overlap</p>
      </div>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Two of your own URLs appear for the same query. Prefer one URL and consolidate the other with
        redirects or internal links.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {snapshot.cannibalization.map((item) => (
          <li key={`${item.engine}-${item.keyword}`} className="rounded-lg border border-border bg-surface p-3">
            <p className="text-sm font-medium text-fg">
              &ldquo;{item.keyword}&rdquo; <span className="font-mono text-xs text-muted">{item.engine}</span>
            </p>
            <ul className="mt-1 flex flex-col gap-1">
              {item.urls.map((url) => (
                <li key={url.url} className="truncate font-mono text-xs text-subtle">
                  #{url.position} · {url.url}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SerpCompetitorsPanel({ snapshot, host }: { snapshot: SerpSnapshot; host: string }) {
  if (snapshot.competitors.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-4">
        <div className="flex items-center gap-2">
          <Swords className="size-4 text-fg-soft" aria-hidden />
          <div>
            <p className="text-sm font-medium text-fg">SERP competitors</p>
            <p className="mt-1 text-xs text-muted">
              Domains taking positions on your keywords — sorted by share of clicks.
            </p>
          </div>
        </div>
        <span className="font-mono text-xs text-subtle">{host}</span>
      </div>
      {snapshot.competitors.slice(0, 12).map((row) => (
        <article
          key={row.domain}
          className="grid gap-3 border-b border-border py-3 last:border-b-0 md:grid-cols-[minmax(0,1.3fr)_auto] md:items-center"
        >
          <div className="min-w-0">
            <a
              href={row.sampleUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center gap-1.5 text-sm font-medium text-fg hover:text-fg-soft"
            >
              <span className="truncate">{row.domain}</span>
              <ArrowUpRight className="size-3.5 shrink-0 text-subtle" aria-hidden />
            </a>
            <p className="mt-1 font-mono text-xs text-muted">
              {row.keywords} keywords · coverage {row.overlap}% · best {posLabel(row.bestPosition)} · avg{" "}
              {row.avgPosition}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            {row.linksToTarget ? <Badge variant="follow">links to you</Badge> : null}
            <Badge variant="accent">SoV {row.shareOfVoice}%</Badge>
            <span className="font-mono text-xs tabular-nums text-muted">DS {row.domainScore}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

export function SerpExtrasPanel({ snapshot }: { snapshot: SerpSnapshot }) {
  if (snapshot.related.length === 0 && snapshot.questions.length === 0) return null;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {snapshot.related.length > 0 ? (
        <div className="rounded-xl border border-border bg-surface p-5">
          <p className="text-sm font-medium text-fg">Related searches</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {snapshot.related.slice(0, 18).map((item) => (
              <span key={item} className="rounded-full border border-border px-3 py-1 text-xs text-muted">
                {item}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {snapshot.questions.length > 0 ? (
        <div className="rounded-xl border border-border bg-surface p-5">
          <p className="text-sm font-medium text-fg">SERP questions</p>
          <p className="mt-1 text-xs text-muted">Ready-made H2 headings for an FAQ section.</p>
          <ul className="mt-3 flex flex-col gap-1.5">
            {snapshot.questions.slice(0, 10).map((item) => (
              <li key={item} className="text-sm text-fg-soft">
                · {item}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function SerpQueryCard({ query }: { query: SerpQuery }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">&ldquo;{query.keyword}&rdquo;</p>
          <p className="mt-1 font-mono text-xs text-muted">
            {query.engine} · TOP {query.depth} · {query.ms} ms
          </p>
          {query.features.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {query.features.map((feature) => (
                <Badge key={feature}>{FEATURE_LABEL[feature] ?? feature}</Badge>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          <Badge
            variant={
              query.targetPosition && query.targetPosition <= 3
                ? "follow"
                : query.targetPosition
                  ? "accent"
                  : "nofollow"
            }
          >
            you {posLabel(query.targetPosition)}
          </Badge>
          <span className="font-mono text-xs text-muted">difficulty {query.difficulty}/100</span>
          <span className="w-24">
            <Meter value={query.difficulty} tone={difficultyTone(query.difficulty)} />
          </span>
        </div>
      </div>
      {query.results.length === 0 ? (
        <p className="py-6 text-sm text-subtle">No organic results from this engine.</p>
      ) : (
        query.results.map((hit) => (
          <article
            key={`${query.engine}-${hit.position}-${hit.url}`}
            className={cn(
              "flex flex-wrap items-start justify-between gap-3 border-b border-border py-3 last:border-b-0",
              hit.isTarget && "bg-follow/5",
            )}
          >
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2">
                <span className="font-mono text-xs tabular-nums text-subtle">#{hit.position}</span>
                <a
                  href={hit.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex max-w-full items-center gap-1.5 truncate text-sm text-fg hover:text-fg-soft"
                >
                  {hit.title}
                  <ArrowUpRight className="size-3.5 shrink-0 text-subtle" aria-hidden />
                </a>
              </p>
              <p className="mt-1 truncate font-mono text-xs text-muted">
                {hit.domain} · DS {hit.domainScore} · CTR ~{hit.ctr}%
              </p>
              {hit.snippet ? <p className="mt-1 line-clamp-2 text-xs text-subtle">{hit.snippet}</p> : null}
            </div>
            {hit.isTarget ? <Badge variant="follow">Your URL</Badge> : null}
          </article>
        ))
      )}
    </div>
  );
}
