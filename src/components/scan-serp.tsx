import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowDownRight,
  ArrowUpRight,
  Copy,
  Download,
  FileSearch,
  KeyRound,
  Lightbulb,
  Minus,
  Radar,
  Search,
  Sparkles,
  Swords,
  TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { checkSerpKeywords, suggestKeywordIdeas } from "@/lib/backlinks/scan";
import { MARKETS } from "@/lib/backlinks/market";
import {
  download,
  keywordIdeasCsv,
  keywordsCsv,
  prospectsCsv,
  rankMovesCsv,
  serpCompetitorsCsv,
  serpCsv,
} from "@/lib/backlinks/export";
import type {
  KeywordIdea,
  KeywordIntent,
  KeywordStat,
  OnPageAudit,
  RankMove,
  ScanReport,
  SerpDevice,
  SerpEngine,
  SerpMarket,
  SerpProspect,
  SerpQuery,
  SerpSnapshot,
} from "@/lib/backlinks/types";

const REASON_LABEL: Record<SerpProspect["reason"], string> = {
  "serp-coranker": "co-ranks, does not link",
  "unlinked-mention": "unlinked mention",
  "lost-link": "lost link",
};

const SOURCE_LABEL: Record<KeywordStat["source"], string> = {
  title: "title",
  h1: "H1",
  meta: "meta",
  content: "content",
  anchor: "anchor",
  brand: "brand",
};

const INTENT_LABEL: Record<KeywordIntent, string> = {
  brand: "brand",
  informational: "informational",
  commercial: "commercial",
  transactional: "transactional",
  navigational: "navigational",
  local: "local",
};

const FEATURE_LABEL: Record<string, string> = {
  featured: "featured snippet",
  paa: "people also ask",
  knowledge: "knowledge panel",
  news: "news",
  video: "video",
  images: "images",
  ads: "ads",
  shopping: "shopping",
  local: "local / maps",
  sitelinks: "sitelinks",
  discussions: "forums & discussions",
};

const ENGINE_OPTIONS: { id: SerpEngine; label: string }[] = [
  { id: "bing", label: "Bing" },
  { id: "duckduckgo", label: "DuckDuckGo" },
  { id: "mojeek", label: "Mojeek" },
  { id: "brave", label: "Brave" },
  { id: "google", label: "Google (provider)" },
];

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

function posLabel(position: number | null): string {
  if (position === null) return "poza zakresem";
  return `#${position}`;
}

function difficultyTone(value: number): "good" | "default" | "risk" {
  if (value <= 35) return "good";
  if (value >= 65) return "risk";
  return "default";
}

