import { ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ANCHOR_LABEL, FLAG_LABEL, PLACEMENT_LABEL, SOURCE_LABEL } from "@/components/scan/labels";
import { Meter } from "@/components/scan/ui-primitives";
import { relLabel, relVariant } from "@/components/scan/utils";
import { isCurrentBacklink } from "@/lib/backlinks/link-state";
import type { Backlink } from "@/lib/backlinks/types";

export function BacklinkRow({ item, isNew }: { item: Backlink; isNew: boolean }) {
  const current = isCurrentBacklink(item);
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
          <span title="Uncalibrated domain ordering heuristic">
            DS {current ? item.domainScore : "unknown"}
          </span>
          <span className="text-subtle">·</span>
          <span title="Estimated text similarity (0–100)">
            TM {current ? item.relevance : "unknown"}
          </span>
          {item.domainFirstArchivedAt ? (
            <>
              <span className="text-subtle">·</span>
              <span title="Source domain first archived">
                domain archived {item.domainFirstArchivedAt.slice(0, 4)}
              </span>
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
            value={current ? item.domainScore : 0}
            tone={current && item.spamScore >= 55 ? "risk" : "default"}
          />
        </div>
      </div>

      <div className="min-w-0">
        <p className="text-xs text-subtle">Link target</p>
        <p className="truncate font-mono text-xs text-fg-soft">{item.targetPath}</p>
        {item.anchor ? (
          <p className="mt-1 truncate text-sm text-muted">&ldquo;{item.anchor}&rdquo;</p>
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
          <Badge variant="nofollow">
            archive candidate{item.lastSeen ? ` · ${item.lastSeen}` : ""}
          </Badge>
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
