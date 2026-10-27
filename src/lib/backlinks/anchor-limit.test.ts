import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnchors } from "./html.ts";
import { runSiteAudit } from "./site-audit.server.ts";
import { Budget, clearNetCache, setHostResolverForTests } from "./net.server.ts";
import { clearRobotsCache } from "./robots.server.ts";

const prefix = '<a name="section"></a>'.repeat(1200);
const html = `<html><body>${prefix}<a href="/actual">Actual page</a></body></html>`;

test("anchor limit counts returned links rather than named or unusable anchors", () => {
  const unusable = '<a href="javascript:void(0)">Action</a><a href="http://[">Invalid</a>';
  const links = parseAnchors(
    prefix + unusable + '<a href="/first">First</a><a href="/second">Second</a>',
    "https://site.example/",
    { exact: true, limit: 1 },
  );
  assert.equal(links.length, 1);
  assert.equal(links[0]!.href, "https://site.example/first");
});

test("crawl retains the real frontier after many named anchors", async () => {
  const originalFetch = globalThis.fetch;
  const originalPin = process.env.RANKPROOF_PIN_DNS;
  process.env.RANKPROOF_PIN_DNS = "0";
  setHostResolverForTests(async () => ["93.184.216.34"]);
  clearNetCache();
  clearRobotsCache();
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/robots.txt" || path.includes("sitemap"))
      return new Response("", { status: 404 });
    return new Response(path === "/" ? html : "<html><body>Leaf page.</body></html>", {
      headers: { "content-type": "text/html" },
    });
  };
  try {
    const audit = await runSiteAudit(
      "https://site.example/",
      "site.example",
      new Budget(10000),
      [],
      2,
    );
    assert.equal(audit.crawled, 2);
    assert.ok(
      audit.technicalGraph?.edges.some((edge) => edge.to === "https://site.example/actual"),
    );
    assert.equal(audit.technicalGraph?.coverage.observedLinkPages, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPin === undefined) delete process.env.RANKPROOF_PIN_DNS;
    else process.env.RANKPROOF_PIN_DNS = originalPin;
    setHostResolverForTests(null);
    clearNetCache();
    clearRobotsCache();
  }
});
