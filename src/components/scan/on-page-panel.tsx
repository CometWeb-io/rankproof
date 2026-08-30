import { FileSearch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Meter } from "@/components/scan/ui-primitives";
import type { OnPageAudit } from "@/lib/backlinks/types";

export function OnPagePanel({ audit }: { audit: OnPageAudit }) {
  const checks: { label: string; ok: boolean; hint: string }[] = [
    {
      label: "Title",
      ok: Boolean(audit.title) && audit.titleLength >= 12 && audit.titleLength <= 70,
      hint: audit.title ? `${audit.titleLength} characters` : "missing",
    },
    {
      label: "Meta description",
      ok: Boolean(audit.description) && audit.descriptionLength >= 70 && audit.descriptionLength <= 160,
      hint: audit.description ? `${audit.descriptionLength} characters` : "missing",
    },
    {
      label: "H1",
      ok: audit.h1.length === 1,
      hint: audit.h1[0] ?? (audit.h1.length > 1 ? `${audit.h1.length} headings` : "missing"),
    },
    {
      label: "Canonical",
      ok: audit.canonicalOk,
      hint: audit.canonical ? "set" : "none — OK",
    },
    {
      label: "Schema",
      ok: audit.schemaTypes.length > 0,
      hint: audit.schemaTypes.slice(0, 3).join(", ") || "no JSON-LD",
    },
    {
      label: "HTTPS / index",
      ok: audit.https && !audit.robotsNoindex,
      hint: `${audit.https ? "HTTPS" : "HTTP"}${audit.robotsNoindex ? " · noindex" : ""}`,
    },
  ];

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileSearch className="size-4 text-fg-soft" aria-hidden />
          <p className="text-sm font-medium text-fg">On-page readiness</p>
        </div>
        <p className="font-mono text-2xl tabular-nums text-fg">
          {audit.score}
          <span className="ml-2 text-sm text-muted">/ 100</span>
        </p>
      </div>
      <div className="mt-3">
        <Meter value={audit.score} tone={audit.score >= 70 ? "good" : audit.score < 40 ? "risk" : "default"} />
      </div>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {checks.map((check) => (
          <li key={check.label} className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-fg-soft">{check.label}</span>
              <Badge variant={check.ok ? "follow" : "nofollow"}>{check.ok ? "OK" : "needs work"}</Badge>
            </div>
            <p className="mt-1 truncate text-xs text-subtle" title={check.hint}>
              {check.hint}
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-3 font-mono text-xs text-subtle">
        {audit.wordCount} words · {audit.internalLinks} internal links · {audit.externalLinks} outbound
        {audit.ogImage ? " · OG image" : ""}
      </p>
    </div>
  );
}
