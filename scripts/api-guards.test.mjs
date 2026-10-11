import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundedInteger,
  createRateLimiter,
  createConcurrencyGate,
  validBearer,
  isExternallyBound,
} from "./api-guards.mjs";

test("invalid rate and concurrency settings fail to safe defaults", () => {
  assert.equal(boundedInteger("NaN", 2, 1, 10), 2);
  assert.equal(boundedInteger("-1", 2, 1, 10), 2);
  assert.equal(boundedInteger("3", 2, 1, 10), 3);
});

test("rate limiter counts per client without accepting extra requests", () => {
  const allow = createRateLimiter(2, 60_000);
  assert.equal(allow("a"), true);
  assert.equal(allow("a"), true);
  assert.equal(allow("a"), false);
  assert.equal(allow("b"), true);
});

test("gate frees one slot exactly once", () => {
  const acquire = createConcurrencyGate(1);
  const release = acquire();
  assert.equal(typeof release, "function");
  assert.equal(acquire(), null);
  release();
  release();
  const releaseAgain = acquire();
  assert.equal(typeof releaseAgain, "function");
  releaseAgain();
});

test("bearer authentication rejects absent and mismatched secrets", () => {
  assert.equal(validBearer(undefined, "correct"), false);
  assert.equal(validBearer("Bearer wrong", "correct"), false);
  assert.equal(validBearer("Basic correct", "correct"), false);
  assert.equal(validBearer("Bearer correct", "correct"), true);
  assert.equal(validBearer(undefined, null), true);
});

test("non-loopback bind detection requires defensive egress transport", () => {
  assert.equal(isExternallyBound("127.0.0.1"), false);
  assert.equal(isExternallyBound("::1"), false);
  assert.equal(isExternallyBound("localhost"), false);
  assert.equal(isExternallyBound("0.0.0.0"), true);
  assert.equal(isExternallyBound("192.168.1.50"), true);
});
