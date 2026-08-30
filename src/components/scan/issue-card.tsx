import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Issue } from "@/lib/backlinks/types";

export function IssueCard({ issue }: { issue: Issue }) {
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
            aria-hidden
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
