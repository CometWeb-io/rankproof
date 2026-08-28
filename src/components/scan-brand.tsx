import { ArrowUpRight, Fingerprint, Gauge, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { BrandSerp, FootprintRisk, Scorecard } from "@/lib/backlinks/types";

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
 * The headline visibility index — one number tying together links, SERP,
 * page readiness, risk and momentum, broken down into its components.
 */
export function ScorecardPanel({ card }: { card: Scorecard }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Gauge className="size-4 text-fg-soft" />
          <div>
            <p className="text-sm font-medium text-fg">RankProof visibility index</p>
            <p className="mt-1 text-xs text-muted">
              Weakest component: <span className="text-fg-soft">{card.weakest}</span>
            </p>
          </div>
        </div>
        <p className="font-mono text-3xl tabular-nums text-fg">
          {card.index}
          <span className="ml-2 text-sm text-muted">/ 100 · {card.grade}</span>
        </p>
      </div>
      <div className="mt-3">
        <Meter
          value={card.index}
          tone={card.index >= 65 ? "good" : card.index < 40 ? "risk" : "default"}
        />
      </div>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {card.parts.map((part) => (
          <li key={part.key} className="rounded-lg border border-border p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm text-fg-soft">{part.label}</span>
              <span className="font-mono text-xs tabular-nums text-muted">
                {part.score}/{part.max}
              </span>
            </div>
            <div className="mt-2">
              <Meter
                value={part.score}
                max={part.max}
                tone={part.score / part.max > 0.66 ? "good" : part.score / part.max < 0.34 ? "risk" : "default"}
              />
            </div>
            <p className="mt-2 text-xs text-subtle">{part.hint}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

const KIND_LABEL: Record<BrandSerp["results"][number]["kind"], string> = {
  profile: "profile",
  reviews: "reviews",
  directory: "directory",
  media: "media",
  competitor: "competitor",
  other: "other",
};

/** The SERP for your brand name — what a customer sees after a recommendation. */
export function BrandSerpPanel({ brand }: { brand: BrandSerp }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-fg-soft" />
            <p className="text-sm font-medium text-fg">Brand SERP — “{brand.keyword}”</p>
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">{brand.hint}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge variant={brand.control >= 60 ? "follow" : brand.risky > 0 ? "nofollow" : "default"}>
            control {brand.control}%
          </Badge>
          <span className="font-mono text-xs text-muted">
            {brand.owned} owned · {brand.thirdParty} third-party
            {brand.risky > 0 ? ` · ${brand.risky} risky` : ""}
          </span>
        </div>
      </div>
      {brand.results.map((row) => (
        <article
          key={row.url}
          className={cn(
            "flex flex-wrap items-start justify-between gap-3 border-b border-border py-3 last:border-b-0",
            row.owned && "bg-follow/5",
            row.risky && "bg-nofollow/5",
          )}
        >
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2">
              <span className="font-mono text-xs tabular-nums text-subtle">#{row.position}</span>
              <a
                href={row.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex max-w-full items-center gap-1.5 truncate text-sm text-fg hover:text-fg-soft"
              >
                {row.title || row.domain}
                <ArrowUpRight className="size-3.5 shrink-0 text-subtle" />
              </a>
            </p>
            <p className="mt-1 truncate font-mono text-xs text-muted">{row.domain}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge>{KIND_LABEL[row.kind]}</Badge>
            {row.owned ? <Badge variant="follow">yours</Badge> : null}
            {row.risky ? <Badge variant="nofollow">reputation risk</Badge> : null}
          </div>
        </article>
      ))}
    </div>
  );
}

/** Patterns of an artificially built link profile. */
export function FootprintPanel({ footprint }: { footprint: FootprintRisk }) {
  const metrics = [
    { label: "Largest /24 subnet", value: footprint.topSubnetShare, risky: footprint.topSubnetShare >= 30 },
    { label: "Sitewide domains", value: footprint.sitewideShare, risky: footprint.sitewideShare >= 25 },
    { label: "Exact-match anchors", value: footprint.exactAnchorShare, risky: footprint.exactAnchorShare > 12 },
    { label: "Subnet diversity", value: footprint.subnetDiversity, risky: footprint.subnetDiversity < 50 },
  ];

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Fingerprint className="size-4 text-fg-soft" />
          <p className="text-sm font-medium text-fg">Link profile footprint</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant={
              footprint.verdict === "high"
                ? "nofollow"
                : footprint.verdict === "low"
                  ? "follow"
                  : "default"
            }
          >
            risk {footprint.verdict}
          </Badge>
          <span className="font-mono text-xl tabular-nums text-fg">{footprint.score}</span>
        </div>
      </div>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
        A natural profile is dispersed: different servers, different anchors, links inside content. A
        repeating pattern signals that the links come from a single source.
      </p>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((metric) => (
          <li key={metric.label} className="rounded-lg border border-border p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs text-fg-soft">{metric.label}</span>
              <span className="font-mono text-xs tabular-nums text-muted">{metric.value}%</span>
            </div>
            <div className="mt-2">
              <Meter value={metric.value} tone={metric.risky ? "risk" : "good"} />
            </div>
          </li>
        ))}
      </ul>
      <ul className="mt-3 flex flex-col gap-1">
        {footprint.reasons.map((reason) => (
          <li key={reason} className="text-xs text-subtle">
            · {reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
