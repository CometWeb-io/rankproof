import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import {
  Database,
  Download,
  FileUp,
  Loader2,
  Pencil,
  Play,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CONTRACT_POLICY,
  parsePairTable,
  summarize,
  verifiedRowsCsv,
  verifiedRowsHtml,
  verifiedRowsMarkdown,
  type VerifySummary,
} from "@/lib/backlinks/observe";
import { download } from "@/lib/backlinks/export";
import { CopyMarkdown } from "@/components/verify/copy-markdown";
import {
  deleteMonitorFn,
  listMonitorsFn,
  monitorDetailFn,
  monitorStorage,
  runMonitorFn,
  saveMonitorFn,
} from "@/lib/backlinks/monitor-fn";
import type {
  MonitorListItem,
  MonitorRecord,
  MonitorRun,
  Schedule,
} from "@/lib/backlinks/monitor.server";
import {
  Ledger,
  LedgerToolbar,
  SummaryBar,
  type Filter,
  type LedgerRow,
} from "@/components/verify/verify-results";
import { formatDateTime as formatDate, visibleRows, type Sort } from "@/components/verify/format";
import type { StoredRun } from "@/components/verify/run-store";

/** sessionStorage key the verify page uses to hand a table over. */
export const MONITOR_DRAFT_KEY = "rankproof.monitor.draft";
const MAX_PAIRS = 200;

type Storage = {
  durable: boolean;
  signInRequired: boolean;
  blocked: string | null;
  scheduled: boolean;
};
type Detail = { monitor: MonitorRecord; runs: MonitorRun[] };
type Draft = {
  id: number | null;
  name: string;
  pairs: string;
  schedule: Schedule;
  webhook_url: string;
};
const EMPTY_DRAFT: Draft = { id: null, name: "", pairs: "", schedule: "off", webhook_url: "" };
const SCHEDULE_LABEL: Record<Schedule, string> = {
  off: "Only when I ask",
  daily: "Every day",
  weekly: "Every week",
};

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text === "Unauthorized"
    ? "Sign in to keep saved lists."
    : text || "Something went wrong. Try again.";
}

