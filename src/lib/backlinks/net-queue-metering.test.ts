import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { EventEmitter } from "node:events";
import http, { type ClientRequest, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import {
  Budget,
  clearNetCache,
  fetchPinnedProviderJson,
  fetchText,
  setHostResolverForTests,
  SCAN_QUEUE_TRANSPORT_CONTRACT,
} from "./net.server.ts";
import { clearRobotsCache } from "./robots.server.ts";
import { withScanQueueRequests } from "./scan-queue-transport.server.ts";
import type { ScanQueue, ScanLease } from "./scan-queue.server.ts";
import type { TenantScope } from "./tenant-scope.ts";

const originalPin = process.env.RANKPROOF_PIN_DNS;
setHostResolverForTests(async () => ["93.184.216.34"]);
afterEach(() => {
  mock.restoreAll();
  clearNetCache();
  clearRobotsCache();
  if (originalPin === undefined) delete process.env.RANKPROOF_PIN_DNS;
  else process.env.RANKPROOF_PIN_DNS = originalPin;
});

function meter(limit = 10) {
  const reserved: string[] = [];
  const queue = {
    reserveRequest(_scope: unknown, _lease: unknown, url: string) {
      if (reserved.length >= limit) throw new Error("Request budget exhausted.");
      reserved.push(url);
    },
  } as unknown as ScanQueue;
  return {
    reserved,
    run: <T>(operation: () => Promise<T>) =>
      withScanQueueRequests(queue, {} as TenantScope, {} as ScanLease, operation),
  };
}

const options = { timeoutMs: 1000, maxBytes: 1000, cache: false, skipRobots: true };

test("actual fetch transport reserves each redirect hop and leaves canceled bytes unknown", async () => {
  process.env.RANKPROOF_PIN_DNS = "0";
  assert.equal(SCAN_QUEUE_TRANSPORT_CONTRACT, "queue-request.v1");
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request) =>
    String(url).endsWith("/start")
      ? new Response("unread redirect body", { status: 302, headers: { location: "/end" } })
      : new Response("zażółć", { headers: { "content-type": "text/html" } }),
  );
  const metered = meter();
  const result = await metered.run(() => fetchText("https://source.example/start", options));
  assert.equal(result.requests, 2);
  assert.equal(result.bytes, null);
  assert.equal(fetch.mock.callCount(), 2);
  assert.deepEqual(metered.reserved, [
    "https://source.example/start",
    "https://source.example/end",
  ]);
});

test("exhausting the budget at a redirect prevents the next actual HTTP request", async () => {
  process.env.RANKPROOF_PIN_DNS = "0";
  const fetch = mock.method(
    globalThis,
    "fetch",
    async () => new Response("redirect", { status: 302, headers: { location: "/end" } }),
  );
  const metered = meter(1);
  await assert.rejects(
    metered.run(() => fetchText("https://source.example/start", options)),
    /budget exhausted/,
  );
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(metered.reserved.length, 1);
});

test("robots requests count, decoded UTF-8 bytes count, and memory-cache reuse adds no request", async () => {
  process.env.RANKPROOF_PIN_DNS = "0";
  const html = "<html>zażółć</html>";
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request) =>
    String(url).endsWith("/robots.txt")
      ? new Response(null, { status: 404 })
      : new Response(html, { headers: { "content-type": "text/html" } }),
  );
  const metered = meter();
  const result = await metered.run(async () => {
    const request = { ...options, cache: true, skipRobots: false, budget: new Budget(1000) };
    await fetchText("https://source.example/article", request);
    return fetchText("https://source.example/article", request);
  });
  assert.equal(result.result.fromCache, true);
  assert.equal(result.requests, 2);
  assert.equal(result.bytes, Buffer.byteLength(html));
  assert.equal(fetch.mock.callCount(), 2);
});

test("pinned provider requests count once and record decoded body bytes", async () => {
  const text = Buffer.from('{"name":"zażółć"}');
  const request = mock.method(http, "request", ((
    _options: unknown,
    callback: (res: IncomingMessage) => void,
  ) => {
    const req = new EventEmitter() as ClientRequest;
    req.end = (() => {
      queueMicrotask(() =>
        callback(
          Object.assign(Readable.from([text]), {
            statusCode: 200,
            statusMessage: "OK",
            headers: { "content-type": "application/json" },
          }) as IncomingMessage,
        ),
      );
      return req;
    }) as ClientRequest["end"];
    return req;
  }) as typeof http.request);
  const metered = meter();
  const result = await metered.run(() =>
    fetchPinnedProviderJson("http://provider.example/search", AbortSignal.timeout(1000)),
  );
  assert.equal(result.requests, 1);
  assert.equal(result.bytes, text.byteLength);
  assert.equal(request.mock.callCount(), 1);
});

test("failed connection attempts remain charged and response bytes stay unknown", async () => {
  process.env.RANKPROOF_PIN_DNS = "0";
  const fetch = mock.method(globalThis, "fetch", async () => {
    throw new Error("connection reset");
  });
  const metered = meter();
  const result = await metered.run(async () => {
    await assert.rejects(fetchText("https://source.example/start", options), /connection reset/);
  });
  assert.equal(result.requests, 1);
  assert.equal(result.bytes, null);
  assert.equal(fetch.mock.callCount(), 1);
});
