import assert from "node:assert/strict";
import { test } from "node:test";
import { acquireHost, HostQueueTimeoutError, hostQueueStateForTests } from "./net.server.ts";
import { config } from "./config.ts";

const N = config().hostConcurrency;

async function fill(host: string) {
  const releases: (() => void)[] = [];
  for (let i = 0; i < N; i++) releases.push(await acquireHost(host));
  return releases;
}

test("a queued host waiter times out and leaves the queue", async () => {
  const host = "timeout.example";
  const releases = await fill(host);
  await assert.rejects(acquireHost(host, { timeoutMs: 20 }), HostQueueTimeoutError);
  assert.deepEqual(hostQueueStateForTests(host), { used: N, waiting: 0 });
  for (const release of releases) release();
  assert.deepEqual(hostQueueStateForTests(host), { used: 0, waiting: 0 });
});

test("an aborted waiter leaves the queue and does not consume the next slot", async () => {
  const host = "abort.example";
  const releases = await fill(host);
  const controller = new AbortController();
  const pending = acquireHost(host, { signal: controller.signal, timeoutMs: 5000 });
  assert.equal(hostQueueStateForTests(host).waiting, 1);
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(hostQueueStateForTests(host).waiting, 0);
  // A live waiter is still granted the slot handed over by release().
  const next = acquireHost(host, { timeoutMs: 1000 });
  releases[0]();
  const releaseNext = await next;
  releaseNext();
  releaseNext(); // idempotent
  for (const release of releases.slice(1)) release();
  assert.deepEqual(hostQueueStateForTests(host), { used: 0, waiting: 0 });
});
