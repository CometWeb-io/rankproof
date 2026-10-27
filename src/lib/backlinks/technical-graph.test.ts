import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { buildTechnicalGraph, type TechnicalGraphInput } from "./technical-graph.ts";
import { Budget, clearNetCache, setHostResolverForTests } from "./net.server.ts";
import { clearRobotsCache } from "./robots.server.ts";
import { runSiteAudit } from "./site-audit.server.ts";
import type { InternalPage, SiteAudit } from "./types.ts";

const root = "https://graph.example/";
const page = (path: string, canonical: string | null = null): InternalPage => ({
  url: new URL(path, root).href,
  path,
  title: path,
  status: 200,
  depth: 99,
  inboundLinks: 0,
  outboundLinks: 0,
  externalLinks: 0,
  noindex: false,
  canonical,
  backlinks: 0,
  redirected: false,
});
const audit = (pages: InternalPage[]): SiteAudit => ({
  status: "ok",
  crawled: pages.length,
  avgDepth: 0,
  avgInboundLinks: 0,
  maxDepth: 0,
  orphans: 0,
  brokenInternal: 0,
  redirectedInternal: 0,
  noindexPages: 0,
  pages,
  issues: [],
  score: 100,
});
const input = (): TechnicalGraphInput => ({
  rootUrl: root,
  audit: audit([page("/"), page("/a"), page("/b"), page("/orphan")]),
  observations: [
    { url: root, links: ["/a", "/b"], evidenceRef: "raw:root" },
    { url: root + "a", links: ["/b"], evidenceRef: "raw:a" },
    { url: root + "b", links: [], evidenceRef: "raw:b" },
  ],
  inventories: [
    {
      source: "sitemap",
      urls: [root + "a", root + "orphan"],
      complete: false,
      evidenceRef: "sitemap:1",
    },
  ],
  crawl: { frontierExhausted: true, blockedUrls: [], failedUrls: [] },
});

test("graph recomputes shortest depths and reports scope-aware orphan candidates", () => {
  const report = buildTechnicalGraph(input());
  assert.equal(report.depths.find((p) => p.url === root + "b")?.depth, 1);
  assert.equal(report.coverage.crawlCompleteWithinOrigin, true);
  assert.equal(report.coverage.inventoryComplete, false);
  assert.equal(report.orphanCandidates[0]?.status, "unreachable-in-observed-graph");
  const truncated = input();
  truncated.crawl.frontierExhausted = false;
  assert.equal(buildTechnicalGraph(truncated).orphanCandidates[0]?.status, "inventory-not-reached");
  const missing = input();
  missing.observations.pop();
  assert.equal(buildTechnicalGraph(missing).coverage.crawlCompleteWithinOrigin, false);
});

test("canonical cycles, unobserved alternates, sitemap coverage, facets and pagination retain exact URLs", () => {
  const data = input();
  data.audit.pages[1]!.canonical = root + "b";
  data.audit.pages[2]!.canonical = root + "a";
  data.observations[0]!.hreflang = [{ language: "de", url: root + "de" }];
  data.observations[0]!.pagination = [{ relation: "next", url: root + "a" }];
  data.inventories[0]!.urls.push(root + "a?color=Red", root + "a?color=red");
  const report = buildTechnicalGraph(data);
  assert.deepEqual(report.canonicalClusters, [[root + "a", root + "b"]]);
  assert.equal(report.issues[0]?.kind, "canonical-cycle");
  assert.equal(report.hreflang[0]?.reciprocity, "unknown");
  assert.equal(report.pagination[0]?.targetObserved, true);
  assert.deepEqual(report.facetCandidates[0]?.urls, [root + "a?color=Red", root + "a?color=red"]);
  assert.equal(report.coverage.sitemap.inventory, 4);
});

test("invalid provenance, mixed scope and duplicate observations are rejected", () => {
  const data = input();
  data.inventories[0]!.urls.push("https://elsewhere.example/");
  assert.throws(() => buildTechnicalGraph(data), /origin scope/);
  const duplicate = input();
  duplicate.observations.push(duplicate.observations[0]!);
  assert.throws(() => buildTechnicalGraph(duplicate), /unique/);
});

const originalFetch = globalThis.fetch;
setHostResolverForTests(async () => ["93.184.216.34"]);
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearNetCache();
  clearRobotsCache();
});

