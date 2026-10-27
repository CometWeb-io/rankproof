import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { verifyBacklinks } from "./verify-api.server.ts";
import { captureBacklinks } from "./evidence-capture.server.ts";
import { verifyPages } from "./verify.server.ts";
import { Budget } from "./net.server.ts";
import type { Coverage } from "./measurement.server.ts";
import { fetchGoogleOrganicViaProvider } from "./serp-providers.ts";
import { RankProofClient, RankProofApiError } from "./agent-api-client.ts";
import { clearNetCache, fetchText, setHostResolverForTests } from "./net.server.ts";
import { clearRobotsCache } from "./robots.server.ts";
import { withScanQueueRequests } from "./scan-queue-transport.server.ts";
import type { ScanQueue, ScanLease } from "./scan-queue.server.ts";
import type { TenantScope } from "./tenant-scope.ts";

const originalFetch = globalThis.fetch;
const originalPin = process.env.RANKPROOF_PIN_DNS;
const pair = {
  source_url: "https://source.example/post",
  target_url: "https://target.example/caf%C3%A9",
};
const html = '<html><body><a href="https://target.example/café">Offer</a></body></html>';
const asciiHtml = html.replace("café", "caf%C3%A9");
beforeEach(() => {
  process.env.RANKPROOF_PIN_DNS = "0";
  setHostResolverForTests(async (host) => {
    assert.equal(host, "source.example");
    return ["93.184.216.34"];
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setHostResolverForTests(null);
  clearNetCache();
  clearRobotsCache();
  if (originalPin === undefined) delete process.env.RANKPROOF_PIN_DNS;
  else process.env.RANKPROOF_PIN_DNS = originalPin;
});
function respond(body: BodyInit, type = "text/html", status = 200) {
  globalThis.fetch = async (input) =>
    String(input).endsWith("/robots.txt")
      ? new Response("", { status: 404 })
      : new Response(body, { status, headers: { "content-type": type } });
}
const observe = async () => (await verifyBacklinks({ items: [pair] })).results[0]!;

test("discovery cannot promote unsupported HTML text into verified links", async () => {
  respond(Buffer.from(html), "text/html; charset=windows-1252");
  const coverage: Coverage = {};
  const result = await verifyPages([{ url: pair.source_url, title: "Source", via: "bing" }], {
    host: "target.example",
    brandTokens: [],
    limit: 1,
    budget: new Budget(10000),
    coverage,
  });
  assert.equal(result.backlinks.length, 0);
  assert.equal(coverage.bing?.validHtml, 0);
  assert.equal(coverage.bing?.errors, 1);
});

test("provider and typed client reject lossy JSON text rather than accepting replacement data", async () => {
  const bytes = Buffer.from(
    '{"results":[{"type":"organic","url":"https://result.example/caf\xff","rank":1}]}',
    "latin1",
  );
  await assert.rejects(
    fetchGoogleOrganicViaProvider("q", {
      baseUrl: "https://provider.example",
      resolve: async () => ["93.184.216.34"],
      fetchImpl: async () =>
        new Response(bytes, { headers: { "content-type": "application/json" } }),
    }),
  );
  globalThis.fetch = async () =>
    new Response(
      Buffer.from(
        '{"ok":false,"schema_version":"1","error":{"code":"invalid_input","message":"bad\xff"}}',
        "latin1",
      ),
      { headers: { "content-type": "application/json" } },
    );
  const client = new RankProofClient("http://127.0.0.1:1");
  await assert.rejects(
    client.capabilities(),
    (error) => error instanceof RankProofApiError && error.code === "invalid_response",
  );
});

test("quoted parameter text cannot mask an unsupported real charset declaration", async () => {
  const injected = 'text/html; note=";charset=utf-8 "; charset=windows-1252';
  for (const [body, type] of [
    [html, injected],
    [`<meta http-equiv="content-type" content='${injected}'>${html}`, "text/html"],
    [
      `<?xml version="1.0" note='encoding="utf8"' encoding="ISO-8859-1"?>${html}`,
      "application/xhtml+xml",
    ],
  ]) {
    clearNetCache();
    clearRobotsCache();
    respond(Buffer.from(body!), type!);
    const result = await observe();
    assert.equal(result.status, "error");
    assert.equal(result.absence_scope, null);
  }
  respond(Buffer.from(html), 'text/html; note=";charset=windows-1252 "; charset=utf-8');
  assert.equal((await observe()).status, "confirmed");
});

test("undecodable robots never becomes permission to fetch the source", async () => {
  let pageRequests = 0;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/robots.txt"))
      return new Response(Buffer.from("User-agent: *\nDisallow: /\n", "utf16le"), {
        headers: { "content-type": "text/plain; charset=utf-16le" },
      });
    pageRequests++;
    return new Response(html, { headers: { "content-type": "text/html" } });
  };
  const result = await observe();
  assert.equal(result.status, "error");
  assert.equal(result.absence_scope, null);
  assert.match(result.reason ?? "", /robots/i);
  assert.equal(pageRequests, 0);
});

test("capture omits unsupported text encoding even when HTTP status establishes resource absence", async () => {
  respond(Buffer.from(html), "text/html; charset=utf-16le", 404);
  const result = await captureBacklinks({ items: [pair] });
  assert.equal(result.verification.results[0]!.absence_scope, "http_resource");
  assert.equal(result.capture.entries.length, 0);
  assert.equal(result.capture.omitted[0]?.reason, "unreplayable_response");
});
for (const [name, bytes, type] of [
  ["UTF16LE declared", Buffer.from(asciiHtml, "utf16le"), "text/html; charset=utf-16le"],
  ["UTF16LE without declaration", Buffer.from(asciiHtml, "utf16le"), "text/html"],
  ["unsupported HTTP charset", Buffer.from(html), "text/html; charset=windows-1252"],
  ["unknown HTTP charset", Buffer.from(html), "text/html; charset=x-unknown"],
  [
    "invalid raw UTF8 href",
    Buffer.from(html.replace("café", "caf\xff"), "latin1"),
    "text/html; charset=utf-8",
  ],
  ["unsupported meta", Buffer.from('<meta charset="windows-1252">' + html), "text/html"],
  [
    "unsupported http-equiv",
    Buffer.from(
      '<meta http-equiv="content-type" content="text/html; charset=windows-1252">' + html,
    ),
    "text/html",
  ],
  [
    "unsupported XML declaration",
    Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?>' + html),
    "application/xhtml+xml",
  ],
] as const) {
  test(`${name} cannot establish HTML absence or confirmation through actual transport`, async () => {
    respond(bytes, type);
    const result = await observe();
    assert.equal(result.status, "error");
    assert.equal(result.absence_scope, null);
    assert.equal(result.evidence_kind, null);
  });
}

test("streamed UTF8 multibyte split, BOM and canonical decoder aliases retain exact URL evidence", async () => {
  for (const label of ["UTF-8", "utf8", "unicode-1-1-utf-8"]) {
    clearRobotsCache();
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(html)]);
    const split = bytes.indexOf(Buffer.from("é")) + 1;
    respond(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.subarray(0, split));
          controller.enqueue(bytes.subarray(split));
          controller.close();
        },
      }),
      `text/html; charset="${label}"`,
    );
    const result = await observe();
    assert.equal(result.status, "confirmed", label);
    assert.equal(result.resolved_href, pair.target_url);
  }
});

