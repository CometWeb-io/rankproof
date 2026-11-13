import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  MAX_MONITOR_RUNS,
  MonitorInputError,
  deleteMonitor,
  monitorWebhookPayload,
  nextRunAt,
  runDueMonitors,
  listMonitors,
  monitorRuns,
  runMonitor,
  saveMonitor,
  validateMonitor,
  type MonitorSql,
} from "./monitor.server.ts";
import type { BacklinkObservation } from "./verify-api.server.ts";

async function database(): Promise<MonitorSql> {
  const pg = new PGlite({ parsers: { 20: Number } });
  for (const name of ["0005_link_monitors.sql", "0006_monitor_schedule.sql"]) {
    await pg.exec(await readFile(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
  }
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0]!;
    for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1]}`;
    return (await pg.query(text, values)).rows;
  }) as MonitorSql;
}

const TABLE =
  "source_url,target_url,expected_anchor\nhttps://a.example/post,https://brand.example/,Brand\nhttps://b.example/post,https://brand.example/";

function fakeVerify(status: (source: string) => "confirmed" | "not_found") {
  return async (items: Record<string, unknown>[]): Promise<BacklinkObservation[]> =>
    items.map(
      (item) =>
        ({
          source_url: item.source_url,
          target_url: item.target_url,
          status: status(String(item.source_url)),
          checked_at: new Date().toISOString(),
          anchor: status(String(item.source_url)) === "confirmed" ? "Brand" : null,
          rel: status(String(item.source_url)) === "confirmed" ? "" : null,
          reason: null,
          absence_scope: status(String(item.source_url)) === "confirmed" ? null : "fetched_html",
          expected_anchor: (item.expected_anchor as string) ?? null,
          http_status: 200,
        }) as unknown as BacklinkObservation,
    );
}

test("validation: names, empty tables, too many pairs", () => {
  assert.throws(() => validateMonitor({ name: " ", pairs: TABLE }), MonitorInputError);
  assert.throws(() => validateMonitor({ name: "x", pairs: "" }), /at least one row/);
  const many = Array.from(
    { length: 201 },
    (_, i) => `https://s${i}.example/,https://brand.example/`,
  ).join("\n");
  assert.throws(() => validateMonitor({ name: "x", pairs: many }), /more than a saved list holds/);
  assert.deepEqual(validateMonitor({ name: "  Q4   links ", pairs: TABLE }).name, "Q4 links");
});

test("monitors are per user: another user's id behaves like a missing one", async () => {
  const sql = await database();
  const { id } = await saveMonitor(sql, "alice", { name: "Q4", pairs: TABLE });
  assert.equal((await listMonitors(sql, "alice")).length, 1);
  assert.deepEqual(await listMonitors(sql, "bob"), []);
  await assert.rejects(
    saveMonitor(sql, "bob", { id, name: "stolen", pairs: TABLE }),
    /does not exist/,
  );
  await assert.rejects(
    runMonitor(
      sql,
      "bob",
      id,
      fakeVerify(() => "confirmed"),
    ),
    /does not exist/,
  );
  assert.equal(await deleteMonitor(sql, "bob", id), false);
  assert.deepEqual(await monitorRuns(sql, "bob", id), []);
  assert.equal((await listMonitors(sql, "alice"))[0]!.name, "Q4", "untouched");
});