test("real site-audit crawl path exports graph observations from fetched HTML and sitemap", async () => {
  const body = (content: string) =>
    `<html><head><title>Graph</title><link rel="alternate" hreflang="de" href="/de"><link rel="next" href="/a"></head><body>${content}${"Readable page. ".repeat(30)}</body></html>`;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/robots.txt")
      return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (path === "/sitemap.xml")
      return new Response(`<urlset><url><loc>${root}inventory-only</loc></url></urlset>`, {
        headers: { "content-type": "application/xml" },
      });
    if (path === "/sitemap_index.xml") return new Response("", { status: 404 });
    return new Response(body(path === "/" ? '<a href="/a">A</a>' : '<a href="/">Home</a>'), {
      headers: { "content-type": "text/html" },
    });
  };
  const result = await runSiteAudit(root, "graph.example", new Budget(20_000), [], 10);
  assert.equal(result.status, "ok");
  assert.equal(result.technicalGraph?.edges.length, 2);
  assert.equal(result.technicalGraph?.hreflang[0]?.language, "de");
  assert.equal(result.technicalGraph?.pagination[0]?.relation, "next");
  assert.equal(result.technicalGraph?.orphanCandidates[0]?.url, root + "inventory-only");
  assert.match(
    result.technicalGraph?.edges[0]?.evidenceRef ?? "",
    /^useful-html:sha256:[a-f0-9]{64}$/,
  );
});

test("truncated production crawl cannot claim complete graph coverage", async () => {
  globalThis.fetch = async (url) =>
    String(url).endsWith("robots.txt")
      ? new Response("User-agent: *\nAllow: /")
      : new Response(
          `<html><body><a href="/unfetched">Next</a>${"Text ".repeat(60)}</body></html>`,
          { headers: { "content-type": "text/html" } },
        );
  const result = await runSiteAudit(root, "graph.example", new Budget(20_000), [], 1);
  assert.equal(result.status, "ok");
  assert.equal(result.technicalGraph?.coverage.crawlCompleteWithinOrigin, false);
});

test("HTML byte limits reject truncated responses while unsupported schemes are not crawl edges", async () => {
  for (const repeats of [60, 60_000]) {
    clearNetCache();
    clearRobotsCache();
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/robots.txt") return new Response("User-agent: *\nAllow: /");
      if (path.includes("sitemap")) return new Response("", { status: 404 });
      return new Response(
        `<html><body><a href="ftp://graph.example/file">FTP</a>${"Text ".repeat(repeats)}</body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    };
    const result = await runSiteAudit(root, "graph.example", new Budget(20_000), [], 10);
    assert.equal(result.status, repeats === 60 ? "ok" : "failed");
    if (repeats === 60) assert.deepEqual(result.technicalGraph?.edges, []);
    else assert.notEqual(result.technicalGraph?.coverage.crawlCompleteWithinOrigin, true);
  }
});

test("HTTP 200 challenges and non-HTML cannot establish valid complete graphs", async () => {
  for (const contentType of ["text/html", "application/json"]) {
    clearNetCache();
    clearRobotsCache();
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/robots.txt") return new Response("User-agent: *\nAllow: /");
      if (path.includes("sitemap")) return new Response("", { status: 404 });
      return new Response(
        `<html><head><title>Just a moment</title></head><body>${"Verify you are human. ".repeat(30)}</body></html>`,
        { headers: { "content-type": contentType } },
      );
    };
    const result = await runSiteAudit(root, "graph.example", new Budget(20_000), [], 10);
    assert.equal(result.status, "failed");
    assert.notEqual(result.technicalGraph?.coverage.crawlCompleteWithinOrigin, true);
  }
});

test("linked inventory targets remain reachable when the fetch budget stops before visiting them", async () => {
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/robots.txt") return new Response("User-agent: *\nAllow: /");
    if (path === "/sitemap.xml")
      return new Response(
        `<urlset><url><loc>${root}a</loc></url><url><loc>${root}unknown</loc></url></urlset>`,
        { headers: { "content-type": "application/xml" } },
      );
    if (path === "/sitemap_index.xml") return new Response("", { status: 404 });
    return new Response(`<html><body><a href="/a">A</a>${"Page text ".repeat(40)}</body></html>`, {
      headers: { "content-type": "text/html" },
    });
  };
  const result = await runSiteAudit(root, "graph.example", new Budget(20_000), [], 1);
  assert.equal(result.status, "ok");
  assert.equal(result.orphans, 1, "only unknown inventory URL is a candidate");
  assert.deepEqual(
    result.technicalGraph?.orphanCandidates.map((c) => c.url),
    [root + "unknown"],
  );
  assert.equal(result.issues.find((i) => i.id === "orphan-pages")?.severity, "low");
  assert.equal(
    result.score,
    100,
    "unmeasured inventory candidates must not reduce the heuristic score",
  );
});