export function OnPagePanel({ audit }: { audit: OnPageAudit }) {
  const checks: { label: string; ok: boolean; hint: string }[] = [
    {
      label: "Title",
      ok: Boolean(audit.title) && audit.titleLength >= 12 && audit.titleLength <= 70,
      hint: audit.title ? `${audit.titleLength} characters` : "missing",
    },
    {
      label: "Meta description",
      ok: Boolean(audit.description) && audit.descriptionLength >= 70 && audit.descriptionLength <= 160,
      hint: audit.description ? `${audit.descriptionLength} characters` : "missing",
    },
    {
      label: "H1",
      ok: audit.h1.length === 1,
      hint: audit.h1[0] ?? (audit.h1.length > 1 ? `${audit.h1.length} headings` : "missing"),
    },
    {
      label: "Canonical",
      ok: audit.canonicalOk,
      hint: audit.canonical ? "set" : "none — OK",
    },
    {
      label: "Schema",
      ok: audit.schemaTypes.length > 0,
      hint: audit.schemaTypes.slice(0, 3).join(", ") || "no JSON-LD",
    },
    {
      label: "HTTPS / index",
      ok: audit.https && !audit.robotsNoindex,
      hint: `${audit.https ? "HTTPS" : "HTTP"}${audit.robotsNoindex ? " · noindex" : ""}`,
    },
  ];

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileSearch className="size-4 text-fg-soft" />
          <p className="text-sm font-medium text-fg">On-page readiness</p>
        </div>
        <p className="font-mono text-2xl tabular-nums text-fg">
          {audit.score}
          <span className="ml-2 text-sm text-muted">/ 100</span>
        </p>
      </div>
      <div className="mt-3">
        <Meter value={audit.score} tone={audit.score >= 70 ? "good" : audit.score < 40 ? "risk" : "default"} />
      </div>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {checks.map((check) => (
          <li key={check.label} className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-fg-soft">{check.label}</span>
              <Badge variant={check.ok ? "follow" : "nofollow"}>{check.ok ? "OK" : "needs work"}</Badge>
            </div>
            <p className="mt-1 truncate text-xs text-subtle" title={check.hint}>
              {check.hint}
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-3 font-mono text-xs text-subtle">
        {audit.wordCount} words · {audit.internalLinks} internal links · {audit.externalLinks} outbound
        {audit.ogImage ? " · OG image" : ""}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SERP tab                                                       */
/* ------------------------------------------------------------------ */

export function SerpTab({ report }: { report: ScanReport }) {
  const { serp, stats } = report;
  const avgDifficulty =
    serp.queries.length > 0
      ? Math.round(serp.queries.reduce((sum, q) => sum + q.difficulty, 0) / serp.queries.length)
      : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Visibility</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">{stats.serpVisibility}</p>
          <div className="mt-2">
            <Meter value={stats.serpVisibility} tone="good" />
          </div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Szacowany ruch</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">{serp.trafficScore}</p>
          <p className="mt-1 text-xs text-subtle">suma CTR z pozycji</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Average position</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">
            {serp.avgPosition > 0 ? serp.avgPosition : "—"}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">TOP 3 / TOP 10</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">
            {serp.top3}
            <span className="text-muted"> / {serp.top10}</span>
          </p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Keyword difficulty</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">{avgDifficulty}</p>
          <div className="mt-2">
            <Meter value={avgDifficulty} tone={difficultyTone(avgDifficulty)} />
          </div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Konkurenci SERP</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">{serp.competitors.length}</p>
          <p className="mt-1 text-xs text-subtle">{serp.engines.join(" · ") || "brak pomiaru"}</p>
        </div>
      </div>

      <RankMovesPanel moves={serp.moves} host={report.target.host} />
      <CannibalizationPanel snapshot={serp} />
      <SerpCompetitorsPanel snapshot={serp} host={report.target.host} />

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={serp.competitors.length === 0}
          onClick={() =>
            download(
              `rankproof-${report.target.host}-serp-competitors.csv`,
              serpCompetitorsCsv(serp),
              "text/csv",
            )
          }
        >
          <Download />
          Konkurenci CSV
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={serp.queries.length === 0}
          onClick={() => download(`rankproof-${report.target.host}-serp.csv`, serpCsv(report), "text/csv")}
        >
          <Download />
          SERP CSV
        </Button>
      </div>

      {serp.queries.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface py-12 text-center text-sm text-muted">
          No organic results could be fetched. Enter your own keywords below, or scan again.
        </p>
      ) : (
        serp.queries.map((query) => <SerpQueryCard key={`${query.engine}-${query.keyword}`} query={query} />)
      )}

      <SerpExtrasPanel snapshot={serp} />
      <CustomKeywordPanel host={report.target.host} />
      <KeywordIdeasPanel
        host={report.target.host}
        seeds={report.keywords.slice(0, 3).map((item) => item.keyword)}
      />
    </div>
  );
}

function MoveIcon({ state }: { state: RankMove["state"] }) {
  if (state === "up" || state === "new") return <ArrowUpRight className="size-3.5 text-follow" />;
  if (state === "down" || state === "lost") return <ArrowDownRight className="size-3.5 text-nofollow" />;
  return <Minus className="size-3.5 text-subtle" />;
}

function RankMovesPanel({ moves, host }: { moves: RankMove[]; host: string }) {
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
            download(`rankproof-${host}-zmiany-pozycji.csv`, rankMovesCsv(moves), "text/csv")
          }
        >
          <Download />
          Zmiany CSV
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

function CannibalizationPanel({ snapshot }: { snapshot: SerpSnapshot }) {
  if (snapshot.cannibalization.length === 0) return null;
  return (
    <div className="rounded-xl border border-nofollow/40 bg-nofollow/5 p-5">
      <div className="flex items-center gap-2">
        <TriangleAlert className="size-4 text-nofollow" />
        <p className="text-sm font-medium text-fg">Possible keyword overlap</p>
      </div>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Two of your own URLs appear for the same query. Prefer one URL and consolidate the other with redirects or internal links.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {snapshot.cannibalization.map((item) => (
          <li key={`${item.engine}-${item.keyword}`} className="rounded-lg border border-border bg-surface p-3">
            <p className="text-sm font-medium text-fg">
              „{item.keyword}” <span className="font-mono text-xs text-muted">{item.engine}</span>
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

function SerpCompetitorsPanel({ snapshot, host }: { snapshot: SerpSnapshot; host: string }) {
  if (snapshot.competitors.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-4">
        <div className="flex items-center gap-2">
          <Swords className="size-4 text-fg-soft" />
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
              <ArrowUpRight className="size-3.5 shrink-0 text-subtle" />
            </a>
            <p className="mt-1 font-mono text-xs text-muted">
              {row.keywords} keywords · coverage {row.overlap}% · best {posLabel(row.bestPosition)} ·
              avg {row.avgPosition}
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

function SerpExtrasPanel({ snapshot }: { snapshot: SerpSnapshot }) {
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
          <p className="text-sm font-medium text-fg">Pytania z SERP-a</p>
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

function SerpQueryCard({ query }: { query: SerpQuery }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">„{query.keyword}”</p>
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
            cel {posLabel(query.targetPosition)}
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
                  <ArrowUpRight className="size-3.5 shrink-0 text-subtle" />
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

/* ------------------------------------------------------------------ */
/* Keywords                                                            */
/* ------------------------------------------------------------------ */

export function KeywordsTab({ report }: { report: ScanReport }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">
          Keywords from titles, H1s, content and exact-match anchors — with position, SERP difficulty,
          intent and link equity.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={report.keywords.length === 0}
          onClick={() =>
            download(`rankproof-${report.target.host}-keywords.csv`, keywordsCsv(report), "text/csv")
          }
        >
          <Download />
          Frazy CSV
        </Button>
      </div>
      <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
        {report.keywords.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted">No keywords could be extracted from this page.</p>
        ) : (
          report.keywords.map((row) => (
            <article key={row.keyword} className="border-b border-border py-4 last:border-b-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-fg">{row.keyword}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{SOURCE_LABEL[row.source]}</Badge>
                  <Badge variant="accent">{INTENT_LABEL[row.intent]}</Badge>
                  <Badge variant={row.bestPosition && row.bestPosition <= 3 ? "follow" : "default"}>
                    {posLabel(row.bestPosition)}
                  </Badge>
                  <span className="font-mono text-xs tabular-nums text-muted">opportunity {row.opportunity}</span>
                </div>
              </div>
              <div className="mt-2 grid gap-3 sm:grid-cols-3">
                <div>
                  <p className="text-xs text-subtle">SERP difficulty</p>
                  <div className="mt-1">
                    <Meter value={row.difficulty} tone={difficultyTone(row.difficulty)} />
                  </div>
                </div>
                <div>
                  <p className="text-xs text-subtle">Link equity (anchors)</p>
                  <div className="mt-1">
                    <Meter value={row.linkEquity} tone={row.linkEquity >= 40 ? "good" : "default"} />
                  </div>
                </div>
                <div>
                  <p className="text-xs text-subtle">Growth opportunity</p>
                  <div className="mt-1">
                    <Meter value={row.opportunity} />
                  </div>
                </div>
              </div>
              <p className="mt-2 font-mono text-xs text-subtle">
                {row.engines.map((e) => `${e.engine} ${posLabel(e.position)}`).join(" · ") || "brak pomiaru SERP"}
                {row.matchingAnchors > 0 ? ` · ${row.matchingAnchors} anchors` : ""}
                {row.trafficShare > 0 ? ` · CTR ~${row.trafficShare}%` : ""}
              </p>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Link opportunities                                                  */
/* ------------------------------------------------------------------ */

export function ProspectsTab({ report }: { report: ScanReport }) {
  const [copied, setCopied] = useState<string | null>(null);

  const outreach = (row: SerpProspect) =>
    [
      `Hi,`,
      ``,
      row.reason === "unlinked-mention"
        ? `thank you for mentioning ${report.target.host} in "${row.title}". Readers would find us more easily if the name were a link — here is the address: ${report.target.url}`
        : row.reason === "lost-link"
          ? `you used to link to ${report.target.host} from "${row.title}", and that link is no longer there. The content is still current: ${report.target.url}`
          : `I am writing about "${row.title}" — it ranks well for "${row.keyword}". We have a complementary piece that your readers may find useful: ${report.target.url}`,
      ``,
      `Best regards`,
    ].join("\n");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm leading-relaxed text-muted">
          Pages that already rank for your keywords or mention the brand without linking. Sorted by
          priority — lost links and unlinked mentions are the cheapest to win back.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={report.prospects.length === 0}
          onClick={() =>
            download(`rankproof-${report.target.host}-szanse.csv`, prospectsCsv(report), "text/csv")
          }
        >
          <Download />
          Prospects CSV
        </Button>
      </div>
      <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
        {report.prospects.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted">
            No opportunities in this scan. They appear when the SERP, mentions or the archive reveal pages without a link.
          </p>
        ) : (
          report.prospects.map((row) => (
            <article
              key={`${row.reason}-${row.domain}-${row.url}`}
              className="grid gap-3 border-b border-border py-4 last:border-b-0 md:grid-cols-[minmax(0,1.4fr)_auto] md:items-center"
            >
              <div className="min-w-0">
                <a
                  href={row.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex max-w-full items-center gap-1.5 text-sm font-medium text-fg hover:text-fg-soft"
                >
                  <span className="truncate">{row.title || row.domain}</span>
                  <ArrowUpRight className="size-3.5 shrink-0 text-subtle" />
                </a>
                <p className="mt-1 font-mono text-xs text-muted">
                  {row.domain}
                  {row.contactUrl ? (
                    <>
                      {" · "}
                      <a href={row.contactUrl} target="_blank" rel="noreferrer" className="hover:text-fg">
                        kontakt
                      </a>
                    </>
                  ) : null}
                </p>
                {row.snippet ? <p className="mt-1 line-clamp-2 text-sm text-subtle">{row.snippet}</p> : null}
              </div>
              <div className="flex flex-wrap items-center gap-2 md:justify-end">
                <Badge
                  variant={
                    row.reason === "serp-coranker"
                      ? "accent"
                      : row.reason === "lost-link"
                        ? "nofollow"
                        : "default"
                  }
                >
                  {REASON_LABEL[row.reason]}
                </Badge>
                {row.position ? <Badge>#{row.position}</Badge> : null}
                {row.keyword ? <Badge>{row.keyword}</Badge> : null}
                <span className="font-mono text-xs tabular-nums text-muted">
                  priority {row.priority} · DS {row.domainScore}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(outreach(row));
                    setCopied(row.url);
                    setTimeout(() => setCopied(null), 1500);
                  }}
                >
                  <Copy />
                  {copied === row.url ? "skopiowano" : "mail"}
                </Button>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Interactive panels                                                  */
/* ------------------------------------------------------------------ */

function CustomKeywordPanel({ host }: { host: string }) {
  const run = useServerFn(checkSerpKeywords);
  const [value, setValue] = useState("");
  const [engines, setEngines] = useState<SerpEngine[]>(["bing", "duckduckgo", "mojeek"]);
  const [depth, setDepth] = useState<10 | 20>(10);
  const [market, setMarket] = useState<SerpMarket>("pl");
  const [device, setDevice] = useState<SerpDevice>("desktop");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SerpSnapshot | null>(null);
  const [keywords, setKeywords] = useState<KeywordStat[]>([]);

  function toggleEngine(engine: SerpEngine) {
    setEngines((current) =>
      current.includes(engine)
        ? current.filter((item) => item !== engine)
        : [...current, engine],
    );
  }

  async function submit() {
    const list = value
      .split(/[,;\n]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 10);
    if (list.length === 0) {
      setError("Enter 1–10 keywords, separated by commas.");
      return;
    }
    if (engines.length === 0) {
      setError("Select at least one search engine.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await run({
        data: { url: host, keywords: list, engines, depth, market, device },
      });
      if (!result.ok) {
        setSnapshot(null);
        setKeywords([]);
        setError(result.error);
        return;
      }
      setSnapshot(result.snapshot);
      setKeywords(result.keywords);
    } catch (err) {
      setSnapshot(null);
      setKeywords([]);
      setError(err instanceof Error ? err.message : "The check failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-fg-soft" />
        <p className="text-sm font-medium text-fg">Check your own keywords</p>
      </div>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Up to 10 keywords, four independent engines, a choice of market and device, optionally top 20
        instead of top 10 — no paid API keys.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="product photography, packshot studio"
          disabled={loading}
        />
        <Button onClick={() => void submit()} disabled={loading} className="sm:w-52">
          {loading ? <Radar className="animate-spin" /> : <Search />}
          {loading ? "Checking…" : "Check SERP"}
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {ENGINE_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={loading}
            onClick={() => toggleEngine(option.id)}
            className={cn(
              "h-9 rounded-full border px-3 text-xs transition-colors",
              engines.includes(option.id)
                ? "border-fg-soft bg-fg text-accent-fg"
                : "border-border bg-surface-2 text-muted hover:text-fg",
            )}
          >
            {option.label}
          </button>
        ))}
        <span className="ml-2 text-xs text-subtle">Market</span>
        {(Object.keys(MARKETS) as SerpMarket[]).map((id) => (
          <button
            key={id}
            type="button"
            disabled={loading}
            onClick={() => setMarket(id)}
            title={MARKETS[id].label}
            className={cn(
              "h-9 rounded-full border px-3 text-xs transition-colors",
              market === id
                ? "border-fg-soft bg-fg text-accent-fg"
                : "border-border bg-surface-2 text-muted hover:text-fg",
            )}
          >
            {id.toUpperCase()}
          </button>
        ))}
        <span className="ml-2 text-xs text-subtle">Device</span>
        {(["desktop", "mobile"] as const).map((id) => (
          <button
            key={id}
            type="button"
            disabled={loading}
            onClick={() => setDevice(id)}
            className={cn(
              "h-9 rounded-full border px-3 text-xs transition-colors",
              device === id
                ? "border-fg-soft bg-fg text-accent-fg"
                : "border-border bg-surface-2 text-muted hover:text-fg",
            )}
          >
            {id}
          </button>
        ))}
        <span className="ml-2 text-xs text-subtle">Depth</span>
        {([10, 20] as const).map((option) => (
          <button
            key={option}
            type="button"
            disabled={loading}
            onClick={() => setDepth(option)}
            className={cn(
              "h-9 rounded-full border px-3 font-mono text-xs transition-colors",
              depth === option
                ? "border-fg-soft bg-fg text-accent-fg"
                : "border-border bg-surface-2 text-muted hover:text-fg",
            )}
          >
            TOP {option}
          </button>
        ))}
      </div>
      {error ? (
        <p className="mt-3 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {snapshot ? (
        <div className="mt-5 flex flex-col gap-3">
          <p className="font-mono text-xs text-muted">
            visibility {snapshot.visibility}/100 · top 10: {snapshot.top10} · top 3: {snapshot.top3} ·
            traffic {snapshot.trafficScore} · avg {snapshot.avgPosition || "—"}
          </p>
          {keywords.map((row) => (
            <div
              key={row.keyword}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
            >
              <span className="text-sm text-fg">{row.keyword}</span>
              <span className="flex items-center gap-2 font-mono text-xs text-muted">
                <Badge variant="accent">difficulty {row.difficulty}</Badge>
                {row.engines.map((e) => `${e.engine} ${posLabel(e.position)}`).join(" · ")}
              </span>
            </div>
          ))}
          <RankMovesPanel moves={snapshot.moves} host={host} />
          <SerpCompetitorsPanel snapshot={snapshot} host={host} />
          {snapshot.queries.map((query) => (
            <SerpQueryCard key={`extra-${query.engine}-${query.keyword}`} query={query} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const IDEA_SOURCE_LABEL: Record<KeywordIdea["source"], string> = {
  autocomplete: "autocomplete",
  related: "related",
  question: "pytanie",
  modifier: "modyfikator",
};

function KeywordIdeasPanel({ host, seeds }: { host: string; seeds: string[] }) {
  const run = useServerFn(suggestKeywordIdeas);
  const [value, setValue] = useState(seeds.join(", "));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ideas, setIdeas] = useState<KeywordIdea[]>([]);
  const [filter, setFilter] = useState<KeywordIntent | "all">("all");

  async function submit() {
    const list = value
      .split(/[,;\n]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 5);
    if (list.length === 0) {
      setError("Enter 1–5 seed keywords.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await run({ data: { keywords: list } });
      if (!result.ok) {
        setIdeas([]);
        setError(result.error);
        return;
      }
      setIdeas(result.ideas);
    } catch (err) {
      setIdeas([]);
      setError(err instanceof Error ? err.message : "Suggestions could not be fetched.");
    } finally {
      setLoading(false);
    }
  }

  const visible = filter === "all" ? ideas : ideas.filter((idea) => idea.intent === filter);

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex items-center gap-2">
        <Lightbulb className="size-4 text-fg-soft" />
        <p className="text-sm font-medium text-fg">Keyword ideas</p>
      </div>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Autocomplete from DuckDuckGo and Bing, related searches and SERP questions. These are queries
        people actually type — with commercial intent marked.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="fotografia produktowa"
          disabled={loading}
        />
        <Button onClick={() => void submit()} disabled={loading} className="sm:w-52">
          {loading ? <Radar className="animate-spin" /> : <Sparkles />}
          {loading ? "Searching…" : "Find keywords"}
        </Button>
      </div>
      {error ? (
        <p className="mt-3 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {ideas.length > 0 ? (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {(["all", "transactional", "commercial", "informational", "local"] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setFilter(item)}
                className={cn(
                  "h-9 rounded-full border px-3 text-xs transition-colors",
                  filter === item
                    ? "border-fg-soft bg-fg text-accent-fg"
                    : "border-border bg-surface-2 text-muted hover:text-fg",
                )}
              >
                {item === "all" ? "wszystkie" : INTENT_LABEL[item]}
              </button>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => download(`rankproof-${host}-keyword-ideas.csv`, keywordIdeasCsv(ideas), "text/csv")}
            >
              <Download />
              Ideas CSV
            </Button>
          </div>
          <ul className="mt-3 grid gap-2 md:grid-cols-2">
            {visible.slice(0, 40).map((idea) => (
              <li
                key={idea.keyword}
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <span className="min-w-0 truncate text-sm text-fg">{idea.keyword}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge variant={idea.intent === "transactional" ? "follow" : "default"}>
                    {INTENT_LABEL[idea.intent]}
                  </Badge>
                  <span className="font-mono text-xs text-subtle">{IDEA_SOURCE_LABEL[idea.source]}</span>
                  <span className="font-mono text-xs tabular-nums text-muted">{idea.score}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export function SerpOverviewHint() {
  return (
    <div className="rounded-xl border border-border bg-surface-2 p-5">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-fg-soft" />
        <p className="text-sm leading-relaxed text-muted">
          SERP visibility sums your positions on keywords taken from your page and anchors (Bing,
          DuckDuckGo, Mojeek, optionally Brave). Difficulty comes from the strength of the domains
          holding the top, and modelled traffic from a CTR curve adjusted for SERP features. A link
          from a domain that itself ranks for these keywords is worth more — we mark it as
          co-ranking.
        </p>
      </div>
    </div>
  );
}
