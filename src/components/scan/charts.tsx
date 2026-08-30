import type { CountStat, TrendPoint } from "@/lib/backlinks/types";

export function GrowthChart({ stats }: { stats: CountStat[] }) {
  const max = Math.max(...stats.map((s) => s.count), 1);
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-xs font-medium tracking-wide text-muted uppercase">
        Referring domain growth (first seen in the archive)
      </p>
      {stats.length === 0 ? (
        <p className="mt-3 text-sm text-subtle">No domain-age data yet.</p>
      ) : (
        <div className="mt-4 flex h-32 items-end gap-1.5" role="img" aria-label="Domain growth chart">
          {stats.map((stat) => (
            <div key={stat.key} className="flex flex-1 flex-col items-center gap-1">
              <span className="font-mono text-[10px] tabular-nums text-subtle">{stat.count}</span>
              <span
                className="w-full rounded-t bg-fg-soft/70"
                style={{ height: `${Math.max(4, (stat.count / max) * 100)}%` }}
              />
              <span className="font-mono text-[10px] text-subtle">
                {stat.key === "unknown" || stat.key === "nieznany" ? "?" : stat.key.slice(2)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TrendChart({ points }: { points: TrendPoint[] }) {
  if (points.length < 2) return null;
  const max = Math.max(...points.map((p) => p.referringDomains), 1);
  const maxDr = Math.max(...points.map((p) => p.domainRating), 1);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium tracking-wide text-muted uppercase">
          Profile trend ({points.length} scans)
        </p>
        <p className="font-mono text-xs text-muted">
          domains {first.referringDomains} → {last.referringDomains} · DR {first.domainRating} →{" "}
          {last.domainRating}
        </p>
      </div>
      <div
        className="mt-4 flex h-28 items-end gap-1"
        role="img"
        aria-label={`Profile trend across ${points.length} scans`}
      >
        {points.map((point) => (
          <div
            key={point.at}
            className="group relative flex flex-1 flex-col justify-end gap-0.5"
            title={`${new Date(point.at).toLocaleDateString()} · ${point.referringDomains} referring domains · DR ${point.domainRating}`}
          >
            <span
              className="w-full rounded-t bg-fg-soft/70"
              style={{ height: `${Math.max(4, (point.referringDomains / max) * 78)}%` }}
            />
            <span
              className="w-full rounded-t bg-follow/60"
              style={{ height: `${Math.max(2, (point.domainRating / maxDr) * 22)}%` }}
            />
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-subtle">
        Top bars: referring domains. Bottom: Domain Rating. History is stored server-side, so the
        trend follows you to another device.
      </p>
    </div>
  );
}
