import { BookOpenText, Network, Radar, ShieldCheck, ShieldOff, Sparkles } from "lucide-react";

export function ScanSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-live="polite" aria-busy="true">
      <div className="h-40 animate-pulse rounded-xl bg-surface-2" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-surface-2" />
        ))}
      </div>
      <div className="flex items-start gap-3 text-sm text-muted">
        <Radar className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden />
        <p className="leading-relaxed">
          Reading the page, sitemap and archive, extracting keywords from titles and H1s, asking
          Bing and DuckDuckGo for positions, then reaching out to Wikipedia, GitHub, Reddit and the
          remaining sources. Every candidate is opened as HTML — anchor, section, meta robots and
          target status included…
        </p>
      </div>
      <div className="h-72 animate-pulse rounded-xl bg-surface-2" />
    </div>
  );
}

export function EmptyGuide() {
  const items = [
    {
      icon: BookOpenText,
      title: "The target's own graph",
      body: "Live site, sitemap, subdomains and archive copies point to the partners most likely to link back.",
    },
    {
      icon: Network,
      title: "Thirteen open sources",
      body: "Wikipedia, GitHub, Hacker News, Reddit, Common Crawl and more. Each hit is a candidate, not a link.",
    },
    {
      icon: ShieldCheck,
      title: "Verified in the HTML",
      body: "Every candidate page is opened and checked for an exact href, with rel, placement and status.",
    },
    {
      icon: Sparkles,
      title: "Positions and a plan",
      body: "Keywords from titles and anchors, top-10 positions, visibility and an ordered list of next steps.",
    },
  ];
  return (
    <section aria-label="How RankProof works" className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item) => (
          <div
            key={item.title}
            className="rounded-[14px] border border-border bg-surface p-6 transition-colors hover:border-border-strong"
          >
            <span className="flex size-10 items-center justify-center rounded-[10px] border border-accent/22 bg-accent/9">
              <item.icon className="size-5 text-accent" aria-hidden />
            </span>
            <h3 className="mt-5 text-base font-bold tracking-tight text-fg">{item.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">{item.body}</p>
          </div>
        ))}
      </div>
      <p className="flex items-start gap-2 text-xs leading-relaxed text-subtle">
        <ShieldOff className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Not a full index of the web: a small site may get a short list, and then it is an honest
        one. Export to CSV or JSON.
      </p>
    </section>
  );
}
