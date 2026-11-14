import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { FlaskConical, Globe, Loader2, Search } from "lucide-react";
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
import { AppShell } from "@/components/app-shell";
import type { ScanReport, SerpDevice, SerpMarket } from "@/lib/backlinks/types";

const EXAMPLES = ["nasa.gov", "who.int", "europa.eu"];

export function AuditPage() {
  const scan = useServerFn(scanBacklinks);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [diff, setDiff] = useState<ScanDiff | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [market, setMarket] = useState<SerpMarket>("us");
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
      "h-11 min-w-[44px] rounded-[9px] px-3 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      active
        ? "bg-accent/12 text-accent ring-1 ring-inset ring-accent/40"
        : "text-muted hover:bg-surface-3 hover:text-fg",
    );

  return (
    <AppShell
      footer={
        <p>
          Backlink discovery is incomplete and positions are a top-10 sample from Bing, DuckDuckGo,
          Mojeek and Brave, not Google&rsquo;s full index. Scores marked as models are estimates.
        </p>
      }
    >
      <section className="mt-10 md:mt-14">
        <h1 className="max-w-3xl font-display text-[36px] leading-[1.06] font-extrabold tracking-[-0.03em] text-fg md:text-[48px]">
          Audit a whole domain.
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted md:text-[17px]">
          Discover backlinks from open sources and confirm each one in the source page&rsquo;s HTML,
          then see search positions, site structure and a plan. Discovery is never complete: a link
          that is not found here may still exist.
        </p>
        <p className="rp-card mt-4 flex max-w-3xl items-start gap-2.5 px-3.5 py-3 text-sm leading-relaxed text-fg-soft">
          <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0 text-nofollow" />
          <span>
            <span className="font-semibold text-fg">Experimental. </span>
            Discovery, search positions and scores depend on public sources that change and block
            requests; treat them as leads. For links you already know about, use{" "}
            <Link to="/" className="text-fg underline underline-offset-2">
              Verify links
            </Link>
            .
          </span>
        </p>

        <form
          className="rp-shell mt-6 p-3 md:p-4"
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
                className="rp-field h-14 rounded-[12px] pl-11 text-base focus-visible:ring-0"
              />
            </div>
            <Button
              type="submit"
              size="lg"
              disabled={loading}
              className="rp-btn-primary h-14 rounded-[12px] border border-accent text-[15px] font-bold text-[#18181b] sm:w-44"
            >
              {loading ? <Loader2 className="animate-spin" /> : <Search />}
              {loading ? "Scanning…" : "Scan"}
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-3">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold text-muted">Market</span>
              <div className="flex rounded-[12px] border border-line bg-panel-3 p-1">
                {(Object.keys(MARKETS) as SerpMarket[]).map((id) => (
                  <button
                    key={id}
                    type="button"
                    disabled={loading}
                    aria-pressed={market === id}
                    aria-label={`${id.toUpperCase()}, market: ${MARKETS[id].label}`}
                    onClick={() => setMarket(id)}
                    className={segment(market === id)}
                  >
                    {id.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold text-muted">Device</span>
              <div className="flex rounded-[12px] border border-line bg-panel-3 p-1">
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

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[13px] text-muted">Try</span>
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              disabled={loading}
              onClick={() => {
                setValue(example);
                void run(example);
              }}
              className="h-9 rounded-full border border-line bg-panel-3 px-3 font-mono text-[13px] text-fg-soft transition-colors hover:border-border-strong hover:text-fg"
            >
              {example}
            </button>
          ))}
        </div>

        {error ? (
          <p className="rp-card mt-3 border-danger/40 px-3 py-2.5 text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}

        {history.length > 0 ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-[13px] text-muted">Recent</span>
            {history.map((item) => (
              <button
                key={item.host}
                type="button"
                disabled={loading}
                onClick={() => {
                  setValue(item.input);
                  void run(item.input);
                }}
                className="h-9 rounded-full border border-line bg-panel-3 px-3 text-[13px] text-fg-soft hover:border-border-strong hover:text-fg"
              >
                {item.host}
                <span className="ml-2 font-mono tabular-nums text-muted">
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
    </AppShell>
  );
}
