import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { KeyRound, Radar, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ENGINE_OPTIONS } from "@/components/scan/serp-labels";
import {
  RankMovesPanel,
  SerpCompetitorsPanel,
  SerpQueryCard,
} from "@/components/scan/serp-panels";
import { posLabel } from "@/components/scan/serp-utils";
import { cn } from "@/lib/utils";
import { checkSerpKeywords } from "@/lib/backlinks/scan";
import { MARKETS } from "@/lib/backlinks/market";
import type { KeywordStat, SerpDevice, SerpEngine, SerpMarket, SerpSnapshot } from "@/lib/backlinks/types";

export function CustomKeywordPanel({ host }: { host: string }) {
  const run = useServerFn(checkSerpKeywords);
  const [value, setValue] = useState("");
  const [engines, setEngines] = useState<SerpEngine[]>(["bing", "duckduckgo", "mojeek"]);
  const [depth, setDepth] = useState<10 | 20>(10);
  const [market, setMarket] = useState<SerpMarket>("pl");
  const [device, setDevice] = useState<SerpDevice>("desktop");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SerpSnapshot | null>(null);
  const [keywords, setKeywords] = useState<KeywordStat[]>([]);

  function toggleEngine(engine: SerpEngine) {
    setEngines((current) =>
      current.includes(engine)
        ? current.filter((item) => item !== engine)
        : [...current, engine],
    );
  }

  async function submit() {
    const list = value
      .split(/[,;\n]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 10);
    if (list.length === 0) {
      setError("Enter 1–10 keywords, separated by commas.");
      return;
    }
    if (engines.length === 0) {
      setError("Select at least one search engine.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await run({
        data: { url: host, keywords: list, engines, depth, market, device },
      });
      if (!result.ok) {
        setSnapshot(null);
        setKeywords([]);
        setError(result.error);
        return;
      }
      setSnapshot(result.snapshot);
      setKeywords(result.keywords);
    } catch (err) {
      setSnapshot(null);
      setKeywords([]);
      setError(err instanceof Error ? err.message : "The check failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-fg-soft" aria-hidden />
        <p className="text-sm font-medium text-fg">Check your own keywords</p>
      </div>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Up to 10 keywords, four independent engines, a choice of market and device, optionally top 20
        instead of top 10 — no paid API keys.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="product photography, packshot studio"
          disabled={loading}
          aria-label="Keywords to check"
        />
        <Button onClick={() => void submit()} disabled={loading} className="sm:w-52">
          {loading ? <Radar className="animate-spin" aria-hidden /> : <Search aria-hidden />}
          {loading ? "Checking…" : "Check SERP"}
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {ENGINE_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={loading}
            aria-pressed={engines.includes(option.id)}
            onClick={() => toggleEngine(option.id)}
            className={cn(
              "h-11 min-w-[44px] rounded-full border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
              engines.includes(option.id)
                ? "border-fg-soft bg-fg text-accent-fg"
                : "border-border bg-surface-2 text-muted hover:text-fg",
            )}
          >
            {option.label}
          </button>
        ))}
        <span className="ml-2 text-xs text-subtle">Market</span>
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
            {id}
          </button>
        ))}
        <span className="ml-2 text-xs text-subtle">Depth</span>
        {([10, 20] as const).map((option) => (
          <button
            key={option}
            type="button"
            disabled={loading}
            aria-pressed={depth === option}
            onClick={() => setDepth(option)}
            className={cn(
              "h-11 min-w-[44px] rounded-full border px-3 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
              depth === option
                ? "border-fg-soft bg-fg text-accent-fg"
                : "border-border bg-surface-2 text-muted hover:text-fg",
            )}
          >
            TOP {option}
          </button>
        ))}
      </div>
      {error ? (
        <p className="mt-3 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {snapshot ? (
        <div className="mt-5 flex flex-col gap-3">
          <p className="font-mono text-xs text-muted">
            visibility {snapshot.visibility}/100 · top 10: {snapshot.top10} · top 3: {snapshot.top3} ·
            traffic {snapshot.trafficScore} · avg {snapshot.avgPosition || "—"}
          </p>
          {keywords.map((row) => (
            <div
              key={row.keyword}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
            >
              <span className="text-sm text-fg">{row.keyword}</span>
              <span className="flex items-center gap-2 font-mono text-xs text-muted">
                <Badge variant="accent">difficulty {row.difficulty}</Badge>
                {row.engines.map((e) => `${e.engine} ${posLabel(e.position)}`).join(" · ")}
              </span>
            </div>
          ))}
          <RankMovesPanel moves={snapshot.moves} host={host} />
          <SerpCompetitorsPanel snapshot={snapshot} host={host} />
          {snapshot.queries.map((query) => (
            <SerpQueryCard key={`extra-${query.engine}-${query.keyword}`} query={query} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
