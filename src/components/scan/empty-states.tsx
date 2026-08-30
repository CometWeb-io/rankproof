import { BookOpenText, Network, Newspaper, Radar, ShieldCheck, ShieldOff, Sparkles } from "lucide-react";

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
      title: "The target's graph, not guesswork",
      body: "We start from the live site, its sitemap, subdomains and Internet Archive copies. From the highest-value pages (services, portfolio, case studies, blog) we build a graph of partners — the richest source of genuine backlinks.",
    },
    {
      icon: Network,
      title: "Thirteen open sources",
      body: "Wikipedia and Wikimedia, GitHub, Hacker News, Reddit, Stack Exchange, Bluesky, Bing, DuckDuckGo, Mojeek, Google News, GDELT, urlscan.io and Common Crawl. Each result is a candidate, not a finished link.",
    },
    {
      icon: ShieldCheck,
      title: "Verification in three waves",
      body: "We open the candidate page and look for an a href pointing at the target. We check rel, meta robots, the document section (content, footer, menu), language and the status of the target URL. If a domain does link, we go deeper into its pages.",
    },
    {
      icon: Sparkles,
      title: "SERP and keywords, not just a link list",
      body: "From titles, H1s and exact-match anchors we build a keyword list, check the top 10 in Bing and DuckDuckGo, compute visibility, and point out pages that already rank but do not link to you.",
    },
  ];
  return (
    <section className="grid gap-3 md:grid-cols-2" aria-label="How RankProof works">
      {items.map((item) => (
        <div key={item.title} className="rounded-xl border border-border bg-surface p-5">
          <item.icon className="size-5 text-fg-soft" aria-hidden />
          <h3 className="mt-4 text-sm font-medium text-fg">{item.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted">{item.body}</p>
        </div>
      ))}
      <div className="rounded-xl border border-border bg-surface-2 p-5 md:col-span-2">
        <div className="flex items-start gap-3">
          <ShieldOff className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          <p className="text-sm leading-relaxed text-muted">
            This is not a full index of the web. RankProof goes deep into one site&rsquo;s graph and
            verifies every link in the source HTML, instead of pretending to billions of URLs from a
            paid database. For a small site the result may be short — and then it is honest.
          </p>
        </div>
      </div>
      <div className="rounded-xl border border-border bg-surface p-5 md:col-span-2">
        <div className="flex items-start gap-3">
          <Newspaper className="mt-0.5 size-4 shrink-0 text-fg-soft" aria-hidden />
          <p className="text-sm leading-relaxed text-muted">
            Results export to CSV (links and domains separately) or to JSON with the full report —
            domain scores, flags and profile analytics included.
          </p>
        </div>
      </div>
    </section>
  );
}
