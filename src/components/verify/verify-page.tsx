import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useNavigate } from "@tanstack/react-router";
import {
  Check,
  CircleHelp,
  Download,
  FileUp,
  History,
  ListPlus,
  Loader2,
  MonitorCheck,
  ShieldCheck,
  Sparkle,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CONTRACT_POLICY,
  compareObservations,
  evaluateContract,
  indexByPair,
  pairKey,
  parsePairTable,
  previousObservations,
  summarize,
  verifiedRowsCsv,
  verifiedRowsHtml,
  verifiedRowsMarkdown,
  type ObservationLike,
} from "@/lib/backlinks/observe";
import { download } from "@/lib/backlinks/export";
import { verifyCapabilities, verifyExample, verifyLinks } from "@/lib/backlinks/verify-fn";
import type { BacklinkObservation } from "@/lib/backlinks/verify-api.server";
import { Ledger, LedgerToolbar, SummaryBar, type Filter, type LedgerRow } from "./verify-results";
import { CopyMarkdown } from "./copy-markdown";
import { StatusDot, VerdictChip } from "./status";
import { formatDate, visibleRows, type Sort } from "./format";
import { appendRun, clearRuns, loadRuns, MAX_RUNS, type StoredRun } from "./run-store";
import { MONITOR_DRAFT_KEY } from "@/components/monitors/monitors-page";

const BATCH = 50;
const MAX_PAIRS = 500;

type Baseline = { label: string; at: string | null; results: ObservationLike[] };

const PLACEHOLDER = `source_url,target_url,expected_anchor,expected_rel,expected_placement
https://publisher.example/post,https://you.example/guide,Your Brand,sponsored,content
https://blog.example/review,https://you.example/`;

function baselineFrom(runs: StoredRun[]): Baseline | null {
  const last = runs.at(-1);
  return last
    ? { label: "your last run in this browser", at: last.saved_at || null, results: last.results }
    : null;
}

