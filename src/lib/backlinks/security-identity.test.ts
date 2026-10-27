import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { parseTarget, normalizeUrl, pageKey, registrableDomain } from "./parse.ts";
import { registeredDomain } from "./public-suffix.ts";
import { guardUrl, guardUrlWithDns, isPrivateAddress } from "./ssrf.ts";
import { decodePinnedBody, isResponseCacheable, planCrawlDelay } from "./net.server.ts";
import { scanOptionsFromBody } from "./service-api.ts";
import { fetchSearchConsoleData } from "./search-console.server.ts";
import { config } from "./config.ts";
import { parseRobots, isAllowed } from "./robots.server.ts";

afterEach(() => mock.restoreAll());

test("public scan inputs cannot authorize the operator's webmaster credentials", async () => {
  const fetch = mock.method(globalThis, "fetch", async () => {
    throw new Error("Private call");
  });
  assert.equal(scanOptionsFromBody({ includeWebmaster: true }).includeWebmaster, false);
  assert.deepEqual(await fetchSearchConsoleData("example.com"), []);
  assert.equal(fetch.mock.callCount(), 0);
});

test("IDN and private PSL boundaries work across international markets", () => {
  for (const [host, expected] of [
    ["shop.example.co.uk", "example.co.uk"],
    ["www.przykład.pl", "xn--przykad-rjb.pl"],
    ["news.例子.中国", "xn--fsqu00a.xn--fiqs8s"],
    ["shop.example.co.jp", "example.co.jp"],
    ["www.example.com.br", "example.com.br"],
    ["shop.example.co.in", "example.co.in"],
    ["a.tenant.github.io", "tenant.github.io"],
  ])
    assert.equal(registrableDomain(host!), expected);
  assert.equal(parseTarget("https://przykład.pl/oferta").host, "xn--przykad-rjb.pl");
  assert.equal(parseTarget("https://example.com./").host, "example.com");
  for (const invalid of ["evil.com@target.com", "target.com/path", "target.com?x", "bad..com"])
    assert.equal(registeredDomain(invalid), "");
  assert.throws(() => parseTarget("https://user:password@example.com/"));
});

test("URL evidence identity preserves meaningful path, query, protocol and www differences", () => {
  const urls = [
    "https://example.com/A?q=X&ref=a",
    "https://example.com/a?q=X&ref=a",
    "https://example.com/A?ref=a&q=X",
    "http://example.com/A?q=X&ref=a",
    "https://www.example.com/A?q=X&ref=a",
    "https://example.com/A/?q=X&ref=a",
  ];
  assert.equal(new Set(urls.map(pageKey)).size, urls.length);
  assert.equal(normalizeUrl(urls[0]! + "#anchor"), urls[0]);
});

test("SSRF rejects malformed and mixed private DNS answers", async () => {
  assert.equal(isPrivateAddress("not-an-ip"), true);
  assert.equal(
    (await guardUrlWithDns("https://example.com", async () => ["93.184.216.34", "127.0.0.1"]))
      .allowed,
    false,
  );
  assert.equal(
    (await guardUrlWithDns("https://example.com", async () => Array(33).fill("93.184.216.34")))
      .allowed,
    false,
  );
});

test("pinned decoding supports chained encodings and caps decompression", () => {
  const text = Buffer.from("<html>content</html>");
  assert.deepEqual(decodePinnedBody(brotliCompressSync(gzipSync(text)), "gzip, br", 100), text);
  assert.throws(() => decodePinnedBody(gzipSync(Buffer.alloc(20_000)), "gzip", 100));
  assert.throws(() => decodePinnedBody(text, "unknown", 100));
});

test("response caches exclude private, cookie-dependent and unknown variants", () => {
  const privateHeaders: Record<string, string>[] = [
    { "cache-control": "private" },
    { "cache-control": "no-store" },
    { "set-cookie": "session=fixture" },
    { vary: "Cookie" },
    { vary: "*" },
  ];
  for (const headers of privateHeaders)
    assert.equal(isResponseCacheable(new Response("fixture", { headers })), false);
  assert.equal(
    isResponseCacheable(new Response("fixture", { headers: { vary: "Accept-Language" } })),
    true,
  );
});

test("crawl delays preserve requested spacing instead of compressing long delays", () => {
  assert.deepEqual(planCrawlDelay(1000, 2000, 30), { waitMs: 1000, nextAt: 32_000 });
  assert.equal(planCrawlDelay(1000, 20_000, 30), null);
  const rules = parseRobots(
    "User-agent: rank\nDisallow: /\nUser-agent: RankProof\nDisallow: /private\n",
  );
  assert.equal(isAllowed(rules, "/public"), true);
  assert.equal(isAllowed(rules, "/private"), false);
});

test("untrusted API workloads use a bounded quick profile regardless of requested profile", () => {
  assert.equal(scanOptionsFromBody({ profile: "deep" }).profile, "quick");
  const key = "RANKPROOF_SCAN_BUDGET_MS";
  const old = process.env[key];
  try {
    process.env[key] = "300000";
    assert.equal(config("quick").scanBudgetMs, 20_000);
    assert.equal(config("quick").maxVerify, 24);
    assert.equal(config("deep").scanBudgetMs, 180_000);
  } finally {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  }
});

test("robots rule limits fail closed instead of dropping late prohibitions", () => {
  const text = "#comment\n".repeat(3001) + "User-agent: *\nDisallow: /";
  assert.equal(isAllowed(parseRobots(text), "/private"), false);
  assert.equal(registeredDomain("。example.com"), "");
});

test("IPv6 local-use NAT64, site-local and IANA non-global prefixes are denied as literals and DNS answers", async () => {
  for (const address of [
    "64:ff9b:1::a9fe:a9fe",
    "64:ff9b:1::808:808",
    "64:ff9b:1:ffff::1",
    "fec0::1",
    "feff:ffff::1",
    "3fff::1",
    "3fff:fff:ffff::1",
    "5f00::1",
    "4000::1",
    "100:0:0:1::1",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
    assert.equal(guardUrl(`http://[${address}]/`).allowed, false, address);
    assert.equal(
      (await guardUrlWithDns("https://source.example/", async () => [address])).allowed,
      false,
      address,
    );
  }
  for (const address of [
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
    "64:ff9b::808:808",
    "::ffff:8.8.8.8",
  ])
    assert.equal(isPrivateAddress(address), false, address);
});
