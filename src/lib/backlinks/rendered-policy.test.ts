import assert from "node:assert/strict";
import { test } from "node:test";
import { compareRenderedSnapshots, renderedPolicy, RENDER_LIMITS } from "./rendered-policy.ts";

test("renderer fails closed for public URLs and every private/subresource URL without network", () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("Network must remain unused.");
  };
  try {
    for (const url of [
      "https://public.example/",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://169.254.169.254/",
      "http://2130706433/",
      "file:///etc/passwd",
      "ws://public.example/",
      "http://private.internal/",
      "https://user:pass@public.example/",
    ]) {
      const policy = renderedPolicy(url);
      assert.equal(policy.status, "unavailable");
      assert.equal(policy.networkPolicy, "deny_all");
      assert.ok(policy.limits.cpuTimeMs > 0 && policy.limits.memoryBytes > 0);
    }
    assert.equal(
      renderedPolicy("https://public.example/").reason,
      "qualified_runtime_not_configured",
    );
    assert.equal(renderedPolicy("http://127.0.0.1/").reason, "unsafe_url");
  } finally {
    globalThis.fetch = original;
  }
});

test("offline snapshot replay distinguishes actual anchors, JS strings and data-href", () => {
  const report = compareRenderedSnapshots({
    url: "https://site.example/",
    rawHtml: '<a href="/raw">Raw</a><a data-href="/fake">Fake</a><script>const url="/js";</script>',
    renderedHtml: '<a href="/raw">Raw</a><a href="/js">JS anchor</a>',
    capturedAt: "2026-10-27T10:00:00Z",
    evidenceRef: "test:synthetic-snapshot",
  });
  assert.deepEqual(report.renderedOnly, ["https://site.example/js"]);
  assert.deepEqual(report.raw, ["https://site.example/raw"]);
  assert.equal(report.indexability, "unknown");
  assert.notEqual(report.hashes.raw, report.hashes.rendered);
  assert.throws(() =>
    compareRenderedSnapshots({
      url: "https://site.example/",
      rawHtml: "x".repeat(RENDER_LIMITS.responseBytes + 1),
      renderedHtml: "",
      capturedAt: "invalid",
      evidenceRef: "",
    }),
  );
});

test("raw and DOM links resolve against their own document URLs after same-document navigation", () => {
  const result = compareRenderedSnapshots({
    url: "https://site.example/origin/index",
    rawUrl: "https://site.example/origin/index",
    renderedUrl: "https://site.example/virtual/view?x=1#panel",
    rawHtml: '<a href="child">Child</a>',
    renderedHtml: '<a href="child">Child</a>',
    capturedAt: "2026-10-27T00:00:00Z",
    evidenceRef: "synthetic:same-document",
  });
  assert.deepEqual(result.rawOnly, ["https://site.example/origin/child"]);
  assert.deepEqual(result.renderedOnly, ["https://site.example/virtual/child"]);
  assert.equal(result.urlContext.redirectRelationship, "not_inferred");
  assert.throws(
    () =>
      compareRenderedSnapshots({
        url: result.url,
        rawUrl: "file:///private/source",
        rawHtml: "",
        renderedHtml: "",
        capturedAt: result.capturedAt,
        evidenceRef: "fixture",
      }),
    /Invalid/,
  );
});
