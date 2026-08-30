import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CustomKeywordPanel } from "@/components/scan/custom-keyword-panel";
import { KeywordIdeasPanel } from "@/components/scan/keyword-ideas-panel";
import {
  CannibalizationPanel,
  RankMovesPanel,
  SerpCompetitorsPanel,
  SerpExtrasPanel,
  SerpQueryCard,
} from "@/components/scan/serp-panels";
import { difficultyTone } from "@/components/scan/serp-utils";
import { Meter } from "@/components/scan/ui-primitives";
import { download, serpCompetitorsCsv, serpCsv } from "@/lib/backlinks/export";
import type { ScanReport } from "@/lib/backlinks/types";

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
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Modelled traffic</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">{serp.trafficScore}</p>
          <p className="mt-1 text-xs text-subtle">CTR sum from positions</p>
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
          <p className="text-xs font-medium tracking-wide text-muted uppercase">SERP competitors</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">{serp.competitors.length}</p>
          <p className="mt-1 text-xs text-subtle">{serp.engines.join(" · ") || "no measurement"}</p>
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
          <Download aria-hidden />
          Competitors CSV
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={serp.queries.length === 0}
          onClick={() => download(`rankproof-${report.target.host}-serp.csv`, serpCsv(report), "text/csv")}
        >
          <Download aria-hidden />
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