export function VerifyPage() {
  const navigate = useNavigate();
  const verify = useServerFn(verifyLinks);
  const example = useServerFn(verifyExample);
  const capabilities = useServerFn(verifyCapabilities);
  const [renderInfo, setRenderInfo] = useState<{ render: boolean; engine: string | null } | null>(
    null,
  );
  const [renderMode, setRenderMode] = useState<"off" | "fallback" | "always">("off");
  const [table, setTable] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [isExample, setIsExample] = useState(false);
  const [runs, setRuns] = useState<StoredRun[]>([]);
  const [timelineRuns, setTimelineRuns] = useState<StoredRun[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("input");
  const [comparedWith, setComparedWith] = useState<Baseline | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [comparedWithFile, setComparedWithFile] = useState<Baseline | null>(null);
  const csvInput = useRef<HTMLInputElement>(null);
  const runInput = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLHeadingElement>(null);
  const [help, setHelp] = useState<"format" | "render" | null>(null);

  useEffect(() => setRuns(loadRuns()), []);
  useEffect(() => {
    capabilities()
      .then((info) => {
        setRenderInfo(info);
        if (info.render) setRenderMode("fallback");
      })
      .catch(() => setRenderInfo({ render: false, engine: null }));
  }, [capabilities]);
  const baseline = baselineFrom(runs);

  const parsed = useMemo(() => parsePairTable(table), [table]);
  const tooMany = parsed.rows.length > MAX_PAIRS;

  function finish(results: BacklinkObservation[], previous: Baseline | null) {
    const before = previous ? indexByPair(previous.results) : null;
    const next: LedgerRow[] = results.map((result) => ({
      ...result,
      contract: result.contract ?? evaluateContract(result, result),
      change: before
        ? compareObservations(before.get(pairKey(result.source_url, result.target_url)), result)
        : null,
    }));
    setRows(next);
    setComparedWith(previous);
    setFilter("all");
    // Results render below the input: bring their heading into view and move
    // focus there, so keyboard and screen-reader users land on the outcome.
    requestAnimationFrame(() => {
      const heading = resultsRef.current;
      if (!heading) return;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      heading.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      heading.focus({ preventScroll: true });
    });
  }

  async function run() {
    setError(null);
    if (parsed.rows.length === 0) {
      setError(
        parsed.errors[0]
          ? `Line ${parsed.errors[0].line}: ${parsed.errors[0].message}`
          : "Paste at least one row: source URL, target URL.",
      );
      return;
    }
    if (tooMany) {
      setError(
        `${parsed.rows.length} pairs is more than the web app checks at once (${MAX_PAIRS}). Use the CLI for larger lists.`,
      );
      return;
    }
    setRunning(true);
    setIsExample(false);
    const results: BacklinkObservation[] = [];
    setProgress({ done: 0, total: parsed.rows.length });
    try {
      for (let i = 0; i < parsed.rows.length; i += BATCH) {
        const batch = parsed.rows.slice(i, i + BATCH).map((row) => ({
          source_url: row.source_url,
          target_url: row.target_url,
          expected_anchor: row.expected_anchor,
          expected_rel: row.expected_rel,
          expected_placement: row.expected_placement,
        }));
        const response = await verify({
          data: { items: batch, ...(renderMode !== "off" ? { render: renderMode } : {}) },
        });
        if (!response.ok) throw new Error(response.error);
        results.push(...response.results);
        setProgress({ done: results.length, total: parsed.rows.length });
      }
      const previous = comparedWithFile ?? baseline;
      finish(results, previous);
      const stored = appendRun(results);
      setRuns(stored);
      setTimelineRuns(stored);
      setComparedWithFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed. Try again.");
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  async function loadExample() {
    setError(null);
    setRunning(true);
    try {
      const data = await example();
      setTable(data.table);
      setIsExample(true);
      setTimelineRuns([
        { saved_at: data.previous[0]?.checked_at ?? "", results: data.previous },
        { saved_at: data.results[0]?.checked_at ?? "", results: data.results },
      ]);
      finish(data.results, {
        label: "the example's October run",
        at: data.previous[0]?.checked_at ?? null,
        results: data.previous,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the example.");
    } finally {
      setRunning(false);
    }
  }

  async function readCsv(file: File) {
    setTable(await file.text());
    setRows(null);
    setIsExample(false);
  }

  async function readRun(file: File) {
    try {
      const json = JSON.parse(await file.text());
      const results = previousObservations(json);
      setComparedWithFile({
        label: file.name,
        at: (json as { generated_at?: string }).generated_at ?? null,
        results,
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That file is not a RankProof run.");
    }
  }

  const summary = rows ? summarize(rows) : null;
  const visible = visibleRows(rows ?? [], { filter, query, sort });
  const stamp = new Date().toISOString().slice(0, 10);

  function runDocument() {
    return JSON.stringify(
      {
        ok: true,
        kind: "rankproof.verify-run",
        schema_version: "1",
        contract_policy: CONTRACT_POLICY,
        generated_at: new Date().toISOString(),
        summary,
        results: rows,
      },
      null,
      2,
    );
  }

  const compareTarget = comparedWithFile ?? baseline;

  return (
    <>
      <section className="mt-10 md:mt-14">
        <h1 className="max-w-3xl font-display text-[36px] leading-[1.06] font-extrabold tracking-[-0.03em] text-fg md:text-[48px]">
          Is the link still there, exactly as agreed?
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted md:text-[17px]">
          Paste the backlinks you already know about. RankProof opens each source page, checks the
          exact target URL, anchor text and rel you agreed on, and keeps a receipt of what it read.
        </p>
      </section>

      <div className="mt-8 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section aria-labelledby="pairs-heading" className="rp-shell min-w-0 p-4 md:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="pairs-heading" className="text-base font-bold text-fg">
                Links to check
              </h2>
              <p className="mt-0.5 text-[13px] text-muted">
                One pair per line: source URL, target URL, then what was agreed.
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => csvInput.current?.click()}
                disabled={running}
              >
                <FileUp /> Upload CSV
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void loadExample()}
                disabled={running}
              >
                <Sparkle /> Show an example
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={help === "format"}
                aria-controls="pairs-help"
                onClick={() => setHelp(help === "format" ? null : "format")}
              >
                <CircleHelp /> Format
              </Button>
            </div>
            <input
              ref={csvInput}
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readCsv(file);
                event.target.value = "";
              }}
            />
          </div>
          {help === "format" ? (
            <div id="pairs-help" className="rp-card mt-3 p-3.5 text-[13px] leading-relaxed">
              <p className="text-fg-soft">
                Columns in this order; only the first two are required. Commas, semicolons or tabs;
                a header row is optional.
              </p>
              <ol className="mt-2.5 flex flex-wrap gap-1.5">
                {[
                  ["source_url", "page that should link"],
                  ["target_url", "exact URL it links to"],
                  ["expected_anchor", "agreed anchor text"],
                  ["expected_rel", "follow, nofollow, sponsored, ugc"],
                  ["expected_placement", "content, sidebar, footer…"],
                ].map(([name, text], index) => (
                  <li key={name} className="rp-tile flex items-center gap-2 px-2.5 py-1.5">
                    <span className="font-mono text-xs text-subtle">{index + 1}</span>
                    <span className="font-mono text-[13px] text-fg">{name}</span>
                    <span className="text-xs text-muted">{text}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          <label htmlFor="pairs" className="sr-only">
            Links to check, one pair per line
          </label>
          <textarea
            id="pairs"
            value={table}
            onChange={(event) => {
              setTable(event.target.value);
              setIsExample(false);
            }}
            spellCheck={false}
            placeholder={PLACEHOLDER}
            rows={6}
            disabled={running}
            className="rp-field mt-3 block min-h-36 w-full resize-y rounded-[12px] px-4 py-3 font-mono text-[13px] leading-6"
          />

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div aria-live="polite" className="flex max-w-full flex-wrap gap-2">
              {table.trim() ? (
                <span
                  className={cn("rp-chip", parsed.rows.length > 0 ? "text-follow" : "text-muted")}
                >
                  <StatusDot />
                  <span className="text-fg">
                    {parsed.rows.length} {parsed.rows.length === 1 ? "pair" : "pairs"} ready
                    {parsed.duplicates > 0 ? `, ${parsed.duplicates} duplicate ignored` : null}
                  </span>
                </span>
              ) : (
                <span className="rp-chip text-subtle">
                  <StatusDot />
                  <span className="text-fg-soft">Nothing pasted yet</span>
                </span>
              )}
              {table.trim() && parsed.errors.length > 0 ? (
                <span className="rp-chip max-w-full border-nofollow/35 text-nofollow">
                  <StatusDot />
                  <span className="min-w-0 truncate">
                    {parsed.errors.length} {parsed.errors.length === 1 ? "line" : "lines"} skipped
                    (line {parsed.errors[0]!.line}: {parsed.errors[0]!.message})
                  </span>
                </span>
              ) : null}
            </div>
            <CompareChip
              target={compareTarget}
              fromFile={Boolean(comparedWithFile)}
              onPick={() => runInput.current?.click()}
              onClear={() => setComparedWithFile(null)}
            />
            <RenderChip
              info={renderInfo}
              mode={renderMode}
              onMode={setRenderMode}
              helpOpen={help === "render"}
              onHelp={() => setHelp(help === "render" ? null : "render")}
            />
            <input
              ref={runInput}
              type="file"
              accept=".json,application/json"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readRun(file);
                event.target.value = "";
              }}
            />
          </div>
          {help === "render" ? (
            <p
              id="render-help"
              className="rp-card mt-2 p-3 text-[13px] leading-relaxed text-fg-soft"
            >
              Pages are read as delivered HTML. Start the app with{" "}
              <code className="font-mono text-fg">RANKPROOF_RENDER=1</code> to also open them in a
              browser, which finds links added by JavaScript and links hidden with CSS.
            </p>
          ) : null}

          <div className="mt-4 flex flex-col-reverse gap-3 border-t border-line-soft pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[13px] text-muted">
              Up to {MAX_PAIRS} pairs here; larger lists with{" "}
              <code className="font-mono text-fg-soft">rankproof verify</code>.
            </p>
            <Button
              onClick={() => void run()}
              disabled={running}
              size="lg"
              className="rp-btn-primary h-12 rounded-xl border border-accent px-6 text-[15px] font-bold text-[#18181b] sm:min-w-52"
            >
              {running ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              {running && progress
                ? `Checked ${progress.done} of ${progress.total}`
                : running
                  ? "Working…"
                  : parsed.rows.length > 1
                    ? `Verify ${parsed.rows.length} links`
                    : "Verify link"}
            </Button>
          </div>
          {error ? (
            <p
              className="rp-card mt-3 border-danger/40 px-3 py-2.5 text-sm text-danger"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </section>

        <HowItWorks />
      </div>

      {rows && summary ? (
        <section aria-labelledby="results-heading" className="mt-12">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h2
                id="results-heading"
                ref={resultsRef}
                tabIndex={-1}
                className="scroll-mt-24 font-display text-2xl font-bold text-fg outline-none md:text-[28px]"
              >
                {summary.total} {summary.total === 1 ? "link" : "links"} checked
              </h2>
              <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted">
                {isExample
                  ? "Example data: bundled HTML read by the real extractor, no network requests."
                  : "Fetched just now from each source page."}
                {comparedWith
                  ? ` Compared with ${comparedWith.label}${comparedWith.at ? ` (${formatDate(comparedWith.at)})` : ""}.`
                  : " Your next run here will be compared with this one."}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  download(`rankproof-links-${stamp}.csv`, verifiedRowsCsv(rows), "text/csv")
                }
              >
                <Download /> CSV
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  download(`rankproof-run-${stamp}.json`, runDocument(), "application/json")
                }
              >
                <Download /> JSON
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  download(
                    `rankproof-report-${stamp}.html`,
                    verifiedRowsHtml(rows, { title: "Link verification report" }),
                    "text/html",
                  )
                }
              >
                <Download /> Report
              </Button>
              <CopyMarkdown text={() => verifiedRowsMarkdown(rows)} />
              {!isExample && parsed.rows.length > 0 && parsed.rows.length <= 200 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  title="Keep these links on the server and re-check them later"
                  onClick={() => {
                    try {
                      sessionStorage.setItem(MONITOR_DRAFT_KEY, table);
                    } catch {
                      // Storage blocked: the list page opens with an empty form.
                    }
                    void navigate({ to: "/monitors" });
                  }}
                >
                  <ListPlus /> Save as a list
                </Button>
              ) : null}
            </div>
          </div>
          <SummaryBar
            summary={summary}
            filter={filter}
            onFilter={setFilter}
            showChanges={Boolean(comparedWith)}
          />
          <LedgerToolbar
            query={query}
            onQuery={setQuery}
            sort={sort}
            onSort={setSort}
            shown={visible.length}
            total={rows.length}
          />
          <div className="mt-3">
            <Ledger rows={visible} runs={timelineRuns} />
          </div>
          {!isExample && runs.length > 0 ? (
            <p className="mt-4 flex flex-wrap items-center gap-2 text-[13px] text-muted">
              {runs.length} of the last {MAX_RUNS} runs are kept in this browser for comparison.
              <button
                type="button"
                onClick={() => {
                  clearRuns();
                  setRuns([]);
                  setTimelineRuns([]);
                }}
                className="text-fg-soft underline underline-offset-2 hover:text-fg"
              >
                Clear browser history
              </button>
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

function CompareChip({
  target,
  fromFile,
  onPick,
  onClear,
}: {
  target: Baseline | null;
  fromFile: boolean;
  onPick: () => void;
  onClear: () => void;
}) {
  return (
    <span className={cn("rp-chip max-w-full flex-wrap", target ? "text-changed" : "text-subtle")}>
      <History className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 text-fg-soft">
        {target ? (
          <>
            Changes against {target.label}
            {target.at ? ` from ${formatDate(target.at)}` : ""}
          </>
        ) : (
          "No earlier run to compare with yet"
        )}
      </span>
      <button
        type="button"
        onClick={onPick}
        className="font-semibold text-fg underline-offset-2 hover:underline"
      >
        {target ? "Use a saved JSON run" : "Compare with a saved JSON run"}
      </button>
      {fromFile ? (
        <button
          type="button"
          onClick={onClear}
          className="-mr-1 inline-flex size-6 items-center justify-center rounded-full text-muted hover:bg-surface-3 hover:text-fg"
          aria-label="Stop comparing with the file"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </span>
  );
}

function RenderChip({
  info,
  mode,
  onMode,
  helpOpen,
  onHelp,
}: {
  info: { render: boolean; engine: string | null } | null;
  mode: "off" | "fallback" | "always";
  onMode: (mode: "off" | "fallback" | "always") => void;
  helpOpen: boolean;
  onHelp: () => void;
}) {
  if (!info) return null;
  if (!info.render) {
    return (
      <span className="rp-chip text-subtle">
        <MonitorCheck className="size-3.5 shrink-0" aria-hidden />
        <span className="text-fg-soft">Browser check is off</span>
        <button
          type="button"
          onClick={onHelp}
          aria-expanded={helpOpen}
          aria-controls="render-help"
          className="font-semibold text-fg underline-offset-2 hover:underline"
        >
          How to turn on
        </button>
      </span>
    );
  }
  return (
    <label className="rp-chip text-follow">
      <MonitorCheck className="size-3.5 shrink-0" aria-hidden />
      <span className="text-fg-soft">Browser check ({info.engine})</span>
      <select
        value={mode}
        onChange={(event) => onMode(event.target.value as "off" | "fallback" | "always")}
        className="h-6 rounded-full border border-line bg-panel-2 px-2 text-[13px] text-fg focus-visible:border-accent/60 focus-visible:outline-none"
      >
        <option value="fallback">when the HTML has no link</option>
        <option value="always">every page (also finds hidden links)</option>
        <option value="off">off</option>
      </select>
    </label>
  );
}

function HowItWorks() {
  const outcomes = [
    ["meets", "The exact target URL is linked, with the anchor and rel you agreed."],
    ["deviates", "Linked, but the anchor or rel differs, e.g. follow turned sponsored."],
    ["missing", "No anchor to that URL in the fetched HTML."],
    ["unverified", "Timed out, blocked or not HTML. Never counted as a lost link."],
  ] as const;
  const receipt = [
    "HTTP status and final URL",
    "The matched href and its anchor",
    "Text around the link",
    "SHA-256 of the HTML that was read",
  ];
  return (
    <aside aria-labelledby="outcomes-heading" className="rp-shell p-4 md:p-5">
      <h2 id="outcomes-heading" className="text-base font-bold text-fg">
        Every link ends in one of four results
      </h2>
      <ul className="rp-card mt-3 divide-y divide-line-soft">
        {outcomes.map(([verdict, text]) => (
          <li key={verdict} className="px-3 py-2.5">
            <VerdictChip verdict={verdict} />
            <p className="mt-1.5 text-[13px] leading-snug text-fg-soft">{text}</p>
          </li>
        ))}
      </ul>
      <h3 className="mt-5 text-sm font-semibold text-fg">Each result comes with a receipt</h3>
      <ul className="mt-2 flex flex-col gap-1.5">
        {receipt.map((item) => (
          <li key={item} className="flex items-center gap-2 text-[13px] text-fg-soft">
            <Check aria-hidden className="size-3.5 shrink-0 text-follow" />
            {item}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[13px] leading-relaxed text-muted">
        Run the same list again and RankProof shows what changed since the last run in this browser.
      </p>
    </aside>
  );
}
