import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearNetCache, setHostResolverForTests } from "./net.server.ts";
import { clearRobotsCache } from "./robots.server.ts";
import { runVerifyFile } from "./verify-run.server.ts";
import {
  assertWebhookUrl,
  buildHistory,
  historyCsv,
  historyText,
  loadLatestRun,
  saveRun,
  sendWebhook,
  webhookPayload,
} from "./verify-history.server.ts";

const originalFetch = globalThis.fetch;
setHostResolverForTests(async () => ["93.184.216.34"]);
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearNetCache();
  clearRobotsCache();
});

function site(html: string) {
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/robots.txt")) return new Response("", { status: 404 });
    return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  };
}

const TABLE = "https://pub.example/post,https://brand.example/";

test("history: store runs, compare with the latest, prune and summarise per pair", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rankproof-history-"));
  assert.equal(await loadLatestRun(dir), null);

  site(`<html><body><a href="https://brand.example/">Brand</a></body></html>`);
  const first = await runVerifyFile({ table: TABLE });
  await saveRun(dir, { ...first, generated_at: "2026-10-01T09:00:00.000Z" });

  site(`<html><body><p>Brand moved on.</p></body></html>`);
  const latest = await loadLatestRun(dir);
  const second = await runVerifyFile({ table: TABLE, previous: latest!.results });
  assert.equal(second.results[0]!.change?.kind, "missing_in_representation");
  await saveRun(dir, { ...second, generated_at: "2026-11-01T09:00:00.000Z" });

  const third = await runVerifyFile({
    table: TABLE,
    previous: (await loadLatestRun(dir))!.results,
  });
  await saveRun(dir, { ...third, generated_at: "2026-12-01T09:00:00.000Z" }, 2);
  assert.equal((await readdir(join(dir, "runs"))).length, 2, "pruned to --keep");

  const report = await buildHistory(dir);
  assert.equal(report.runs, 2);
  const pair = report.pairs[0]!;
  assert.equal(pair.last_status, "not_found");
  assert.equal(pair.streak, 2);
  assert.equal(pair.confirmed_share, 0);
  assert.match(historyText(report), /not in HTML|Not in HTML/);
  assert.match(historyCsv(report), /^source_url,target_url,runs/);
});

test("webhook: only on changes, Slack-style text, refuses private targets", async () => {
  site(`<html><body><a href="https://brand.example/">Brand</a></body></html>`);
  const first = await runVerifyFile({ table: TABLE });
  assert.equal(webhookPayload(first), null, "a first run is not a change");
  site(`<html><body></body></html>`);
  const second = await runVerifyFile({ table: TABLE, previous: first.results });
  const payload = webhookPayload(second)!;
  assert.equal(payload.changes.length, 1);
  assert.match(payload.text, /Gone from HTML: https:\/\/pub\.example\/post/);

  assert.throws(() => assertWebhookUrl("http://169.254.169.254/hook"));
  assert.throws(() => assertWebhookUrl("http://127.0.0.1:9000/hook"));
  const sent: unknown[] = [];
  const status = await sendWebhook("https://hooks.example/abc", payload, (async (
    _url: string,
    init: RequestInit,
  ) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response("ok", { status: 200 });
  }) as typeof fetch);
  assert.equal(status, 200);
  assert.equal((sent[0] as { kind: string }).kind, "rankproof.verify-changes");
  await assert.rejects(() =>
    sendWebhook(
      "https://hooks.example/abc",
      payload,
      (async () => new Response("no", { status: 500 })) as typeof fetch,
    ),
  );
});