export function MonitorsPage() {
  const storageFn = useServerFn(monitorStorage);
  const listFn = useServerFn(listMonitorsFn);
  const saveFn = useServerFn(saveMonitorFn);
  const deleteFn = useServerFn(deleteMonitorFn);
  const detailFn = useServerFn(monitorDetailFn);
  const runFn = useServerFn(runMonitorFn);

  const [storage, setStorage] = useState<Storage | null>(null);
  const [monitors, setMonitors] = useState<MonitorListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [runIndex, setRunIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("problems");
  const csvInput = useRef<HTMLInputElement>(null);

  async function refresh() {
    try {
      const result = await listFn();
      if (result.ok) setMonitors(result.monitors);
      else setError(result.error);
    } catch (err) {
      setError(messageOf(err));
      setMonitors([]);
    }
  }

  useEffect(() => {
    void storageFn()
      .then(setStorage)
      .catch(() =>
        setStorage({ durable: false, signInRequired: false, blocked: null, scheduled: false }),
      );
    void refresh();
    try {
      const draft = sessionStorage.getItem(MONITOR_DRAFT_KEY);
      if (draft) {
        sessionStorage.removeItem(MONITOR_DRAFT_KEY);
        setEditing({ ...EMPTY_DRAFT, pairs: draft });
      }
    } catch {
      // Storage blocked: nothing to hand over.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function open(id: number) {
    setSelected(id);
    setConfirmDelete(false);
    setFilter("all");
    setDetail(null);
    try {
      const result = await detailFn({ data: { id } });
      if (result.ok) {
        setDetail({ monitor: result.monitor, runs: result.runs });
        setRunIndex(0);
      } else setError(result.error);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function runNow(id: number) {
    setRunning(true);
    setError(null);
    try {
      const result = await runFn({ data: { id } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await Promise.all([open(id), refresh()]);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setRunning(false);
    }
  }

  async function save() {
    if (!editing) return;
    setSaving(true);
    setFormError(null);
    try {
      const result = await saveFn({ data: editing });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      setEditing(null);
      await refresh();
      await open(result.id);
    } catch (err) {
      setFormError(messageOf(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    try {
      const result = await deleteFn({ data: { id } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSelected(null);
      setDetail(null);
      setConfirmDelete(false);
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    }
  }

  const run = detail?.runs[runIndex] ?? null;
  const previousRun = detail?.runs[runIndex + 1] ?? null;
  const rows = (run?.results ?? []) as LedgerRow[];
  const visible = visibleRows(rows, { filter, query, sort });
  const slug =
    (detail?.monitor.name ?? "list")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "list";
  const stamp = run ? run.ran_at.slice(0, 10) : "";
  function runDocument() {
    return JSON.stringify(
      {
        ok: true,
        kind: "rankproof.verify-run",
        schema_version: "1",
        contract_policy: CONTRACT_POLICY,
        generated_at: run?.ran_at,
        summary: summarize(rows),
        results: rows,
      },
      null,
      2,
    );
  }
  // Oldest first, as the ledger's per-link timeline expects.
  const timeline: StoredRun[] = useMemo(
    () =>
      (detail?.runs ?? [])
        .slice()
        .reverse()
        .map((r) => ({ saved_at: r.ran_at, results: r.results })),
    [detail],
  );
  const draftRows = editing ? parsePairTable(editing.pairs) : null;

  return (
    <>
      <section className="mt-10 md:mt-14">
        <h1 className="max-w-3xl font-display text-[36px] leading-[1.06] font-extrabold tracking-[-0.03em] text-fg md:text-[48px]">
          Saved lists
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted md:text-[17px]">
          Keep the links you have paid for or earned in one place and re-check them whenever you
          want. Each run is stored on the server and compared with the list&rsquo;s previous run.
        </p>
        {storage && !storage.durable && !storage.blocked ? (
          <p className="rp-card mt-4 flex max-w-3xl items-start gap-2.5 px-3.5 py-2.5 text-[13px] leading-relaxed text-fg-soft">
            <Database aria-hidden className="mt-0.5 size-4 shrink-0 text-nofollow" />
            <span>
              <span className="font-semibold text-fg">Temporary storage.</span> This server keeps
              lists in memory: they disappear when it restarts. Set{" "}
              <code className="font-mono text-fg">DATABASE_URL</code> to keep them, or use{" "}
              <code className="font-mono text-fg">rankproof verify --history</code> on your machine.
            </span>
          </p>
        ) : null}
      </section>

      {storage?.blocked ? (
        <p className="rp-shell mt-8 p-4 text-sm text-fg-soft">{storage.blocked}</p>
      ) : (
        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <aside
            aria-labelledby="lists-heading"
            className="rp-shell flex flex-col gap-3 self-start p-3"
          >
            <div className="flex items-center justify-between pl-1">
              <h2 id="lists-heading" className="text-sm font-bold text-fg">
                Your lists
                {monitors && monitors.length > 0 ? (
                  <span className="ml-2 font-normal text-muted tabular-nums">
                    {monitors.length}
                  </span>
                ) : null}
              </h2>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setEditing(EMPTY_DRAFT);
                  setFormError(null);
                }}
              >
                <Plus /> New list
              </Button>
            </div>
            {monitors === null ? (
              <p className="flex items-center gap-2 px-1 pb-1 text-sm text-muted">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Loading lists…
              </p>
            ) : monitors.length === 0 ? (
              <p className="rp-tile px-3 py-3 text-[13px] text-muted">Nothing saved yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {monitors.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => void open(item.id)}
                      aria-current={selected === item.id ? "true" : undefined}
                      className={cn(
                        "w-full rounded-[10px] border px-3.5 py-3 text-left transition-colors",
                        selected === item.id
                          ? "border-fg-soft/45 bg-surface-3"
                          : "border-line-soft bg-panel-3 hover:border-border-strong",
                      )}
                    >
                      <span className="block truncate font-semibold text-fg">{item.name}</span>
                      <span className="mt-0.5 block text-[13px] text-muted">
                        {item.pairs} {item.pairs === 1 ? "link" : "links"} ·{" "}
                        {item.last_run
                          ? `checked ${formatDate(item.last_run.ran_at)}`
                          : "never checked"}
                        {item.schedule !== "off" ? ` · ${item.schedule}` : ""}
                      </span>
                      {item.last_error ? (
                        <span className="mt-1 block text-[13px] text-danger">
                          {item.last_error}
                        </span>
                      ) : null}
                      {item.last_run ? <MiniSummary summary={item.last_run.summary} /> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <div className="min-w-0">
            {error ? (
              <p
                className="rp-card mb-4 border-danger/40 px-3 py-2.5 text-sm text-danger"
                role="alert"
              >
                {error}
              </p>
            ) : null}

            {editing ? (
              <section aria-labelledby="edit-heading" className="rp-shell p-4 md:p-5">
                <h2 id="edit-heading" className="text-base font-bold text-fg">
                  {editing.id ? "Edit list" : "New list"}
                </h2>
                <label
                  className="mt-4 block text-[13px] font-semibold text-fg-soft"
                  htmlFor="monitor-name"
                >
                  Name
                </label>
                <input
                  id="monitor-name"
                  value={editing.name}
                  maxLength={80}
                  onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                  placeholder="Q4 sponsored posts"
                  className="mt-1 h-10 w-full rp-field rounded-[10px] px-3 text-sm"
                />
                <div className="mt-4 flex items-center justify-between gap-2">
                  <label
                    className="block text-[13px] font-semibold text-fg-soft"
                    htmlFor="monitor-pairs"
                  >
                    Links, one pair per line
                  </label>
                  <Button variant="secondary" size="sm" onClick={() => csvInput.current?.click()}>
                    <FileUp /> Upload CSV
                  </Button>
                  <input
                    ref={csvInput}
                    type="file"
                    accept=".csv,.tsv,.txt,text/csv,text/plain"
                    className="sr-only"
                    tabIndex={-1}
                    aria-hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) {
                        void file
                          .text()
                          .then((text) =>
                            setEditing((current) =>
                              current ? { ...current, pairs: text } : current,
                            ),
                          );
                      }
                      event.target.value = "";
                    }}
                  />
                </div>
                <textarea
                  id="monitor-pairs"
                  value={editing.pairs}
                  onChange={(event) => setEditing({ ...editing, pairs: event.target.value })}
                  rows={8}
                  spellCheck={false}
                  placeholder={
                    "source_url,target_url,expected_anchor,expected_rel\nhttps://publisher.example/post,https://you.example/guide,Your Brand,sponsored"
                  }
                  className="mt-1 block w-full resize-y rp-field rounded-[12px] px-4 py-3 font-mono text-[13px] leading-6"
                />
                <p
                  className={cn(
                    "mt-2 text-[13px]",
                    draftRows && draftRows.rows.length > MAX_PAIRS ? "text-danger" : "text-muted",
                  )}
                  aria-live="polite"
                >
                  {draftRows?.rows.length ?? 0} pairs (up to {MAX_PAIRS} per list)
                  {draftRows && draftRows.errors.length > 0
                    ? ` · line ${draftRows.errors[0]!.line}: ${draftRows.errors[0]!.message}`
                    : ""}
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-[200px_minmax(0,1fr)]">
                  <div>
                    <label
                      className="block text-[13px] font-semibold text-fg-soft"
                      htmlFor="monitor-schedule"
                    >
                      Check automatically
                    </label>
                    <select
                      id="monitor-schedule"
                      value={editing.schedule}
                      onChange={(event) =>
                        setEditing({ ...editing, schedule: event.target.value as Schedule })
                      }
                      className="mt-1 h-10 w-full rp-field rounded-[10px] px-2 text-sm"
                    >
                      {(Object.keys(SCHEDULE_LABEL) as Schedule[]).map((value) => (
                        <option key={value} value={value}>
                          {SCHEDULE_LABEL[value]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label
                      className="block text-[13px] font-semibold text-fg-soft"
                      htmlFor="monitor-webhook"
                    >
                      Tell me about changes (optional)
                    </label>
                    <input
                      id="monitor-webhook"
                      type="url"
                      inputMode="url"
                      value={editing.webhook_url}
                      onChange={(event) =>
                        setEditing({ ...editing, webhook_url: event.target.value })
                      }
                      placeholder="https://hooks.slack.com/services/…"
                      aria-describedby="monitor-webhook-help"
                      className="mt-1 h-10 w-full rp-field rounded-[10px] px-3 text-sm"
                    />
                  </div>
                </div>
                <p
                  id="monitor-webhook-help"
                  className="mt-2 text-[13px] leading-relaxed text-muted"
                >
                  A Slack, Discord or other webhook gets a short message when a scheduled run finds
                  a change.
                  {storage && !storage.scheduled && editing.schedule !== "off"
                    ? " This server has no scheduler configured yet (RANKPROOF_CRON_SECRET), so automatic checks will wait until it does."
                    : ""}
                </p>
                {formError ? (
                  <p className="mt-2 text-sm text-danger" role="alert">
                    {formError}
                  </p>
                ) : null}
                <div className="mt-5 flex gap-2 border-t border-line-soft pt-4">
                  <Button
                    onClick={() => void save()}
                    disabled={saving}
                    className="rp-btn-primary rounded-xl border border-accent font-bold text-[#18181b]"
                  >
                    {saving ? <Loader2 className="animate-spin" /> : null}
                    {editing.id ? "Save changes" : "Save list"}
                  </Button>
                  <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>
                    Cancel
                  </Button>
                </div>
              </section>
            ) : null}

            {!editing && selected !== null && !detail ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Opening list…
              </p>
            ) : null}

            {!editing && detail ? (
              <section aria-labelledby="detail-heading">
                <div className="rp-shell flex flex-wrap items-start justify-between gap-3 p-4 md:p-5">
                  <div className="min-w-0">
                    <h2
                      id="detail-heading"
                      className="truncate font-display text-2xl font-bold text-fg"
                    >
                      {detail.monitor.name}
                    </h2>
                    <p className="mt-1 text-sm text-muted">
                      {run
                        ? `Checked ${formatDate(run.ran_at)}${previousRun ? `, compared with ${formatDate(previousRun.ran_at)}` : ", the first run of this list"}.`
                        : "Not checked yet."}
                    </p>
                    <p className="mt-0.5 text-sm text-muted">
                      {SCHEDULE_LABEL[detail.monitor.schedule]}
                      {detail.monitor.webhook_url
                        ? ` · changes go to ${hostOf(detail.monitor.webhook_url)}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      onClick={() => void runNow(detail.monitor.id)}
                      disabled={running}
                      className="rp-btn-primary border border-accent font-bold text-[#18181b]"
                    >
                      {running ? <Loader2 className="animate-spin" /> : <Play />}
                      {running ? "Checking…" : "Check now"}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        setEditing({
                          id: detail.monitor.id,
                          name: detail.monitor.name,
                          pairs: detail.monitor.pairs,
                          schedule: detail.monitor.schedule,
                          webhook_url: detail.monitor.webhook_url ?? "",
                        })
                      }
                      disabled={running}
                    >
                      <Pencil /> Edit
                    </Button>
                    {confirmDelete ? (
                      <Button
                        variant="secondary"
                        className="text-danger"
                        onClick={() => void remove(detail.monitor.id)}
                      >
                        <Trash2 /> Delete list and its runs
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        onClick={() => setConfirmDelete(true)}
                        disabled={running}
                      >
                        <Trash2 /> Delete
                      </Button>
                    )}
                  </div>
                </div>

                {detail.runs.length > 1 ? (
                  <div className="mt-4">
                    <h3 className="rp-label">Run history, newest first</h3>
                    <div role="group" aria-label="Pick a run" className="mt-2 flex flex-wrap gap-1">
                      {detail.runs.map((r, index) => (
                        <button
                          key={r.id}
                          type="button"
                          aria-pressed={index === runIndex}
                          onClick={() => {
                            setRunIndex(index);
                            setFilter("all");
                          }}
                          className={cn(
                            "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] tabular-nums transition-colors",
                            index === runIndex
                              ? "border-fg-soft/45 bg-surface-3 text-fg"
                              : "border-line bg-panel-3 text-fg-soft hover:border-border-strong",
                          )}
                        >
                          <span
                            aria-hidden
                            className={cn(
                              "rp-dot",
                              r.summary.meets === r.summary.total ? "text-follow" : "text-nofollow",
                            )}
                          />
                          {formatDate(r.ran_at)} · {r.summary.meets}/{r.summary.total}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {run ? (
                  <div className="mt-5">
                    <div className="mb-3 flex flex-wrap gap-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          download(`${slug}-${stamp}.csv`, verifiedRowsCsv(rows), "text/csv")
                        }
                      >
                        <Download /> CSV
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          download(`${slug}-${stamp}.json`, runDocument(), "application/json")
                        }
                      >
                        <Download /> JSON
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          download(
                            `${slug}-${stamp}.html`,
                            verifiedRowsHtml(rows, {
                              title: `${detail.monitor.name} — link check`,
                            }),
                            "text/html",
                          )
                        }
                      >
                        <Download /> Report
                      </Button>
                      <CopyMarkdown text={() => verifiedRowsMarkdown(rows)} />
                    </div>
                    <SummaryBar
                      summary={summarize(rows)}
                      filter={filter}
                      onFilter={setFilter}
                      showChanges={Boolean(previousRun)}
                    />
                    <LedgerToolbar
                      query={query}
                      onQuery={setQuery}
                      sort={sort}
                      onSort={setSort}
                      shown={visible.length}
                      total={rows.length}
                      inputLabel="As saved"
                    />
                    <div className="mt-3">
                      <Ledger rows={visible} runs={timeline.slice(0, timeline.length - runIndex)} />
                    </div>
                  </div>
                ) : (
                  <p className="rp-shell mt-4 p-4 text-sm text-fg-soft">
                    {parsePairTable(detail.monitor.pairs).rows.length} links saved. Choose{" "}
                    <span className="text-fg-soft">Check now</span> to read every source page; later
                    runs will be compared with this one.
                  </p>
                )}
              </section>
            ) : null}

            {!editing && selected === null && monitors && monitors.length > 0 ? (
              <p className="rp-shell flex min-h-40 items-center justify-center p-6 text-center text-sm text-muted">
                Pick a list on the left to see its runs and what changed.
              </p>
            ) : null}

            {!editing && selected === null && monitors && monitors.length === 0 ? (
              <section aria-labelledby="empty-heading" className="rp-shell p-5 md:p-8">
                <h2 id="empty-heading" className="text-xl font-bold text-fg">
                  No saved lists yet
                </h2>
                <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted">
                  A list keeps up to {MAX_PAIRS} links on the server, re-checks them when you ask or
                  on a schedule, and compares each run with the one before.
                </p>
                <div className="mt-5 grid gap-3 md:grid-cols-2">
                  <div className="rp-card flex flex-col p-4">
                    <p className="text-[13px] font-semibold text-muted">Start from scratch</p>
                    <p className="mt-1 text-sm text-fg-soft">
                      Paste pairs or upload a CSV, name the list and choose how often to check it.
                    </p>
                    <Button
                      className="rp-btn-primary mt-4 self-start rounded-xl border border-accent font-bold text-[#18181b]"
                      onClick={() => {
                        setEditing(EMPTY_DRAFT);
                        setFormError(null);
                      }}
                    >
                      <Plus /> Create a list
                    </Button>
                  </div>
                  <div className="rp-card flex flex-col p-4">
                    <p className="text-[13px] font-semibold text-muted">
                      From a check you just ran
                    </p>
                    <p className="mt-1 text-sm text-fg-soft">
                      Verify links first, then choose{" "}
                      <span className="font-semibold text-fg">Save as a list</span> above the
                      results.
                    </p>
                    <Button asChild variant="secondary" className="mt-4 self-start rounded-xl">
                      <Link to="/">
                        <ShieldCheck /> Go to Verify links
                      </Link>
                    </Button>
                  </div>
                </div>
              </section>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

function MiniSummary({ summary }: { summary: VerifySummary }) {
  const problems = summary.deviates + summary.missing;
  return (
    <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[13px] tabular-nums">
      <span className="inline-flex items-center gap-1.5 text-follow">
        <span aria-hidden className="rp-dot" />
        <span className="text-fg-soft">{summary.meets} meet</span>
      </span>
      {problems > 0 ? (
        <span className="inline-flex items-center gap-1.5 text-nofollow">
          <span aria-hidden className="rp-dot" />
          <span className="text-fg-soft">{problems} need attention</span>
        </span>
      ) : null}
      {summary.unverified > 0 ? (
        <span className="inline-flex items-center gap-1.5 text-muted">
          <span aria-hidden className="rp-dot" />
          <span className="text-fg-soft">{summary.unverified} unreadable</span>
        </span>
      ) : null}
      {summary.changed > 0 ? (
        <span className="inline-flex items-center gap-1.5 text-changed">
          <span aria-hidden className="rp-dot" />
          <span className="text-fg-soft">{summary.changed} changed</span>
        </span>
      ) : null}
    </span>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
