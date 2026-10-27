import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, test } from "node:test";
import { buildTechnicalGraph, type TechnicalGraphInput } from "./technical-graph.ts";
import { technicalGraphCsv } from "./export.ts";
import { Budget, clearNetCache, setHostResolverForTests } from "./net.server.ts";
import { clearRobotsCache } from "./robots.server.ts";
import { runSiteAudit } from "./site-audit.server.ts";
import type { InternalPage, SiteAudit } from "./types.ts";

const root = "https://acceptance.example/";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setHostResolverForTests(null);
  clearNetCache();
  clearRobotsCache();
});
const html = (body: string, head = "") =>
  `<html><head><title>Authored fixture</title>${head}</head><body>${body}<p>${"Useful authored page text. ".repeat(18)}</p></body></html>`;
function input(): TechnicalGraphInput {
  const page = (path: string, status = 200): InternalPage => ({
    url: root + path,
    path: "/" + path,
    title: null,
    status,
    depth: 0,
    inboundLinks: 0,
    outboundLinks: 0,
    externalLinks: 0,
    noindex: false,
    canonical: null,
    backlinks: 0,
    redirected: false,
  });
  const pages = [page(""), page("synthetic", 0), page("gone", 404), page("a"), page("b")];
  pages[0]!.canonical = root + "synthetic";
  pages[3]!.canonical = root + "gone";
  const audit: SiteAudit = {
    status: "ok",
    crawled: 4,
    avgDepth: 0,
    avgInboundLinks: 0,
    maxDepth: 0,
    orphans: 0,
    brokenInternal: 1,
    redirectedInternal: 0,
    noindexPages: 0,
    pages,
    issues: [],
    score: 100,
  };
  return {
    rootUrl: root,
    audit,
    observations: [
      {
        url: root,
        links: ["a", "b"],
        hreflang: [
          { language: "EN", url: root + "a" },
          { language: "en", url: root + "b" },
        ],
        evidenceRef: "body:root",
      },
      { url: root + "a", links: [], evidenceRef: "body:a" },
      { url: root + "b", links: [], evidenceRef: "body:b" },
    ],
    inventories: [
      { source: "cms", urls: [root + "synthetic"], complete: true, evidenceRef: "cms:export" },
    ],
    crawl: { frontierExhausted: true, blockedUrls: [], failedUrls: [] },
  };
}

test("synthetic inventory rows cannot certify canonical, hreflang or sitemap target observations", () => {
  const data = input();
  data.observations[0]!.pagination = [{ relation: "next", url: root + "synthetic" }];
  data.inventories[0]!.source = "sitemap";
  const graph = buildTechnicalGraph(data);
  assert.ok(
    graph.issues.some(
      (issue) =>
        issue.kind === "canonical-target-unobserved" && issue.urls.includes(root + "synthetic"),
    ),
  );
  assert.ok(
    graph.issues.some(
      (issue) => issue.kind === "canonical-unusable-target" && issue.urls.includes(root + "gone"),
    ),
  );
  assert.ok(graph.issues.some((issue) => issue.kind === "hreflang-conflicting-locale"));
  assert.equal(graph.hreflang[0]!.reciprocity, "missing");
  assert.equal(graph.pagination[0]!.targetObserved, false);
  assert.deepEqual(graph.coverage.sitemap.unobserved, [root + "synthetic"]);
  assert.equal(graph.orphanCandidates[0]!.existence, "unknown");
  assert.ok(
    graph.repairTargets.some(
      (target) => target.url === root + "synthetic" && target.certainty === "candidate",
    ),
  );
});

