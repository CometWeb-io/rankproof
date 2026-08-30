import { cn } from "@/lib/utils";
import type { CountStat } from "@/lib/backlinks/types";

export function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "follow" | "nofollow" | "default";
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-[var(--shadow-panel)]">
      <p className="text-xs font-medium tracking-wide text-muted uppercase">{label}</p>
      <p
        className={cn(
          "mt-2 font-mono text-3xl tabular-nums tracking-tight",
          tone === "follow" && "text-follow",
          tone === "nofollow" && "text-nofollow",
          (!tone || tone === "default") && "text-fg",
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-subtle">{hint}</p> : null}
    </div>
  );
}

export function Meter({
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
    <span
      className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
      role="meter"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
    >
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

export function DistributionList({
  title,
  stats,
  labelMap,
  empty,
}: {
  title: string;
  stats: CountStat[];
  labelMap?: Record<string, string>;
  empty?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-xs font-medium tracking-wide text-muted uppercase">{title}</p>
      {stats.length === 0 ? (
        <p className="mt-3 text-sm text-subtle">{empty ?? "No data"}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2.5">
          {stats.map((stat) => (
            <li key={stat.key}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-sm text-fg-soft">
                  {labelMap?.[stat.key] ?? stat.key}
                </span>
                <span className="font-mono text-xs tabular-nums text-muted">
                  {stat.count} · {stat.share}%
                </span>
              </div>
              <div className="mt-1">
                <Meter value={stat.share} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
