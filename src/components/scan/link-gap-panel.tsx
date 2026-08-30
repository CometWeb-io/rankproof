import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ArrowUpRight, Download, Radar, Swords, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { download, gapCsv } from "@/lib/backlinks/export";
import { scanLinkGap } from "@/lib/backlinks/scan";
import type { LinkGapReport } from "@/lib/backlinks/types";

export function LinkGapPanel({ host }: { host: string }) {
  const runGap = useServerFn(scanLinkGap);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gap, setGap] = useState<LinkGapReport | null>(null);

  async function run() {
    const competitors = value
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 5);
    if (competitors.length === 0) {
      setError("Enter 1–5 competitor domains, separated by commas.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await runGap({ data: { url: host, competitors } });
      if (!result.ok) {
        setGap(null);
        setError(result.error);
        return;
      }
      setGap(result.report);
    } catch (err) {
      setGap(null);
      setError(err instanceof Error ? err.message : "The analysis failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-border bg-surface p-5">
        <div className="flex items-center gap-2">
          <Swords className="size-4 text-fg-soft" aria-hidden />
          <p className="text-sm font-medium text-fg">Link gap vs competitors</p>
        </div>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          Enter up to five competitor domains. We run a quick scan on each and show domains that link
          to them but not to you, ordered by frequency — a ready-made outreach target list.
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="rival.com, other.com"
            disabled={loading}
            aria-label="Competitor domains"
          />
          <Button onClick={() => void run()} disabled={loading} className="sm:w-52">
            {loading ? <Radar className="animate-spin" aria-hidden /> : <Users aria-hidden />}
            {loading ? "Analysing…" : "Compare profiles"}
          </Button>
        </div>
        {error ? (
          <p className="mt-3 text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {gap ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {gap.competitors.map((competitor) => (
              <div key={competitor.host} className="rounded-lg border border-border bg-surface p-4">
                <p className="truncate font-mono text-sm text-fg">{competitor.host}</p>
                {competitor.error ? (
                  <p className="mt-2 text-xs text-nofollow">{competitor.error}</p>
                ) : (
                  <p className="mt-2 font-mono text-xs text-muted">
                    DR {competitor.domainRating} · {competitor.referringDomains} domains ·{" "}
                    {competitor.backlinks} links
                  </p>
                )}
              </div>
            ))}
            <div className="rounded-lg border border-border bg-surface-2 p-4">
              <p className="text-xs text-muted uppercase">Shared domains</p>
              <p className="mt-2 font-mono text-2xl tabular-nums text-fg">{gap.shared.length}</p>
              <p className="mt-1 text-xs text-subtle">{gap.unique.length} domains link only to you</p>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-4">
              <p className="text-sm text-muted">{gap.gap.length} domains to pursue</p>
              <Button
                variant="outline"
                size="sm"
                disabled={gap.gap.length === 0}
                onClick={() =>
                  download(`rankproof-gap-${gap.target}.csv`, gapCsv(gap), "text/csv")
                }
              >
                <Download aria-hidden />
                Export CSV
              </Button>
            </div>
            {gap.gap.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted">
                No domains found that link to the competitors while skipping you.
              </p>
            ) : (
              gap.gap.slice(0, 80).map((row) => (
                <article
                  key={row.domain}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
                >
                  <div className="min-w-0">
                    <a
                      href={row.sampleUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 font-mono text-sm text-fg hover:text-fg-soft"
                    >
                      {row.domain}
                      <ArrowUpRight className="size-3.5 text-subtle" aria-hidden />
                    </a>
                    <p className="mt-1 text-xs text-subtle">
                      links to: {row.competitors.join(", ")}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={row.dofollow ? "follow" : "default"}>
                      {row.dofollow ? "dofollow" : "nofollow"}
                    </Badge>
                    <Badge variant={row.competitors.length > 1 ? "accent" : "default"}>
                      {row.competitors.length} of {gap.competitors.length}
                    </Badge>
                    <span className="font-mono text-xs tabular-nums text-muted">
                      priority {row.priority} · DS {row.domainScore}
                    </span>
                  </div>
                </article>
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
