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
