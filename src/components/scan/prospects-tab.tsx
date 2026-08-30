import { useState } from "react";
import { ArrowUpRight, Copy, Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { REASON_LABEL } from "@/components/scan/serp-labels";
import { download, prospectsCsv } from "@/lib/backlinks/export";
import type { ScanReport, SerpProspect } from "@/lib/backlinks/types";

function outreachDraft(row: SerpProspect, targetHost: string, targetUrl: string): string {
  return [
    `Hi,`,
    ``,
    row.reason === "unlinked-mention"
      ? `thank you for mentioning ${targetHost} in "${row.title}". Readers would find us more easily if the name were a link — here is the address: ${targetUrl}`
      : row.reason === "lost-link"
        ? `you used to link to ${targetHost} from "${row.title}", and that link is no longer there. The content is still current: ${targetUrl}`
        : `I am writing about "${row.title}" — it ranks well for "${row.keyword}". We have a complementary piece that your readers may find useful: ${targetUrl}`,
    ``,
    `Best regards`,
  ].join("\n");
}

export function ProspectsTab({ report }: { report: ScanReport }) {
  const [copied, setCopied] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm leading-relaxed text-muted">
          Pages that already rank for your keywords or mention the brand without linking. Sorted by
          priority — lost links and unlinked mentions are the cheapest to win back.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={report.prospects.length === 0}
          onClick={() =>
            download(`rankproof-${report.target.host}-prospects.csv`, prospectsCsv(report), "text/csv")
          }
        >
          <Download aria-hidden />
          Prospects CSV
        </Button>
      </div>
      <div className="rounded-xl border border-border bg-surface px-4 md:px-5">
        {report.prospects.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted">
            No opportunities in this scan. They appear when the SERP, mentions or the archive reveal pages
            without a link.
          </p>
        ) : (
          report.prospects.map((row) => (
            <article
              key={`${row.reason}-${row.domain}-${row.url}`}
              className="grid gap-3 border-b border-border py-4 last:border-b-0 md:grid-cols-[minmax(0,1.4fr)_auto] md:items-center"
            >
              <div className="min-w-0">
                <a
                  href={row.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex max-w-full items-center gap-1.5 text-sm font-medium text-fg hover:text-fg-soft"
                >
                  <span className="truncate">{row.title || row.domain}</span>
                  <ArrowUpRight className="size-3.5 shrink-0 text-subtle" aria-hidden />
                </a>
                <p className="mt-1 font-mono text-xs text-muted">
                  {row.domain}
                  {row.contactUrl ? (
                    <>
                      {" · "}
                      <a href={row.contactUrl} target="_blank" rel="noreferrer" className="hover:text-fg">
                        contact
                      </a>
                    </>
                  ) : null}
                </p>
                {row.snippet ? <p className="mt-1 line-clamp-2 text-sm text-subtle">{row.snippet}</p> : null}
              </div>
              <div className="flex flex-wrap items-center gap-2 md:justify-end">
                <Badge
                  variant={
                    row.reason === "serp-coranker"
                      ? "accent"
                      : row.reason === "lost-link"
                        ? "nofollow"
                        : "default"
                  }
                >
                  {REASON_LABEL[row.reason]}
                </Badge>
                {row.position ? <Badge>#{row.position}</Badge> : null}
                {row.keyword ? <Badge>{row.keyword}</Badge> : null}
                <span className="font-mono text-xs tabular-nums text-muted">
                  priority {row.priority} · DS {row.domainScore}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(
                      outreachDraft(row, report.target.host, report.target.url),
                    );
                    setCopied(row.url);
                    setTimeout(() => setCopied(null), 1500);
                  }}
                >
                  <Copy aria-hidden />
                  {copied === row.url ? "Copied" : "Copy email"}
                </Button>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