test("credential-bearing inventory and coverage URLs are redacted and force incomplete coverage", () => {
  const data = input();
  data.inventories[0]!.urls.push(root + "private?token=DO_NOT_EXPORT");
  data.crawl.blockedUrls.push(root + "private?password=DO_NOT_EXPORT");
  const graph = buildTechnicalGraph(data);
  assert.equal(graph.coverage.redactedUrlCount, 2);
  assert.equal(graph.coverage.crawlCompleteWithinOrigin, false);
  assert.equal(graph.coverage.inventoryComplete, false);
  assert.ok(!JSON.stringify(graph).includes("DO_NOT_EXPORT"));
  assert.ok(!technicalGraphCsv(graph).includes("DO_NOT_EXPORT"));
});

test("excluded destinations remain observed edges; sibling origins and credential URLs are never crawled", async () => {
  setHostResolverForTests(async () => ["93.184.216.34"]);
  const requested: string[] = [];
  globalThis.fetch = async (url) => {
    const key = String(url);
    requested.push(key);
    if (key.endsWith("robots.txt")) return new Response("User-agent: *\nAllow: /");
    if (key.includes("sitemap")) return new Response("", { status: 404 });
    return new Response(
      html(
        '<a href="/manual.pdf?edition=2">PDF</a><a href="https://sibling.acceptance.example/">Sibling</a><a href="/secret?token=DO_NOT_EXPORT">Private</a>',
      ),
      { headers: { "content-type": "text/html" } },
    );
  };
  const result = await runSiteAudit(root, "acceptance.example", new Budget(20_000), [], 10, {
    knownUrls: [root + "manual.pdf?edition=2", root + "private?token=DO_NOT_EXPORT"],
  });
  assert.equal(result.status, "ok");
  const graph = result.technicalGraph!;
  assert.equal(graph.coverage.crawlCompleteWithinOrigin, false);
  assert.ok(graph.edges.some((edge) => edge.to === root + "manual.pdf?edition=2"));
  assert.deepEqual(graph.orphanCandidates, []);
  assert.ok(
    requested.every(
      (url) => !url.includes("sibling") && !url.includes(".pdf") && !url.includes("token="),
    ),
  );
  assert.ok(!JSON.stringify(result).includes("DO_NOT_EXPORT"));
});

test("sitemap discovery is exact-origin and bounded across an index chain", async () => {
  setHostResolverForTests(async () => ["93.184.216.34"]);
  const maps: string[] = [];
  globalThis.fetch = async (url) => {
    const key = String(url);
    if (key.endsWith("robots.txt"))
      return new Response(
        "User-agent: *\nAllow: /\nSitemap: https://elsewhere.example/private.xml",
      );
    if (key === root)
      return new Response(html("Root"), { headers: { "content-type": "text/html" } });
    maps.push(key);
    const n = maps.length;
    return new Response(
      `<sitemapindex><sitemap><loc>${root}map-${n}.xml</loc></sitemap></sitemapindex>`,
      { headers: { "content-type": "application/xml" } },
    );
  };
  const result = await runSiteAudit(root, "acceptance.example", new Budget(20_000), [], 5);
  assert.equal(result.status, "ok");
  assert.equal(maps.length, 32);
  assert.ok(maps.every((url) => new URL(url).origin === new URL(root).origin));
  assert.equal(result.technicalGraph!.coverage.inventoryComplete, false);
});