test("a run is stored, compared with the previous one and pruned", async () => {
  const sql = await database();
  const { id } = await saveMonitor(sql, "alice", { name: "Q4", pairs: TABLE });
  const first = await runMonitor(
    sql,
    "alice",
    id,
    fakeVerify(() => "confirmed"),
  );
  assert.equal(first.compared_with, null);
  assert.equal(first.summary.meets, 2);
  assert.ok(first.results.every((r) => r.change === null));

  const second = await runMonitor(
    sql,
    "alice",
    id,
    fakeVerify((source) => (source.includes("b.example") ? "not_found" : "confirmed")),
  );
  assert.equal(second.compared_with, first.ran_at);
  assert.equal(second.summary.missing, 1);
  assert.equal(second.summary.changed, 1);
  const gone = second.results.find((r) => r.source_url.includes("b.example"))!;
  assert.equal(gone.change?.kind, "missing_in_representation");

  const [listed] = await listMonitors(sql, "alice");
  assert.equal(listed!.last_run?.id, second.id);
  assert.equal(listed!.pairs, 2);

  for (let i = 0; i < MAX_MONITOR_RUNS + 2; i++) {
    await runMonitor(
      sql,
      "alice",
      id,
      fakeVerify(() => "confirmed"),
    );
  }
  assert.equal((await monitorRuns(sql, "alice", id)).length, MAX_MONITOR_RUNS);

  assert.equal(await deleteMonitor(sql, "alice", id), true);
  assert.deepEqual(await monitorRuns(sql, "alice", id), [], "runs go with the list");
});

test("schedules and webhooks are validated", () => {
  assert.equal(validateMonitor({ name: "x", pairs: TABLE }).schedule, "off");
  assert.throws(
    () => validateMonitor({ name: "x", pairs: TABLE, schedule: "hourly" }),
    /Unknown schedule/,
  );
  assert.throws(
    () => validateMonitor({ name: "x", pairs: TABLE, webhook_url: "http://hooks.example/x" }),
    /https/,
  );
  assert.throws(
    () => validateMonitor({ name: "x", pairs: TABLE, webhook_url: "https://169.254.169.254/x" }),
    /refused/,
  );
  assert.equal(
    validateMonitor({
      name: "x",
      pairs: TABLE,
      webhook_url: " https://hooks.slack.com/services/T/B/x ",
    }).webhook_url,
    "https://hooks.slack.com/services/T/B/x",
  );
  const from = new Date("2026-11-01T00:00:00Z");
  assert.equal(nextRunAt("off", from), null);
  assert.equal(nextRunAt("daily", from)!.toISOString(), "2026-11-02T00:00:00.000Z");
  assert.equal(nextRunAt("weekly", from)!.toISOString(), "2026-11-08T00:00:00.000Z");
});

test("scheduled runs: only due lists, each claimed once, webhook only on change", async () => {
  const sql = await database();
  let clock = new Date("2026-11-01T08:00:00Z");
  const now = () => clock;
  const daily = await saveMonitor(
    sql,
    "alice",
    { name: "Daily", pairs: TABLE, schedule: "daily", webhook_url: "https://hooks.example/a" },
    clock,
  );
  await saveMonitor(sql, "bob", { name: "Weekly", pairs: TABLE, schedule: "weekly" }, clock);
  await saveMonitor(sql, "carol", { name: "Manual", pairs: TABLE }, clock);

  const sent: { url: string; text: string }[] = [];
  let failNext = false;
  const options = {
    now,
    verify: fakeVerify((source) =>
      failNext && source.includes("b.example") ? "not_found" : "confirmed",
    ),
    notify: async (url: string, payload: { text: string }) => {
      sent.push({ url, text: payload.text });
    },
    link: "https://rankproof.example/monitors",
  };

  assert.deepEqual((await runDueMonitors(sql, options)).ran, [], "nothing due yet");

  clock = new Date("2026-11-02T08:30:00Z");
  // Two overlapping invocations: the list runs once.
  const [a, b] = await Promise.all([runDueMonitors(sql, options), runDueMonitors(sql, options)]);
  assert.equal(a.ran.length + b.ran.length, 1);
  assert.equal((await monitorRuns(sql, "alice", daily.id)).length, 1);
  assert.equal(sent.length, 0, "first run: nothing to compare, no message");

  clock = new Date("2026-11-03T08:31:00Z");
  failNext = true;
  const third = await runDueMonitors(sql, options);
  assert.equal(third.ran.length, 1);
  assert.equal(third.ran[0]!.notified, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, "https://hooks.example/a");
  assert.match(sent[0]!.text, /Daily: 1 link change/);
  assert.match(sent[0]!.text, /rankproof\.example\/monitors/);

  const [listed] = await listMonitors(sql, "alice");
  assert.equal(listed!.schedule, "daily");
  assert.equal(listed!.webhook_host, "hooks.example");
  assert.equal(listed!.next_run_at, "2026-11-04T08:31:00.000Z");

  clock = new Date("2026-11-08T09:00:00Z");
  const weekly = await runDueMonitors(sql, { ...options, maxLists: 1 });
  assert.equal(weekly.ran.length, 1);
  assert.equal(weekly.remaining, 1, "the other due list waits for the next call");
});

