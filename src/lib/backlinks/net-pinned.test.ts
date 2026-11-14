import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import http, { type ClientRequest, type IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { clearNetCache, fetchText, setHostResolverForTests } from "./net.server.ts";
import { clearRobotsCache } from "./robots.server.ts";
import { verifyBacklinks } from "./verify-api.server.ts";

const originalPin = process.env.RANKPROOF_PIN_DNS;
setHostResolverForTests(async () => ["93.184.216.34"]);
afterEach(() => {
  mock.restoreAll();
  clearNetCache();
  clearRobotsCache();
  if (originalPin === undefined) delete process.env.RANKPROOF_PIN_DNS;
  else process.env.RANKPROOF_PIN_DNS = originalPin;
});
function pinnedFixture(response: (path: string) => { status: number; text?: string }) {
  process.env.RANKPROOF_PIN_DNS = "1";
  mock.method(http, "request", ((
    _options: { path: string },
    callback: (res: IncomingMessage) => void,
  ) => {
    const req = new EventEmitter() as ClientRequest;
    req.end = (() => {
      queueMicrotask(() => {
        const fixture = response(_options.path);
        const res = Object.assign(Readable.from(fixture.text ? [Buffer.from(fixture.text)] : []), {
          statusCode: fixture.status,
          statusMessage: "Fixture",
          headers: { "content-type": "text/html" },
        }) as IncomingMessage;
        callback(res);
      });
      return req;
    }) as ClientRequest["end"];
    return req;
  }) as typeof http.request);
}

for (const status of [204, 205, 304]) {
  test(
    `pinned HTTP ${status} uses a null body without uncaught callback errors`,
    { timeout: 1500 },
    async () => {
      pinnedFixture(() => ({ status }));
      const result = await fetchText("http://source.example/page", {
        timeoutMs: 1000,
        maxBytes: 1000,
        cache: false,
        skipRobots: true,
      });
      assert.equal(result.status, status);
      assert.equal(result.text, "");
    },
  );
}

test(
  "pinned malformed response rejects the fetch rather than escaping the end callback",
  { timeout: 1500 },
  async () => {
    pinnedFixture(() => ({ status: 0 }));
    await assert.rejects(() =>
      fetchText("http://source.example/page", {
        timeoutMs: 1000,
        maxBytes: 1000,
        cache: false,
        skipRobots: true,
      }),
    );
  },
);

test("pinned verification survives robots204 then confirms the actual source HTML", async () => {
  pinnedFixture((path) =>
    path === "/robots.txt"
      ? { status: 204 }
      : { status: 200, text: "<html><a href='https://target.example/offer'>Offer</a></html>" },
  );
  const result = await verifyBacklinks({
    items: [
      { source_url: "http://source.example/page", target_url: "https://target.example/offer" },
    ],
  });
  assert.equal(result.results[0]!.status, "confirmed");
});

test("pinnedFetch connects to the validated IP, forwards the body, follows no redirect", async () => {
  const { pinnedFetch } = await import("./net.server.ts");
  let captured: { hostname: string; headers: Record<string, string>; body?: Buffer } | null = null;
  mock.method(http, "request", ((
    options: { hostname: string; headers: Record<string, string> },
    callback: (res: IncomingMessage) => void,
  ) => {
    const req = new EventEmitter() as ClientRequest;
    req.end = ((body?: Buffer) => {
      captured = { hostname: options.hostname, headers: options.headers, body };
      queueMicrotask(() => {
        const res = Object.assign(Readable.from([]), {
          statusCode: 302,
          statusMessage: "Found",
          headers: { location: "http://10.0.0.1/admin", "content-length": "0" },
        }) as IncomingMessage;
        callback(res);
      });
      return req;
    }) as ClientRequest["end"];
    return req;
  }) as typeof http.request);
  const answer = await pinnedFetch("http://source.example/form", {
    method: "POST",
    headers: { "content-type": "text/plain", host: "evil.example", "accept-encoding": "br" },
    body: Buffer.from("hello"),
  });
  assert.equal(answer.status, 302);
  assert.equal(answer.headers.location, "http://10.0.0.1/admin", "redirect returned, not followed");
  assert.equal(answer.headers["content-length"], undefined);
  assert.equal(captured!.hostname, "93.184.216.34");
  assert.equal(captured!.headers.Host, "source.example");
  assert.equal(captured!.headers.host, undefined, "browser Host header dropped");
  assert.equal(captured!.headers["Accept-Encoding"], "identity");
  assert.equal(captured!.body?.toString(), "hello");
});

test("pinnedFetch refuses private targets before connecting", async () => {
  const { pinnedFetch, BlockedUrlError } = await import("./net.server.ts");
  const request = mock.method(http, "request", (() => {
    throw new Error("must not connect");
  }) as unknown as typeof http.request);
  await assert.rejects(pinnedFetch("http://169.254.169.254/latest/meta-data"), BlockedUrlError);
  setHostResolverForTests(async () => ["10.1.2.3"]);
  try {
    await assert.rejects(pinnedFetch("http://rebind.example/"), BlockedUrlError);
  } finally {
    setHostResolverForTests(async () => ["93.184.216.34"]);
  }
  assert.equal(request.mock.callCount(), 0);
});
