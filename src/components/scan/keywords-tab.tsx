import { Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { INTENT_LABEL, KEYWORD_SOURCE_LABEL } from "@/components/scan/serp-labels";
import { difficultyTone, posLabel } from "@/components/scan/serp-utils";
import { Meter } from "@/components/scan/ui-primitives";
import { download, keywordsCsv } from "@/lib/backlinks/export";
import type { ScanReport } from "@/lib/backlinks/types";

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
          <Download aria-hidden />
          Keywords CSV
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
                  <Badge>{KEYWORD_SOURCE_LABEL[row.source]}</Badge>
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
                {row.engines.map((e) => `${e.engine} ${posLabel(e.position)}`).join(" · ") || "no SERP data"}
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
