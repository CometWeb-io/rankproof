import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundedInteger,
  createRateLimiter,
  createConcurrencyGate,
  validBearer,
  isExternallyBound,
  validateApiBody,
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

test("HTTP API validates bounded workloads before starting scans", () => {
  const scan = validateApiBody("/scan", { url: " example.com " });
  assert.equal(scan.url, "example.com");
  assert.equal(scan.skipSiteAudit, false);
  const serp = validateApiBody("/serp", {
    url: "example.com",
    keywords: ["audit"],
    depth: 20,
  });
  assert.equal(serp.depth, 20);
  assert.equal(validateApiBody("/ideas", { keywords: ["seo"], limit: 5 }).limit, 5);
  const gap = validateApiBody("/gap", {
    url: "example.com",
    competitors: ["competitor.com"],
  });
  assert.equal(gap.competitors.length, 1);
  assert.throws(() => validateApiBody("/scan", []), /object/);
  const invalidScan = { url: "example.com", skipSiteAudit: "no" };
  assert.throws(() => validateApiBody("/scan", invalidScan), /boolean/);
  const invalidSerp = { url: "example.com", keywords: ["seo"], depth: 999 };
  assert.throws(() => validateApiBody("/serp", invalidSerp), /depth/);
  assert.throws(() => validateApiBody("/ideas", { keywords: ["seo"], limit: 1_000_000 }), /limit/);
  const excessiveGap = {
    url: "example.com",
    competitors: Array(6).fill("competitor.com"),
  };
  assert.throws(() => validateApiBody("/gap", excessiveGap), /competitors/);
  const unknownEngine = { url: "example.com", keywords: ["seo"], engines: ["unknown"] };
  assert.throws(() => validateApiBody("/serp", unknownEngine), /engine/);
});
