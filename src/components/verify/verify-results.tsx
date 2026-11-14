import { useState, type ReactNode } from "react";
import { ArrowRight, ChevronDown, Copy, Check, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CHANGE_LABELS,
  VERDICT_LABELS,
  type ContractMark,
  type ContractVerdict,
  type VerifiedRow,
  type VerifySummary,
} from "@/lib/backlinks/observe";
import type { BacklinkObservation } from "@/lib/backlinks/verify-api.server";
import { formatDate, formatDateTime, isChanged, type Sort } from "./format";
import { timelineFor, type StoredRun } from "./run-store";
import { StatusDot, VerdictChip } from "./status";
import { VERDICT_FILL, VERDICT_HELP, VERDICT_TONE } from "./status-tone";

export type LedgerRow = VerifiedRow & Partial<BacklinkObservation>;
export type Filter = ContractVerdict | "changed" | "all";

export function SummaryBar({
  summary,
  filter,
  onFilter,
  showChanges,
}: {
  summary: VerifySummary;
  filter: Filter;
  onFilter: (filter: Filter) => void;
  showChanges: boolean;
}) {
  const verdicts = ["meets", "deviates", "missing", "unverified"] as const;
  const items: { key: Filter; label: string; value: number; help: string; tone: string }[] =
    verdicts.map((key) => ({
      key,
      label: VERDICT_LABELS[key],
      value: summary[key],
      help: VERDICT_HELP[key],
      tone: VERDICT_TONE[key],
    }));
  if (showChanges) {
    items.push({
      key: "changed",
      label: "Changed",
      value: summary.changed,
      help: "Different from the run you are comparing with.",
      tone: "text-changed",
    });
  }
  return (
    <div className="rp-shell p-3 md:p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1">
        <p className="text-[15px] font-semibold text-fg">
          <span className="text-follow tabular-nums">{summary.meets}</span>
          <span className="text-muted"> of </span>
          <span className="tabular-nums">{summary.total}</span> meet their contract
        </p>
        <p className="text-[13px] text-muted">Pick a result to show only those rows.</p>
      </div>
      {/* Share of each result in the run; the tiles below carry the numbers. */}
      <div aria-hidden className="mt-3 flex h-2 gap-0.5 overflow-hidden rounded-full bg-panel-3">
        {verdicts.map((key) =>
          summary[key] > 0 ? (
            <span
              key={key}
              className={cn("h-full first:rounded-l-full last:rounded-r-full", VERDICT_FILL[key])}
              style={{ flexGrow: summary[key] }}
            />
          ) : null,
        )}
      </div>
      <div
        role="group"
        aria-label="Filter by result"
        className={cn(
          "mt-3 grid grid-cols-2 gap-2",
          items.length === 5 ? "sm:grid-cols-5" : "sm:grid-cols-4",
        )}
      >
        {items.map((item) => {
          const active = filter === item.key;
          return (
            <button
              key={item.key}
              type="button"
              aria-pressed={active}
              title={item.help}
              onClick={() => onFilter(active ? "all" : item.key)}
              className={cn(
                "group flex min-h-[76px] flex-col items-start justify-between rounded-[10px] border px-3.5 py-3 text-left transition-colors",
                active
                  ? "border-fg-soft/45 bg-surface-3"
                  : "border-line-soft bg-panel-3 hover:border-border-strong",
                item.value === 0 && !active && "opacity-70",
              )}
            >
              <span className={cn("flex items-center gap-2 text-[13px] font-semibold", item.tone)}>
                <StatusDot />
                <span className="text-fg-soft">{item.label}</span>
              </span>
              <span className="mt-1 flex w-full items-end justify-between gap-2">
                <span className="font-display text-[28px] leading-none font-bold text-fg tabular-nums">
                  {item.value}
                </span>
                <span className="text-xs text-subtle">
                  {active ? "Showing" : item.value > 0 ? "Show" : ""}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Search and sort above a ledger; shared with saved lists. */
export function LedgerToolbar({
  query,
  onQuery,
  sort,
  onSort,
  shown,
  total,
  inputLabel = "As pasted",
}: {
  query: string;
  onQuery: (value: string) => void;
  sort: Sort;
  onSort: (value: Sort) => void;
  shown: number;
  total: number;
  inputLabel?: string;
}) {
  return (
    <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <label className="relative block sm:w-80">
        <span className="sr-only">Search links</span>
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Search source, target or anchor"
          className="rp-field h-10 w-full rounded-[10px] pr-3 pl-9 text-sm"
        />
      </label>
      <div className="flex items-center justify-between gap-3 text-sm sm:justify-end">
        <span className="text-[13px] text-muted tabular-nums">
          {shown === total ? `${total} rows` : `${shown} of ${total} rows`}
        </span>
        <label className="flex items-center gap-2 text-muted">
          Sort
          <select
            value={sort}
            onChange={(event) => onSort(event.target.value as Sort)}
            className="rp-field h-10 rounded-[10px] px-2 text-sm"
          >
            <option value="input">{inputLabel}</option>
            <option value="problems">Problems first</option>
            <option value="source">Source A–Z</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function Clause({
  label,
  expected,
  observed,
  mark,
}: {
  label: string;
  expected: string | null | undefined;
  observed: string | null;
  mark: ContractMark;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-subtle md:sr-only">{label}</p>
      <p className="truncate text-[13px] text-fg" title={observed ?? undefined}>
        {observed ?? <span className="text-subtle">—</span>}
      </p>
      {expected ? (
        <p
          className={cn(
            "mt-0.5 flex min-w-0 items-center gap-1 text-xs",
            mark === "match"
              ? "text-follow"
              : mark === "mismatch"
                ? "text-nofollow"
                : "text-subtle",
          )}
          title={`Expected: ${expected}`}
        >
          {mark === "match" ? (
            <>
              <Check aria-hidden className="size-3.5 shrink-0" />
              as agreed
            </>
          ) : (
            <span className="truncate">expected {expected}</span>
          )}
        </p>
      ) : null}
    </div>
  );
}

const LEDGER_GRID =
  "md:grid-cols-[150px_minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,0.75fr)_minmax(0,0.75fr)_16px]";

export function Ledger({ rows, runs = [] }: { rows: LedgerRow[]; runs?: StoredRun[] }) {
  if (rows.length === 0) {
    return (
      <p className="rp-shell px-4 py-10 text-center text-sm text-muted">
        No pairs match this filter or search.
      </p>
    );
  }
  return (
    <div className="rp-shell overflow-hidden">
      <div
        aria-hidden
        className={cn(
          "hidden gap-5 border-b border-line-soft bg-panel-2 px-4 py-2.5 md:grid",
          LEDGER_GRID,
        )}
      >
        {["Result", "Source → target", "Anchor", "rel", "Placement"].map((label) => (
          <span key={label} className="rp-kicker">
            {label}
          </span>
        ))}
      </div>
      <ol className="divide-y divide-line-soft" aria-label="Verified pairs">
        {rows.map((row) => (
          <LedgerItem key={`${row.source_url}\u0000${row.target_url}`} row={row} runs={runs} />
        ))}
      </ol>
    </div>
  );
}

function Tag({ children, tone }: { children: ReactNode; tone?: "warn" | "info" }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full border px-2 text-xs whitespace-nowrap",
        tone === "warn"
          ? "border-nofollow/35 bg-nofollow/10 text-nofollow"
          : tone === "info"
            ? "border-changed/35 bg-changed/10 text-changed"
            : "border-line bg-panel-3 text-fg-soft",
      )}
    >
      {children}
    </span>
  );
}

function LedgerItem({ row, runs }: { row: LedgerRow; runs: StoredRun[] }) {
  const [open, setOpen] = useState(false);
  const changed = isChanged(row);
  const relShown = row.status === "confirmed" ? row.rel || "none" : null;
  const id = `evidence-${hashId(row.source_url + row.target_url)}`;
  const tags =
    (row.contract.basis === "rendered_dom" && row.contract.target === "exact") ||
    row.contract.visibility === "mismatch" ||
    row.contract.mentioned;
  return (
    <li className={cn(open && "bg-panel-2/60")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "grid w-full grid-cols-3 gap-x-4 gap-y-3 px-4 py-3.5 text-left transition-colors hover:bg-white/[0.025] md:items-center md:gap-5",
          LEDGER_GRID,
        )}
      >
        <div className="col-span-3 flex flex-wrap items-center gap-1.5 md:col-span-1 md:flex-col md:items-start">
          <VerdictChip verdict={row.contract.verdict} />
          {changed && row.change ? <Tag tone="info">{CHANGE_LABELS[row.change.kind]}</Tag> : null}
          <ChevronDown
            aria-hidden
            className={cn(
              "ml-auto size-4 text-subtle transition-transform md:hidden",
              open && "rotate-180",
            )}
          />
        </div>
        <div className="col-span-3 min-w-0 md:col-span-1">
          <p className="truncate font-mono text-[13px] text-fg" title={row.source_url}>
            {prettyUrl(row.source_url)}
          </p>
          <p
            className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted"
            title={row.target_url}
          >
            <ArrowRight aria-hidden className="size-3.5 shrink-0 text-subtle" />
            <span className="sr-only">to </span>
            <span className="truncate">{prettyUrl(row.target_url)}</span>
          </p>
          {tags ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {row.contract.basis === "rendered_dom" && row.contract.target === "exact" ? (
                <Tag>Only after JavaScript</Tag>
              ) : null}
              {row.contract.visibility === "mismatch" ? (
                <Tag tone="warn">Hidden from visitors</Tag>
              ) : null}
              {row.contract.mentioned ? <Tag>Mentioned, not linked</Tag> : null}
            </div>
          ) : null}
        </div>
        <Clause
          label="Anchor"
          expected={row.expected_anchor}
          observed={row.status === "confirmed" ? shownAnchor(row) || "(empty)" : null}
          mark={row.contract.anchor}
        />
        <Clause
          label="rel"
          expected={row.expected_rel}
          observed={relShown}
          mark={row.contract.rel}
        />
        <Clause
          label="Placement"
          expected={row.expected_placement}
          observed={
            row.status !== "confirmed"
              ? null
              : row.contract.placement === "match" && row.expected_placement
                ? row.expected_placement
                : row.placement && row.placement !== "unknown"
                  ? row.placement
                  : "not detectable"
          }
          mark={row.contract.placement ?? "unspecified"}
        />
        <ChevronDown
          aria-hidden
          className={cn(
            "hidden size-4 text-subtle transition-transform md:block",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? <Evidence row={row} id={id} runs={runs} /> : null}
    </li>
  );
}

function Evidence({ row, id, runs }: { row: LedgerRow; id: string; runs: StoredRun[] }) {
  const timeline = runs.length > 1 ? timelineFor(runs, row.source_url, row.target_url) : [];
  const facts: [string, string | null | undefined][] = [
    ["Checked", row.checked_at ? formatDateTime(row.checked_at) : null],
    ["HTTP status", row.http_status ? String(row.http_status) : null],
    ["Final URL", row.final_url],
    ["Matched href", row.resolved_href],
    ["Extractor", row.extraction_version],
    ["URL identity", row.identity_policy],
  ];
  return (
    <div id={id} className="px-4 pt-1 pb-4">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="rp-card min-w-0 p-4">
          <h3 className="text-sm font-semibold text-fg">What this means</h3>
          <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-fg-soft">
            {row.reason && row.status === "error" ? <li>{row.reason}</li> : null}
            {row.contract.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
            {row.change && row.change.kind !== "first" ? (
              <li className="text-muted">
                {row.change.detail}
                {row.change.since
                  ? ` Compared with the run of ${formatDate(row.change.since)}.`
                  : ""}
              </li>
            ) : null}
          </ul>
          {row.context ? (
            <figure className="mt-4">
              <figcaption className="rp-label">Around the link</figcaption>
              <blockquote className="rp-tile mt-1.5 px-3 py-2.5 text-sm leading-relaxed text-fg-soft">
                <Highlighted text={row.context} needle={row.anchor ?? ""} />
              </blockquote>
            </figure>
          ) : null}
          {row.matching_anchors && row.matching_anchors.length > 0 ? (
            <AnchorList
              title={`Anchors to the exact URL (${row.matching_anchors.length})`}
              items={row.matching_anchors.map((a) => ({
                anchor: a.anchor,
                rel: a.rel,
                href: a.resolved_href,
                note: a.placement && a.placement !== "unknown" ? `in ${a.placement}` : undefined,
              }))}
            />
          ) : null}
          {row.mentions && row.mentions.length > 0 ? (
            <div className="mt-4">
              <h4 className="rp-label">Mentioned on the page without a link</h4>
              <ul className="mt-1.5 space-y-1.5">
                {row.mentions.map((mention) => (
                  <li key={mention.term} className="rp-tile px-3 py-2 text-sm text-fg-soft">
                    <Highlighted text={mention.snippet} needle={mention.term} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {timeline.length > 1 ? <Timeline points={timeline} /> : null}
          {row.status === "confirmed" && row.near_matches && row.near_matches.length > 0 ? (
            <p className="mt-4 text-[13px] text-muted">
              The page also links to {row.near_matches.length}
              {row.near_matches.length >= 10 ? "+" : ""} other URL
              {row.near_matches.length === 1 ? "" : "s"} on the target site.
            </p>
          ) : null}
          {row.status !== "confirmed" && row.near_matches && row.near_matches.length > 0 ? (
            <AnchorList
              title="Links to the same site, other URL"
              items={row.near_matches.map((a) => ({
                anchor: a.anchor,
                rel: a.rel,
                href: a.resolved_href,
                note: a.difference,
              }))}
            />
          ) : null}
        </div>
        <div className="rp-card min-w-0 p-4">
          <h3 className="text-sm font-semibold text-fg">Observation receipt</h3>
          <dl className="mt-2 divide-y divide-line-soft text-sm">
            {facts
              .filter(([, value]) => value)
              .map(([label, value]) => (
                <div key={label} className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 py-1.5">
                  <dt className="text-muted">{label}</dt>
                  <dd
                    className="truncate font-mono text-[13px] text-fg-soft"
                    title={value ?? undefined}
                  >
                    {value}
                  </dd>
                </div>
              ))}
            <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 py-1.5">
              <dt className="text-muted">SHA-256</dt>
              <dd className="min-w-0">
                {row.response_hash ? (
                  <CopyHash value={row.response_hash} />
                ) : (
                  <span className="text-[13px] text-subtle">no response body</span>
                )}
              </dd>
            </div>
          </dl>
          {row.rendered ? <RenderedReceipt rendered={row.rendered} /> : null}
          <p className="mt-3 text-xs leading-relaxed text-muted">
            The hash identifies the exact HTML that was inspected. Save it with{" "}
            <code className="font-mono text-fg-soft">rankproof verify --capture-dir</code> to replay
            the check later.
          </p>
        </div>
      </div>
    </div>
  );
}

function RenderedReceipt({ rendered }: { rendered: NonNullable<LedgerRow["rendered"]> }) {
  const label =
    rendered.status === "confirmed"
      ? rendered.visible === false
        ? "linked, but hidden"
        : "linked and visible"
      : rendered.status === "not_found"
        ? "no link after JavaScript"
        : "could not render";
  const facts: [string, string | null | undefined][] = [
    ["Result", label],
    ["Engine", rendered.engine],
    ["Rendered", rendered.rendered_at ? formatDateTime(rendered.rendered_at) : null],
    ["Final URL", rendered.final_url],
    ["Blocked requests", rendered.blocked_requests ? String(rendered.blocked_requests) : null],
    ["Reason", rendered.status === "confirmed" ? null : rendered.reason],
  ];
  return (
    <div className="mt-4">
      <h3 className="rp-label">In a browser</h3>
      <dl className="mt-1 divide-y divide-line-soft text-sm">
        {facts
          .filter(([, value]) => value)
          .map(([name, value]) => (
            <div key={name} className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 py-1.5">
              <dt className="text-muted">{name}</dt>
              <dd
                className="truncate font-mono text-[13px] text-fg-soft"
                title={value ?? undefined}
              >
                {value}
              </dd>
            </div>
          ))}
        {rendered.dom_hash ? (
          <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 py-1.5">
            <dt className="text-muted">DOM SHA-256</dt>
            <dd className="min-w-0">
              <CopyHash value={rendered.dom_hash} />
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

const DOT: Record<string, string> = {
  confirmed: "bg-follow",
  not_found: "bg-danger",
  error: "bg-subtle",
  absent: "bg-transparent border border-border-strong",
};
const DOT_LABEL: Record<string, string> = {
  confirmed: "linked",
  not_found: "not in HTML",
  error: "could not check",
  absent: "not in that run",
};

function Timeline({ points }: { points: { at: string; status: string }[] }) {
  return (
    <div className="mt-4">
      <h4 className="rp-label">History in this browser ({points.length} runs)</h4>
      <ol
        className="mt-2 flex flex-wrap items-center gap-1.5"
        aria-label="Status per run, oldest first"
      >
        {points.map((point, index) => (
          <li
            key={`${point.at}-${index}`}
            title={point.at ? formatDateTime(point.at) : "earlier run"}
            className="rp-chip"
          >
            <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", DOT[point.status])} />
            <span className="tabular-nums">
              {point.at ? formatDate(point.at) : "earlier run"}
              <span className="text-muted"> · {DOT_LABEL[point.status]}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Text with the first case-insensitive occurrence of `needle` emphasised. */
function Highlighted({ text, needle }: { text: string; needle: string }) {
  const at = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (at === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded bg-accent/15 px-0.5 text-fg">
        {text.slice(at, at + needle.length)}
      </mark>
      {text.slice(at + needle.length)}
    </>
  );
}

function AnchorList({
  title,
  items,
}: {
  title: string;
  items: { anchor: string; rel: string; href: string; note?: string }[];
}) {
  return (
    <div className="mt-4">
      <h4 className="rp-label">{title}</h4>
      <ul className="mt-1.5 space-y-1.5">
        {items.slice(0, 8).map((item, index) => (
          <li key={`${item.href}-${index}`} className="rp-tile px-3 py-2 text-sm">
            <span className="text-fg">“{item.anchor || "(empty)"}”</span>
            <span className="text-subtle"> rel {item.rel || "none"}</span>
            {item.note ? (
              <span className={item.note.startsWith("in ") ? "text-subtle" : "text-nofollow"}>
                {" "}
                · {item.note}
              </span>
            ) : null}
            <span className="block truncate font-mono text-xs text-subtle" title={item.href}>
              {item.href}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CopyHash({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="group inline-flex max-w-full items-center gap-1.5 rounded font-mono text-[13px] text-fg-soft hover:text-fg"
      title={value}
    >
      <span className="sr-only">{copied ? "Copied " : "Copy "}SHA-256 hash </span>
      <span className="truncate">{value.slice(0, 24)}…</span>
      {copied ? (
        <Check className="size-3.5 text-follow" />
      ) : (
        <Copy className="size-3.5 text-subtle" />
      )}
    </button>
  );
}

/** When the contract matched a later anchor, show that one rather than the first. */
function shownAnchor(row: LedgerRow): string {
  if (row.contract.anchor === "match" && row.expected_anchor && row.matching_anchors) {
    const wanted = row.expected_anchor.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
    const hit = row.matching_anchors.find(
      (a) => a.anchor.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase() === wanted,
    );
    if (hit) return hit.anchor;
  }
  return row.anchor ?? "";
}

function prettyUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function hashId(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
