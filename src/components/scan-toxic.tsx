import { useState } from "react";
import { ArrowUpRight, Download, ShieldAlert, Tags } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { disavowFile, download, toxicCsv } from "@/lib/backlinks/export";
import type { AnchorType, ScanReport, ToxicVerdict } from "@/lib/backlinks/types";

const VERDICT_LABEL: Record<ToxicVerdict, string> = {
  review: "review",
  watch: "watch",
  ok: "safe",
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
 * Risk audit: what genuinely threatens the link profile, what is worth
 * disavowing, and whether the anchor distribution looks unnatural.
 */
export function ToxicTab({ report }: { report: ScanReport }) {
  const { toxic, anchorAudit } = report;
  const risky = toxic.domains.filter((row) => row.verdict !== "ok");

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium text-muted">For review</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">{toxic.disavowCount}</p>
          <p className="mt-1 text-xs text-subtle">high-risk domains</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium text-muted">Watch</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">{toxic.watchCount}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium text-muted">Average toxicity</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">{toxic.avgToxicity}</p>
          <div className="mt-2">
            <Meter
              value={toxic.avgToxicity}
              tone={toxic.avgToxicity >= 45 ? "risk" : toxic.avgToxicity <= 20 ? "good" : "default"}
            />
          </div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium text-muted">Anchor quality</p>
          <p className="mt-2 font-mono text-3xl tabular-nums text-fg">{anchorAudit.score}</p>
          <div className="mt-2">
            <Meter
              value={anchorAudit.score}
              tone={anchorAudit.score >= 70 ? "good" : anchorAudit.score < 45 ? "risk" : "default"}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={toxic.domains.length === 0}
          onClick={() =>
            download(`rankproof-${report.target.host}-toxic.csv`, toxicCsv(report), "text/csv")
          }
        >
          <Download />
          Risk CSV
        </Button>
      </div>

      <DisavowPanel report={report} />

      <div className="rounded-xl border border-border bg-surface p-5">
        <div className="flex items-center gap-2">
          <Tags className="size-4 text-fg-soft" />
          <p className="text-sm font-medium text-fg">Anchor distribution vs. a natural profile</p>
        </div>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          A natural link profile rests on brand names and bare URLs. An excess of exact-match
          anchors is the most common cause of an algorithmic filter — diversity{" "}
          {anchorAudit.diversity}/100.
        </p>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {anchorAudit.risks.map((risk) => (
            <li key={risk.type} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-fg-soft">{ANCHOR_LABEL[risk.type]}</span>
                <Badge
                  variant={
                    risk.verdict === "high"
                      ? "nofollow"
                      : risk.verdict === "ok"
                        ? "follow"
                        : "default"
                  }
                >
                  {risk.share}%
                </Badge>
              </div>
              <div className="mt-2">
                <Meter
                  value={risk.share}
                  tone={
                    risk.verdict === "high" ? "risk" : risk.verdict === "ok" ? "good" : "default"
                  }
                />
              </div>
              <p className="mt-2 text-xs text-subtle">
                normal {risk.min}–{risk.max}% · {risk.hint}
              </p>
            </li>
          ))}
        </ul>
        {anchorAudit.overOptimized.length > 0 ? (
          <div className="mt-4 rounded-lg border border-nofollow/40 bg-nofollow/5 p-3">
            <p className="text-sm font-medium text-fg">Over-optimised anchors</p>
            <ul className="mt-2 flex flex-col gap-1">
              {anchorAudit.overOptimized.map((item) => (
                <li key={item.text} className="font-mono text-xs text-muted">
                  „{item.text}” — {item.share}% profilu, {item.domains} domen
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
        <div className="flex items-center gap-2 border-b border-border py-4">
          <ShieldAlert className="size-4 text-fg-soft" />
          <p className="text-sm font-medium text-fg">Domains needing a decision</p>
        </div>
        {risky.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted">
            No referring domain crosses the high-risk threshold. Nothing to review.
          </p>
        ) : (
          risky.slice(0, 60).map((row) => (
            <article
              key={row.domain}
              className="grid gap-3 border-b border-border py-4 last:border-b-0 md:grid-cols-[minmax(0,1.4fr)_auto] md:items-center"
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
                <p className="mt-1 text-xs text-subtle">
                  {row.reasons.join(" · ") || "elevated general risk"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 md:justify-end">
                <Badge variant={row.verdict === "review" ? "nofollow" : "default"}>
                  {VERDICT_LABEL[row.verdict]}
                </Badge>
                {row.sitewide ? <Badge>sitewide</Badge> : null}
                <span className="font-mono text-xs tabular-nums text-muted">
                  tox {row.toxicity} · spam {row.spamScore} · DS {row.domainScore} · {row.links}{" "}
                  links
                </span>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Disavow files are an expert tool: Google says most sites never need one and
 * misuse can hurt visibility. The scores behind this list are heuristics, so the
 * download sits behind an explicit review step instead of a header button.
 */
function DisavowPanel({ report }: { report: ScanReport }) {
  const [reviewed, setReviewed] = useState(false);
  const toxic = report.toxic;
  if (toxic.disavowCount + toxic.watchCount === 0) return null;
  return (
    <details className="rounded-xl border border-border bg-surface p-5">
      <summary className="cursor-pointer text-sm font-medium text-fg">
        Disavow file (advanced)
      </summary>
      <div className="mt-3 space-y-3 text-sm text-muted">
        <p>
          Most sites never need to disavow links, and a wrong file can remove links that help you.
          Google recommends it only for a large number of spammy, artificial or low-quality links
          that caused, or are likely to cause, a manual action.{" "}
          <a
            className="text-fg-soft underline decoration-fg-soft/50 underline-offset-2 hover:decoration-fg-soft"
            href="https://support.google.com/webmasters/answer/2648487"
          >
            Google&rsquo;s guidance
          </a>
          . The risk scores here are heuristics, not a verdict.
        </p>
        <label className="flex items-start gap-2 text-fg-soft">
          <input
            type="checkbox"
            className="mt-1"
            checked={reviewed}
            onChange={(event) => setReviewed(event.target.checked)}
          />
          I reviewed every domain on the list and understand the file is a draft.
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!reviewed || toxic.disavowCount === 0}
            onClick={() =>
              download(`disavow-${report.target.host}.txt`, disavowFile(report), "text/plain")
            }
          >
            <Download />
            Download draft ({toxic.disavowCount})
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!reviewed}
            onClick={() =>
              download(
                `disavow-${report.target.host}-wide.txt`,
                disavowFile(report, true),
                "text/plain",
              )
            }
          >
            <Download />
            Draft + watchlist ({toxic.disavowCount + toxic.watchCount})
          </Button>
        </div>
      </div>
    </details>
  );
}
