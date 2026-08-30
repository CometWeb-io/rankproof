import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Download, Lightbulb, Radar, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IDEA_SOURCE_LABEL, INTENT_LABEL } from "@/components/scan/serp-labels";
import { cn } from "@/lib/utils";
import { suggestKeywordIdeas } from "@/lib/backlinks/scan";
import { download, keywordIdeasCsv } from "@/lib/backlinks/export";
import type { KeywordIdea, KeywordIntent } from "@/lib/backlinks/types";

export function KeywordIdeasPanel({ host, seeds }: { host: string; seeds: string[] }) {
  const run = useServerFn(suggestKeywordIdeas);
  const [value, setValue] = useState(seeds.join(", "));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ideas, setIdeas] = useState<KeywordIdea[]>([]);
  const [filter, setFilter] = useState<KeywordIntent | "all">("all");

  async function submit() {
    const list = value
      .split(/[,;\n]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 5);
    if (list.length === 0) {
      setError("Enter 1–5 seed keywords.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await run({ data: { keywords: list } });
      if (!result.ok) {
        setIdeas([]);
        setError(result.error);
        return;
      }
      setIdeas(result.ideas);
    } catch (err) {
      setIdeas([]);
      setError(err instanceof Error ? err.message : "Suggestions could not be fetched.");
    } finally {
      setLoading(false);
    }
  }

  const visible = filter === "all" ? ideas : ideas.filter((idea) => idea.intent === filter);

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex items-center gap-2">
        <Lightbulb className="size-4 text-fg-soft" aria-hidden />
        <p className="text-sm font-medium text-fg">Keyword ideas</p>
      </div>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Autocomplete from DuckDuckGo and Bing, related searches and SERP questions. These are queries
        people actually type — with commercial intent marked.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="product photography"
          disabled={loading}
          aria-label="Seed keywords"
        />
        <Button onClick={() => void submit()} disabled={loading} className="sm:w-52">
          {loading ? <Radar className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
          {loading ? "Searching…" : "Find keywords"}
        </Button>
      </div>
      {error ? (
        <p className="mt-3 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {ideas.length > 0 ? (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {(["all", "transactional", "commercial", "informational", "local"] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={filter === item}
                onClick={() => setFilter(item)}
                className={cn(
                  "h-11 min-w-[44px] rounded-full border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                  filter === item
                    ? "border-fg-soft bg-fg text-accent-fg"
                    : "border-border bg-surface-2 text-muted hover:text-fg",
                )}
              >
                {item === "all" ? "all" : INTENT_LABEL[item]}
              </button>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => download(`rankproof-${host}-keyword-ideas.csv`, keywordIdeasCsv(ideas), "text/csv")}
            >
              <Download aria-hidden />
              Ideas CSV
            </Button>
          </div>
          <ul className="mt-3 grid gap-2 md:grid-cols-2">
            {visible.slice(0, 40).map((idea) => (
              <li
                key={idea.keyword}
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <span className="min-w-0 truncate text-sm text-fg">{idea.keyword}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge variant={idea.intent === "transactional" ? "follow" : "default"}>
                    {INTENT_LABEL[idea.intent]}
                  </Badge>
                  <span className="font-mono text-xs text-subtle">{IDEA_SOURCE_LABEL[idea.source]}</span>
                  <span className="font-mono text-xs tabular-nums text-muted">{idea.score}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
