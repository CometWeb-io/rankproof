import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostLimiter } from "./host-limiter.ts";

test("host slots serialize slow responses and release exactly once", async () => {
  const acquire = createHostLimiter(1);
  const first = await acquire("one.example");
  let started = false;
  const second = acquire("one.example").then((release) => {
    started = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(started, false);
  const other = await acquire("two.example");
  other();
  first();
  const release = await second;
  assert.equal(started, true);
  release();
  release();
});

test("aborted queued work is discarded without taking a future slot", async () => {
  const acquire = createHostLimiter(1);
  const first = await acquire("example.com");
  const abort = new AbortController();
  const pending = acquire("example.com", abort.signal);
  abort.abort();
  await assert.rejects(pending, /aborted/);
  first();
  const second = await acquire("example.com");
  second();
});

test("bounded queue rejects excess work and enforces aborted signals", async () => {
  const acquire = createHostLimiter(1, 1);
  const first = await acquire("example.com");
  const pending = acquire("example.com");
  await assert.rejects(acquire("example.com"), /queue is full/);
  first();
  (await pending)();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(acquire("example.com", controller.signal), /aborted/);
});