test(
  "large authored HTTP site: 1017 parsed pages, mixed inventory provenance, full repair export and partial countercase",
  { timeout: 60_000 },
  async (t) => {
    setHostResolverForTests(async () => ["93.184.216.34"]);
    const pages = new Map<string, string>();
    const anchor = (path: string) => `<a href="${path}">${path}</a>`;
    pages.set("/", html(Array.from({ length: 10 }, (_, i) => anchor(`/hub/${i}`)).join("")));
    for (let hub = 0; hub < 10; hub++) {
      let links = Array.from({ length: 100 }, (_, i) => anchor(`/product/${hub * 100 + i}`)).join(
        "",
      );
      if (hub === 0)
        links +=
          anchor("/filter?color=Red") + anchor("/filter?color=red") + anchor("/collection?page=2");
      pages.set(
        `/hub/${hub}`,
        html(links, hub === 0 ? '<link rel="next" href="/collection?page=2">' : ""),
      );
    }
    for (let i = 0; i < 1000; i++)
      pages.set(
        `/product/${i}`,
        html(
          i === 999 ? anchor("/deep/one") : "Product",
          i === 0
            ? '<link rel="canonical" href="/inventory/canonical"><link rel="alternate" hreflang="de" href="/product/1">'
            : "",
        ),
      );
    for (const color of ["Red", "red"])
      pages.set(
        `/filter?color=${color}`,
        html("Filtered collection", '<link rel="canonical" href="/hub/0">'),
      );
    pages.set("/collection?page=2", html("Collection page 2", '<link rel="prev" href="/hub/0">'));
    pages.set("/deep/one", html(anchor("/deep/two")));
    pages.set("/deep/two", html(anchor("/deep/three")));
    pages.set("/deep/three", html("Deep page"));
    assert.equal(pages.size, 1017);
    const inventoryOnly = Array.from({ length: 250 }, (_, i) => root + `inventory/${i}`);
    const sitemap = `<urlset>${[...pages.keys(), "/inventory/canonical"].map((path) => `<url><loc>${new URL(path, root).href.replaceAll("&", "&amp;")}</loc></url>`).join("")}</urlset>`;
    const requested: string[] = [];
    const server = createServer((req, res) => {
      const path = req.url!;
      requested.push(path);
      if (path === "/robots.txt") {
        res.setHeader("content-type", "text/plain");
        res.end("User-agent: *\nAllow: /\nSitemap: " + root + "inventory.xml");
        return;
      }
      if (path === "/inventory.xml") {
        res.setHeader("content-type", "application/xml");
        res.end(sitemap);
        return;
      }
      const body = pages.get(path);
      res.statusCode = body ? 200 : 404;
      res.setHeader("content-type", "text/html");
      res.end(body ?? "Not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    // Test-only network adapter: all actual HTTP goes to this authored loopback server.
    // Production admission still sees the public-form exact origin; no public requests occur.
    globalThis.fetch = async (url, options) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.origin, new URL(root).origin);
      const response = await originalFetch(
        `http://127.0.0.1:${address.port}${parsed.pathname}${parsed.search}`,
        options,
      );
      return new Response(response.body, { status: response.status, headers: response.headers });
    };
    try {
      const options = {
        inventories: [
          {
            source: "gsc" as const,
            urls: inventoryOnly,
            complete: false,
            evidenceRef: "gsc:authored-export",
          },
          {
            source: "cms" as const,
            urls: inventoryOnly,
            complete: true,
            evidenceRef: "cms:authored-export",
          },
        ],
      };
      const started = performance.now();
      const full = await runSiteAudit(
        root,
        "acceptance.example",
        new Budget(55_000),
        [],
        1100,
        options,
      );
      const elapsedMs = Math.round(performance.now() - started);
      assert.equal(full.status, "ok");
      assert.equal(full.crawled, 1017);
      const graph = full.technicalGraph!;
      assert.equal(graph.coverage.observedLinkPages, 1017);
      assert.equal(graph.coverage.crawlCompleteWithinOrigin, true);
      assert.equal(graph.coverage.inventoryComplete, false);
      assert.equal(graph.coverage.sitemap.inventory, 1018);
      assert.equal(graph.coverage.sitemap.reached, 1017);
      assert.ok(
        graph.inventories.some(
          (item) =>
            item.documentUrl === root + "inventory.xml" &&
            /^sitemap:sha256:[a-f0-9]{64}$/.test(item.evidenceRef),
        ),
      );
      assert.equal(graph.depths.find((item) => item.url === root + "deep/three")!.depth, 5);
      const facets = graph.facetCandidates.find((item) => item.path === root + "filter")!;
      assert.deepEqual(facets.parameterAxes, [{ name: "color", values: ["Red", "red"] }]);
      assert.equal(facets.navigation.length, 2);
      assert.equal(facets.classification, "query-variants-not-proven-facets");
      assert.equal(graph.pagination.length, 2);
      assert.equal(graph.orphanCandidates.length, 251);
      const unknown = graph.orphanCandidates.find((item) => item.url === inventoryOnly[0])!;
      assert.deepEqual(
        unknown.sources.map((item) => item.source),
        ["gsc", "cms"],
      );
      assert.equal(unknown.existence, "unknown");
      assert.equal(unknown.status, "unreachable-in-observed-graph");
      const csv = technicalGraphCsv(graph);
      assert.ok(csv.includes(inventoryOnly[249]!));
      assert.ok(csv.split("\n").length > 250, "no 100-page/sample truncation");
      assert.ok(!csv.includes("<html>"));
      const fullRequests = requested.length;
      clearNetCache();
      clearRobotsCache();
      const partial = await runSiteAudit(
        root,
        "acceptance.example",
        new Budget(55_000),
        [],
        12,
        options,
      );
      assert.equal(partial.status, "ok");
      assert.equal(partial.technicalGraph!.coverage.crawlCompleteWithinOrigin, false);
      assert.ok(partial.technicalGraph!.coverage.missingObservations.length > 900);
      assert.ok(
        partial.technicalGraph!.orphanCandidates.every(
          (item) => item.status === "inventory-not-reached",
        ),
      );
      t.diagnostic(
        JSON.stringify({
          corpus: "authored-local-http-not-real-world-benchmark",
          parsedPages: full.crawled,
          fullRequests,
          fullElapsedMs: elapsedMs,
          inventoryUrls: 1268,
          orphanInvestigations: graph.orphanCandidates.length,
          csvRows: csv.split("\n").length - 1,
          partialParsedPages: partial.crawled,
        }),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test("observed apex-to-www bootstrap establishes actual document scope and path redirects add no click", async () => {
  const requestedRoot = "https://acceptance.example/";
  const actualRoot = "https://www.acceptance.example/home/";
  const requested: string[] = [];
  const dns: string[] = [];
  setHostResolverForTests(async (host) => {
    dns.push(host);
    return ["93.184.216.34"];
  });
  globalThis.fetch = async (url) => {
    const key = String(url);
    requested.push(key);
    const parsed = new URL(key);
    if (parsed.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /");
    if (parsed.pathname.includes("sitemap")) return new Response("", { status: 404 });
    if (key === requestedRoot)
      return new Response(null, { status: 301, headers: { location: actualRoot } });
    if (key === actualRoot)
      return new Response(
        html('<a href="/alias">Alias</a><a href="/external">External redirect</a>'),
        { headers: { "content-type": "text/html" } },
      );
    if (parsed.pathname === "/alias")
      return new Response(null, { status: 308, headers: { location: "/destination/page" } });
    if (parsed.pathname === "/external")
      return new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example/forbidden" },
      });
    if (parsed.pathname === "/destination/page")
      return new Response(html('<a href="child">Child</a>'), {
        headers: { "content-type": "text/html" },
      });
    if (parsed.pathname === "/destination/child")
      return new Response(html("Child"), { headers: { "content-type": "text/html" } });
    throw new Error("Unexpected fixture URL: " + key);
  };
  const result = await runSiteAudit(
    requestedRoot,
    "acceptance.example",
    new Budget(20_000),
    [],
    20,
  );
  assert.equal(result.status, "ok");
  const graph = result.technicalGraph!;
  assert.equal(graph.scope.rootUrl, actualRoot);
  assert.equal(graph.scope.requestedRootUrl, requestedRoot);
  assert.equal(graph.scope.origin, "https://www.acceptance.example");
  assert.ok(graph.edges.some((edge) => edge.from === actualRoot && edge.to.endsWith("/alias")));
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.from === "https://www.acceptance.example/destination/page" &&
        edge.to.endsWith("/destination/child"),
    ),
  );
  assert.ok(
    !graph.edges.some((edge) => edge.from.endsWith("/alias") || edge.from === requestedRoot),
  );
  assert.equal(graph.depths.find((item) => item.url.endsWith("/destination/page"))!.depth, 1);
  assert.equal(graph.depths.find((item) => item.url.endsWith("/destination/child"))!.depth, 2);
  assert.ok(
    graph.redirects.some(
      (hop) => hop.from === requestedRoot && hop.to === actualRoot && hop.status === 301,
    ),
  );
  assert.ok(
    graph.redirects.some(
      (hop) =>
        hop.from.endsWith("/alias") && hop.to.endsWith("/destination/page") && hop.status === 308,
    ),
  );
  assert.ok(
    graph.redirects.some(
      (hop) => hop.to === "https://elsewhere.example/forbidden" && hop.status === 302,
    ),
  );
  assert.ok(
    !requested.some((url) => url.includes("elsewhere.example")),
    "refused before target HTTP",
  );
  assert.ok(!dns.some((host) => host === "elsewhere.example"), "refused before target DNS");
  assert.equal(
    graph.coverage.crawlCompleteWithinOrigin,
    false,
    "refused redirect keeps scope partial",
  );
});

test("graph CSV neutralizes spreadsheet formulas in imported evidence labels", () => {
  const data = input();
  data.inventories[0]!.evidenceRef = '=HYPERLINK("https://example.org")';
  const graph = buildTechnicalGraph(data);
  // Evidence is encoded as JSON within a quoted cell; an imported kind must also be safe.
  graph.repairTargets[0]!.kind = "=1+1";
  assert.ok(technicalGraphCsv(graph).includes('"\'=1+1"'));
  assert.ok(!technicalGraphCsv(graph).includes('\n"=1+1"'));
});

test("same-origin bootstrap and path redirects can exhaust the observed graph without alias HTML", async () => {
  setHostResolverForTests(async () => ["93.184.216.34"]);
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/robots.txt") return new Response("User-agent: *\nAllow: /");
    if (path.includes("sitemap")) return new Response("", { status: 404 });
    if (path === "/") return new Response(null, { status: 301, headers: { location: "/home" } });
    if (path === "/alias")
      return new Response(null, { status: 302, headers: { location: "/intermediate" } });
    if (path === "/intermediate")
      return new Response(null, { status: 307, headers: { location: "/destination" } });
    return new Response(html(path === "/home" ? '<a href="/alias">Alias</a>' : "Final document"), {
      headers: { "content-type": "text/html" },
    });
  };
  const result = await runSiteAudit(root, "acceptance.example", new Budget(20_000), [], 10);
  assert.equal(result.status, "ok");
  const graph = result.technicalGraph!;
  assert.equal(graph.scope.rootUrl, root + "home");
  assert.equal(graph.coverage.crawlCompleteWithinOrigin, true);
  assert.equal(graph.depths.find((item) => item.url === root + "destination")!.depth, 1);
  assert.ok(
    graph.documentResolutions.some(
      (item) => item.requestedUrl === root + "alias" && item.documentUrl === root + "destination",
    ),
  );
  assert.equal(graph.redirects.length, 3);
  assert.deepEqual(
    graph.edges.map((edge) => edge.from),
    [root + "home"],
  );
  const data = input();
  data.observations[0]!.resolvedUrl = root + "different-document";
  assert.throws(() => buildTechnicalGraph(data), /unique audited URLs/);
});

test("coverage counts fetched HTTP audit rows separately from synthetic known inventory rows", () => {
  const graph = buildTechnicalGraph(input());
  assert.equal(graph.coverage.knownPages, 5);
  assert.equal(
    graph.coverage.auditedPages,
    4,
    "HTTP404 is an actual response; status0 is inventory only",
  );
  assert.equal(
    graph.coverage.observedLinkPages,
    3,
    "only admitted HTML documents supply link observations",
  );
});
