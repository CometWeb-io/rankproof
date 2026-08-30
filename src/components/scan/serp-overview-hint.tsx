import { Sparkles } from "lucide-react";

export function SerpOverviewHint() {
  return (
    <div className="rounded-xl border border-border bg-surface-2 p-5">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-fg-soft" aria-hidden />
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
