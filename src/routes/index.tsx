import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Link2, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyGuide, ScanResults, ScanSkeleton } from "@/components/scan-results";
import {
  diffReport,
  findPrevious,
  loadHistory,
  pushHistory,
  toHistoryItem,
  type HistoryItem,
  type ScanDiff,
} from "@/lib/backlinks/history";
import { parseTarget } from "@/lib/backlinks/parse";
import { scanBacklinks } from "@/lib/backlinks/scan";
import { MARKETS } from "@/lib/backlinks/market";
import { cn } from "@/lib/utils";
import type { ScanReport, SerpDevice, SerpMarket } from "@/lib/backlinks/types";

const EXAMPLES = ["nasa.gov", "who.int", "gov.pl", "europa.eu"];

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const scan = useServerFn(scanBacklinks);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [diff, setDiff] = useState<ScanDiff | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [market, setMarket] = useState<SerpMarket>("pl");
  const [device, setDevice] = useState<SerpDevice>("desktop");

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  async function run(input: string) {
    const next = input.trim();
    if (!next) {
      setError("Enter a domain or URL.");
      return;
    }
    let parsed;
    try {
      parsed = parseTarget(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid address.");
      return;
    }

    setLoading(true);
    setError(null);
    const previous = findPrevious(parsed.host);
    try {
      const result = await scan({ data: { url: next, market, device } });
      if (!result.ok) {
        setReport(null);
        setDiff(null);
        setError(result.error);
        return;
      }
      setReport(result.report);
      setDiff(diffReport(result.report, previous));
      setHistory(pushHistory(toHistoryItem(result.report, next)));
    } catch (err) {
      setReport(null);
      setDiff(null);
      setError(err instanceof Error ? err.message : "The scan failed. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:border focus:border-border focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:text-fg"
      >
        Skip to main content
      </a>
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 py-6 md:px-6 md:py-10"
      >
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-md border border-border bg-surface">
            <Link2 className="size-4 text-fg" />
          </span>
          <div>
            <p className="font-display text-lg font-medium tracking-tight text-fg">RankProof</p>
            <p className="text-xs text-muted">SERP, backlinks and an action plan</p>
          </div>
        </div>
        <p className="hidden text-xs text-subtle sm:block">
          Free · no API keys · SERP + backlinks + plan
        </p>
      </header>

      <section className="mt-10 md:mt-16">
        <h1 className="max-w-3xl font-display text-4xl font-medium leading-tight tracking-tight text-fg md:text-5xl">
          What you rank for, who links to you, and what to do tomorrow morning.
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
          Enter a domain. The scanner reads the page and sitemap, confirms every backlink in the
          source HTML, pulls keywords from titles, headings and anchors, then checks positions in
          Bing, DuckDuckGo and Mojeek for your chosen market — and crawls your own site to map how
          it links to itself. You get a visibility index, keyword difficulty, topic clusters, a
          brand SERP audit, a risk assessment and an ordered action plan.
        </p>

        <form
          className="mt-8 rounded-xl border border-border bg-surface p-3 md:p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run(value);
          }}
        >
          <label htmlFor="target" className="sr-only">
            Site address
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Input
              id="target"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="nasa.gov or https://example.com"
              autoComplete="url"
              inputMode="url"
              disabled={loading}
            />
            <Button type="submit" size="lg" disabled={loading} className="sm:w-44">
              {loading ? <Loader2 className="animate-spin" /> : <Search />}
              {loading ? "Scanning…" : "Scan"}
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-subtle">Market</span>
            {(Object.keys(MARKETS) as SerpMarket[]).map((id) => (
              <button
                key={id}
                type="button"
                disabled={loading}
                aria-pressed={market === id}
                aria-label={`Market: ${MARKETS[id].label}`}
                onClick={() => setMarket(id)}
                className={cn(
                  "h-11 min-w-[44px] rounded-full border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                  market === id
                    ? "border-fg-soft bg-fg text-accent-fg"
                    : "border-border bg-surface-2 text-muted hover:text-fg",
                )}
              >
                {id.toUpperCase()}
              </button>
            ))}
            <span className="ml-2 text-xs text-subtle">Device</span>
            {(["desktop", "mobile"] as const).map((id) => (
              <button
                key={id}
                type="button"
                disabled={loading}
                aria-pressed={device === id}
                onClick={() => setDevice(id)}
                className={cn(
                  "h-11 min-w-[44px] rounded-full border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                  device === id
                    ? "border-fg-soft bg-fg text-accent-fg"
                    : "border-border bg-surface-2 text-muted hover:text-fg",
                )}
              >
                {id === "desktop" ? "desktop" : "mobile"}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-subtle">Examples</span>
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                disabled={loading}
                onClick={() => {
                  setValue(example);
                  void run(example);
                }}
                className="h-9 rounded-full border border-border px-3 font-mono text-xs text-muted hover:text-fg"
              >
                {example}
              </button>
            ))}
          </div>
        </form>

        {error ? (
          <p className="mt-3 text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}

        {history.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {history.map((item) => (
              <button
                key={item.host}
                type="button"
                disabled={loading}
                onClick={() => {
                  setValue(item.input);
                  void run(item.input);
                }}
                className="h-9 rounded-full border border-border bg-surface-2 px-3 text-xs text-muted hover:text-fg"
              >
                {item.host}
                <span className="ml-2 font-mono tabular-nums text-subtle">
                  {item.backlinks} links · {item.referringDomains} domains
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <div className="mt-10 flex-1">
        {loading ? <ScanSkeleton /> : null}
        {!loading && report ? <ScanResults report={report} diff={diff} /> : null}
        {!loading && !report ? <EmptyGuide /> : null}
      </div>

      <footer className="mt-12 border-t border-border pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-xs leading-relaxed text-subtle">
        RankProof does not use Ahrefs, Semrush or Majestic. Every scan is a set of queries against
        open sources, HTML verification and organic results from Bing, DuckDuckGo, Mojeek and Brave.
        Positions are a top-10 sample from those engines, not Google&rsquo;s full index — but every
        backlink shown here was confirmed in the source page. Connect Google Search Console and the
        report adds real clicks and Google positions alongside them. Scan history (links, DR,
        visibility, keyword positions) stays in the database and in your browser, so the next scan
        shows gains and drops. The visibility index is comparable between scans of the same domain;
        it is not an equivalent of commercial metrics.
      </footer>
    </main>
    </>
  );
}
