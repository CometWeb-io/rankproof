import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Github, Globe, Link2, Loader2, Search } from "lucide-react";
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

  const segment = (active: boolean) =>
    cn(
      "h-11 min-w-[44px] rounded-[10px] px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      active
        ? "bg-accent/12 text-accent ring-1 ring-inset ring-accent/40"
        : "text-muted hover:bg-surface-3 hover:text-fg",
    );

  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:border focus:border-border focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:text-fg"
      >
        Skip to main content
      </a>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 -z-10 h-[520px] bg-[radial-gradient(ellipse_55%_60%_at_50%_0%,rgba(5,242,155,0.13),transparent_70%)]"
      />
      <div aria-hidden className="rp-stars pointer-events-none fixed inset-0 -z-20" />
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 py-6 md:px-6 md:py-8"
      >
        <header className="sticky top-3 z-30 flex h-[60px] items-center justify-between gap-4 rounded-2xl border border-white/8 bg-[rgba(22,22,24,0.72)] pr-2.5 pl-4 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.6)] backdrop-blur-md">
          <div className="flex items-center gap-2.5">
            <Link2 className="size-5 text-accent" />
            <p className="font-display text-base font-bold tracking-tight text-fg">RankProof</p>
          </div>
          <a
            href="https://github.com/CometWeb-io/rankproof"
            className="inline-flex h-[38px] items-center overflow-hidden rounded-[14px] border border-white/14 bg-[rgba(39,39,42,0.52)] text-[13px] font-bold text-fg transition-colors hover:border-white/26 hover:bg-[rgba(63,63,70,0.68)]"
          >
            <span className="flex items-center gap-2 px-3">
              <Github className="size-[15px]" aria-hidden />
              GitHub
            </span>
            <span className="flex h-full items-center border-l border-white/14 px-3 text-xs font-semibold text-muted">
              MIT
            </span>
          </a>
        </header>

        <section className="mt-12 md:mt-20">
          <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-accent">
            <span className="size-1.5 rounded-full bg-accent shadow-[0_0_10px_rgba(5,242,155,0.8)]" />
            Backlinks · SERP · action plan
          </p>
          <h1 className="mt-4 max-w-3xl font-display text-[44px] leading-[1.02] font-extrabold tracking-[-0.035em] text-fg md:text-[64px]">
            Backlinks you can prove.
          </h1>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-muted md:text-lg">
            Enter a domain. Every backlink is confirmed in the source page&rsquo;s HTML, and you get
            your positions and an ordered plan.
          </p>

          <form
            className="mt-8 rounded-[14px] border border-border bg-surface p-3 shadow-[0_40px_120px_-40px_rgba(5,242,155,0.18),0_30px_80px_-30px_rgba(0,0,0,0.8)] md:p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(value);
            }}
          >
            <label htmlFor="target" className="sr-only">
              Site address
            </label>
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="relative flex-1">
                <Globe
                  className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-subtle"
                  aria-hidden
                />
                <Input
                  id="target"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder="nasa.gov or https://example.com"
                  autoComplete="url"
                  inputMode="url"
                  disabled={loading}
                  className="h-14 rounded-[14px] pl-11 text-base"
                />
              </div>
              <Button
                type="submit"
                size="lg"
                disabled={loading}
                className="rp-btn-primary h-14 rounded-[14px] border border-accent text-[15px] font-bold text-[#18181b] sm:w-44"
              >
                {loading ? <Loader2 className="animate-spin" /> : <Search />}
                {loading ? "Scanning…" : "Scan"}
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-subtle">Market</span>
                <div className="flex rounded-[14px] border border-border bg-surface-2 p-1">
                  {(Object.keys(MARKETS) as SerpMarket[]).map((id) => (
                    <button
                      key={id}
                      type="button"
                      disabled={loading}
                      aria-pressed={market === id}
                      aria-label={`Market: ${MARKETS[id].label}`}
                      onClick={() => setMarket(id)}
                      className={segment(market === id)}
                    >
                      {id.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-subtle">Device</span>
                <div className="flex rounded-[14px] border border-border bg-surface-2 p-1">
                  {(["desktop", "mobile"] as const).map((id) => (
                    <button
                      key={id}
                      type="button"
                      disabled={loading}
                      aria-pressed={device === id}
                      onClick={() => setDevice(id)}
                      className={segment(device === id)}
                    >
                      {id}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </form>

          <div className="mt-4 flex flex-wrap items-center gap-x-1 gap-y-2 text-xs">
            <span className="mr-1 text-subtle">Try</span>
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                disabled={loading}
                onClick={() => {
                  setValue(example);
                  void run(example);
                }}
                className="h-9 rounded-lg px-2.5 font-mono text-muted transition-colors hover:bg-surface-2 hover:text-fg"
              >
                {example}
              </button>
            ))}
          </div>

          {error ? (
            <p className="mt-3 text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}

          {history.length > 0 ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-xs text-subtle">Recent</span>
              {history.map((item) => (
                <button
                  key={item.host}
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    setValue(item.input);
                    void run(item.input);
                  }}
                  className="h-9 rounded-lg border border-border bg-surface-2 px-3 text-xs text-muted hover:text-fg"
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

        <div className="mt-12 flex-1">
          {loading ? <ScanSkeleton /> : null}
          {!loading && report ? <ScanResults report={report} diff={diff} /> : null}
          {!loading && !report ? <EmptyGuide /> : null}
        </div>

        <footer className="mt-12 flex flex-col gap-2 border-t border-border pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-xs leading-relaxed text-subtle sm:flex-row sm:items-center sm:justify-between">
          <p>
            Open sources and HTML verification, no paid SEO APIs. Positions are a top-10 sample from
            Bing, DuckDuckGo, Mojeek and Brave, not Google&rsquo;s full index.
          </p>
          <a
            href="https://github.com/CometWeb-io/rankproof/blob/main/docs/metrics.md"
            className="shrink-0 text-muted hover:text-fg"
          >
            Methodology ↗
          </a>
        </footer>
      </main>
    </>
  );
}
