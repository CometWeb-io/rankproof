import { ArrowRight, Radar, ShieldOff } from "lucide-react";

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
  const steps = [
    {
      title: "Read the site",
      body: "The live page, sitemap, subdomains and archive copies name the partners most likely to link back.",
      out: "partner domains",
    },
    {
      title: "Ask open sources",
      body: "Wikipedia, GitHub, Hacker News, Reddit, Common Crawl and eight more. Each hit is only a candidate.",
      out: "candidate pages",
    },
    {
      title: "Open every candidate",
      body: "Each page is fetched and checked for an exact href, with rel, placement and target status.",
      out: "confirmed backlinks",
    },
    {
      title: "Report",
      body: "Keywords from titles and anchors, top-10 positions, site structure and an ordered plan.",
      out: "CSV, JSON and a plan",
    },
  ];
  return (
    <section aria-labelledby="audit-steps-heading" className="rp-shell p-4 md:p-5">
      <h2 id="audit-steps-heading" className="text-base font-bold text-fg">
        What a scan does
      </h2>
      <p className="mt-1 text-[13px] text-muted">
        Four steps, in this order. Each step feeds the next.
      </p>
      <ol className="mt-4 grid gap-2 md:grid-cols-4">
        {steps.map((step, index) => (
          <li key={step.title} className="rp-card relative flex flex-col p-4">
            <span className="flex items-center gap-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line bg-panel-3 font-mono text-[13px] font-semibold text-fg tabular-nums">
                {index + 1}
              </span>
              <span className="text-[15px] font-bold text-fg">{step.title}</span>
            </span>
            <p className="mt-2 flex-1 text-[13px] leading-relaxed text-fg-soft">{step.body}</p>
            <p className="mt-3 flex items-center gap-1.5 text-[13px] text-muted">
              <ArrowRight aria-hidden className="size-3.5 shrink-0 text-accent" />
              <span className="sr-only">Produces </span>
              {step.out}
            </p>
          </li>
        ))}
      </ol>
      <p className="mt-4 flex items-start gap-2 text-[13px] leading-relaxed text-muted">
        <ShieldOff className="mt-0.5 size-4 shrink-0" aria-hidden />
        Not a full index of the web: a small site may get a short list, and then it is an honest
        one.
      </p>
    </section>
  );
}
