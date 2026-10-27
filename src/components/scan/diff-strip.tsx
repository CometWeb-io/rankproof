import { TrendingDown, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/components/scan/utils";
import type { ScanDiff } from "@/lib/backlinks/history";

export function DiffStrip({
  diff,
  ratingDelta,
  visibilityDelta,
  persisted,
}: {
  diff: ScanDiff;
  ratingDelta?: number | null;
  visibilityDelta?: number | null;
  persisted?: boolean;
}) {
  const positive = diff.backlinkDelta >= 0;
  return (
    <div
      className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border bg-surface-2 px-5 py-3 text-sm"
      aria-live="polite"
    >
      <span className="flex items-center gap-2 text-muted">
        {positive ? (
          <TrendingUp className="size-4 text-follow" aria-hidden />
        ) : (
          <TrendingDown className="size-4 text-nofollow" aria-hidden />
        )}
        {diff.basis === "discovery_sample" ? "Observed sample since " : "Change since "}
        {formatDate(diff.previousAt)}
      </span>
      <span className="font-mono text-xs text-fg-soft">
        links {diff.backlinkDelta >= 0 ? "+" : ""}
        {diff.backlinkDelta}
      </span>
      <span className="font-mono text-xs text-fg-soft">
        domains {diff.domainDelta >= 0 ? "+" : ""}
        {diff.domainDelta}
      </span>
      <span className="font-mono text-xs text-follow">
        {diff.basis ? "first observed" : "new"} {diff.newLinks}
      </span>
      {diff.basis ? (
        <span className="font-mono text-xs text-muted">
          not reobserved {diff.unobservedLinks}; loss unknown
        </span>
      ) : (
        <span className="font-mono text-xs text-nofollow">lost {diff.lostLinks}</span>
      )}
      {diff.healthDelta !== null ? (
        <span className="font-mono text-xs text-muted">
          health {diff.healthDelta >= 0 ? "+" : ""}
          {diff.healthDelta}
        </span>
      ) : null}
      {ratingDelta != null ? (
        <span className="font-mono text-xs text-muted">
          DR {ratingDelta >= 0 ? "+" : ""}
          {ratingDelta}
        </span>
      ) : null}
      {visibilityDelta != null ? (
        <span className="font-mono text-xs text-muted">
          SERP {visibilityDelta >= 0 ? "+" : ""}
          {visibilityDelta}
        </span>
      ) : null}
      {persisted ? <Badge>stored in database</Badge> : null}
    </div>
  );
}