test("a failing scheduled run is recorded and does not stop the others", async () => {
  const sql = await database();
  const clock = new Date("2026-11-01T00:00:00Z");
  const one = await saveMonitor(
    sql,
    "alice",
    { name: "One", pairs: TABLE, schedule: "daily" },
    clock,
  );
  await saveMonitor(sql, "alice", { name: "Two", pairs: TABLE, schedule: "daily" }, clock);
  let calls = 0;
  const report = await runDueMonitors(sql, {
    now: () => new Date("2026-11-02T01:00:00Z"),
    verify: async (items) => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return fakeVerify(() => "confirmed")(items);
    },
  });
  assert.equal(report.ran.length, 2);
  assert.match(report.ran[0]!.error ?? "", /network down/);
  assert.equal(report.ran[1]!.error, null);
  const failed = (await listMonitors(sql, "alice")).find((m) => m.id === one.id)!;
  assert.match(failed.last_error ?? "", /Scheduled run failed: network down/);
});

test("webhook payload names the list and is absent without changes", () => {
  const run = {
    id: 1,
    ran_at: "2026-11-02T00:00:00Z",
    compared_with: null,
    summary: { total: 0, meets: 0, deviates: 0, missing: 0, unverified: 0, changed: 0 },
    results: [],
  };
  assert.equal(monitorWebhookPayload("Q4", run, null), null);
  assert.equal(
    monitorWebhookPayload("Q4", { ...run, compared_with: "2026-11-01T00:00:00Z" }, null),
    null,
  );
});

test("webhook text neutralises publisher-controlled mentions and link markup", () => {
  const hostile = `<!channel> @everyone <@U123> [win](https://evil.example) <https://evil.example|bank> & co`;
  const run = {
    id: 1,
    ran_at: "2026-11-02T00:00:00Z",
    compared_with: "2026-11-01T00:00:00Z",
    summary: { total: 1, meets: 1, deviates: 0, missing: 0, unverified: 0, changed: 1 },
    results: [
      {
        source_url: "https://pub.example/a",
        target_url: "https://brand.example/",
        contract: { verdict: "meets" },
        change: {
          kind: "changed_detail",
          detail: `Still linked, but anchor "old" → "${hostile}".`,
          since: null,
        },
      },
    ],
  } as unknown as Parameters<typeof monitorWebhookPayload>[1];
  const payload = monitorWebhookPayload("Q4", run, "https://rankproof.example/monitors")!;
  // Slack: no raw angle brackets survive, so no <!channel>, <@U…> or <url|label>.
  assert.doesNotMatch(payload.text.split("\n").slice(0, -1).join("\n"), /[<>]/);
  assert.match(payload.text, /&lt;!channel&gt;/);
  assert.match(payload.text, / &amp; co/);
  assert.doesNotMatch(payload.text, /@everyone/);
  // Discord: mentions and masked links are escaped and mentions are disabled.
  assert.doesNotMatch(payload.content, /(^|[^\\])[<[]/);
  assert.doesNotMatch(payload.content, /@everyone/);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  // The operator's own link stays usable.
  assert.ok(payload.text.endsWith("\nhttps://rankproof.example/monitors"));
  assert.ok(payload.content.endsWith("\nhttps://rankproof.example/monitors"));
});
