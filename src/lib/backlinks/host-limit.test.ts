import assert from "node:assert/strict";
import { test } from "node:test";

import { Budget, clearNetCache, fetchText, setHostResolverForTests } from "./net.server.ts";
import { clearRobotsCache } from "./robots.server.ts";

setHostResolverForTests(async () => ["93.184.216.34"]);

/** Fails the test instead of hanging the runner when a promise never settles. */
function within<T>(ms: number, promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

test("redirects to another origin on a fully busy host do not deadlock on robots.txt", async () => {
  // Every slot of a.test is held by a request that redirects http → https.
  // The redirect needs https://a.test/robots.txt, which used to queue behind
  // those same requests forever.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /");
    if (url.protocol === "http:") {
      return new Response(null, {
        status: 301,
        headers: { location: `https://a.test${url.pathname}` },
      });
    }
    return new Response(`<p>${url.pathname}</p>`, { headers: { "content-type": "text/html" } });
  }) as typeof fetch;

  try {
    clearRobotsCache();
    clearNetCache();
    const budget = new Budget(20_000);
    const requests = Array.from({ length: 6 }, (_, i) =>
      fetchText(`http://a.test/p${i}`, {
        timeoutMs: 5_000,
        maxBytes: 10_000,
        budget,
        cache: false,
      }),
    );
    const results = await within(4_000, Promise.all(requests), "redirected requests");
    assert.deepEqual(
      results.map((r) => r.status),
      [200, 200, 200, 200, 200, 200],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a request waiting for a host slot gives up at its own timeout", async () => {
  // Three requests hang until aborted and hold every slot; a fourth must not
  // wait for them past its own deadline.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch;

  try {
    clearNetCache();
    const holders = Array.from({ length: 3 }, (_, i) =>
      fetchText(`https://slow.test/h${i}`, {
        timeoutMs: 1_500,
        maxBytes: 1_000,
        cache: false,
      }).catch(() => "released"),
    );
    const started = Date.now();
    await assert.rejects(
      within(
        1_000,
        fetchText("https://slow.test/late", { timeoutMs: 200, maxBytes: 1_000, cache: false }),
        "queued request",
      ),
      /free slot/,
    );
    assert.ok(Date.now() - started < 900, "the queued request left at its own timeout");
    await Promise.all(holders);

    // The slots are free again: a new request is served, not stuck behind a ghost.
    globalThis.fetch = (async () => new Response("ok")) as typeof fetch;
    const after = await within(
      1_000,
      fetchText("https://slow.test/after", { timeoutMs: 500, maxBytes: 1_000, cache: false }),
      "request after release",
    );
    assert.equal(after.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an aborted signal removes the waiter from the host queue", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch;

  try {
    clearNetCache();
    const holders = Array.from({ length: 3 }, (_, i) =>
      fetchText(`https://busy.test/h${i}`, { timeoutMs: 800, maxBytes: 1_000, cache: false }).catch(
        () => "released",
      ),
    );
    const controller = new AbortController();
    const waiting = fetchText("https://busy.test/w", {
      timeoutMs: 5_000,
      maxBytes: 1_000,
      cache: false,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(within(500, waiting, "cancelled waiter"), /^Error: Request aborted\.$/);
    await Promise.all(holders);

    globalThis.fetch = (async () => new Response("ok")) as typeof fetch;
    const results = await within(
      1_000,
      Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          fetchText(`https://busy.test/n${i}`, { timeoutMs: 500, maxBytes: 1_000, cache: false }),
        ),
      ),
      "requests after an aborted waiter",
    );
    assert.deepEqual(
      results.map((r) => r.status),
      [200, 200, 200],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