test("inert meta declarations do not override UTF8, and an HTTP UTF8 charset takes precedence", async () => {
  for (const [prefix, type] of [
    [
      '<!-- <meta charset="windows-1252"> --><script>const example = \'<meta charset="utf-16">\';</script>',
      "text/html",
    ],
    ['<meta charset="windows-1252">', "text/html; charset=utf-8"],
  ]) {
    clearRobotsCache();
    respond(Buffer.from(prefix + html), type);
    assert.equal((await observe()).status, "confirmed");
  }
});

test("HTTP resource absence remains independent of a validly decoded unsupported HTML declaration", async () => {
  respond(
    Buffer.from('<meta charset="windows-1252">' + html),
    "text/html; charset=windows-1252",
    404,
  );
  const result = await observe();
  assert.equal(result.status, "not_found");
  assert.equal(result.absence_scope, "http_resource");
});

test("fatal decode cancels the source stream without refunding its reserved request", async () => {
  let canceled = false;
  let reserved = 0;
  let timer: ReturnType<typeof setTimeout>;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0xff]));
      timer = setTimeout(() => controller.error(new Error("Fixture stream deadline")), 100);
    },
    cancel() {
      canceled = true;
      clearTimeout(timer);
    },
  });
  respond(stream);
  const queue = { reserveRequest: () => reserved++ } as unknown as ScanQueue;
  const options = { timeoutMs: 1000, maxBytes: 1000, cache: false, skipRobots: true };
  const measured = await withScanQueueRequests(
    queue,
    {} as TenantScope,
    {} as ScanLease,
    async () => {
      await assert.rejects(fetchText(pair.source_url, options), /encoded|encoding|utf-8/i);
    },
  );
  assert.equal(canceled, true);
  assert.equal(reserved, 1);
  assert.equal(measured.requests, 1);
  assert.equal(measured.bytes, null);
  respond(Buffer.from(html));
  assert.equal((await fetchText(pair.source_url, options)).text, html);
});
