import assert from "node:assert/strict";
import { test } from "node:test";
import { authorized, cronSecret, handleMonitorCron } from "./monitor-cron.server.ts";
import type { MonitorSql } from "./monitor.server.ts";

const SECRET = "s3cret-s3cret-s3cret";
const noDb = async (): Promise<MonitorSql> => {
  throw new Error("must not touch the database");
};
const emptyDb = async (): Promise<MonitorSql> => (async () => []) as unknown as MonitorSql;

function req(auth?: string) {
  return new Request("http://app.example/api/cron/monitors", {
    headers: auth ? { authorization: auth } : {},
  });
}

test("cron endpoint is off without a long enough secret", async () => {
  assert.equal(cronSecret({}), null);
  assert.equal(cronSecret({ CRON_SECRET: "short" }), null);
  assert.equal(cronSecret({ CRON_SECRET: SECRET }), SECRET);
  assert.equal(cronSecret({ RANKPROOF_CRON_SECRET: SECRET, CRON_SECRET: "x".repeat(20) }), SECRET);
  const res = await handleMonitorCron(req(`Bearer ${SECRET}`), { sql: noDb, env: {} });
  assert.equal(res.status, 404);
});

test("cron endpoint refuses missing or wrong tokens before touching the database", async () => {
  const env = { RANKPROOF_CRON_SECRET: SECRET };
  for (const auth of [
    undefined,
    "Basic abc",
    `Bearer ${SECRET}x`,
    "Bearer ",
    `bearer ${SECRET.slice(1)}`,
  ]) {
    const res = await handleMonitorCron(req(auth), { sql: noDb, env });
    assert.equal(res.status, 401, String(auth));
  }
  assert.equal(authorized(`bearer  ${SECRET}`, SECRET), true);
});

test("cron endpoint reports counts only", async () => {
  const res = await handleMonitorCron(req(`Bearer ${SECRET}`), {
    sql: emptyDb,
    env: { RANKPROOF_CRON_SECRET: SECRET },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, ran: 0, failed: 0, notified: 0, remaining: 0 });
  assert.equal(res.headers.get("cache-control"), "no-store");
});
