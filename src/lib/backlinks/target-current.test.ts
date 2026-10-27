import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectTarget } from "./target.server.ts";
import { Budget, clearNetCache, setHostResolverForTests } from "./net.server.ts";
import { clearRobotsCache } from "./robots.server.ts";

test("an archive fallback never becomes a current on-page audit or current outbound graph", async () => {
  const original = globalThis.fetch;
  setHostResolverForTests(async () => ["93.184.216.34"]);
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
    if (url.hostname === "target.example" || url.hostname === "www.target.example")
      return new Response("", { status: 503 });
    if (url.hostname === "archive.org")
      return Response.json({
        archived_snapshots: {
          closest: {
            available: true,
            url: "https://web.archive.org/web/20200101000000/https://target.example/",
            timestamp: "20200101000000",
          },
        },
      });
    if (url.hostname === "web.archive.org" && url.pathname.startsWith("/web/"))
      return new Response(
        `<html><head><title>Archived title</title></head><body><article><a href="https://partner.example/">Historical partner</a>${"Archive content from a different date. ".repeat(150)}</article></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    return Response.json({});
  };
  try {
    const intel = await inspectTarget("target.example", new Budget(30_000));
    assert.equal(intel.snapshot.usedArchive, true);
    assert.equal(intel.onPage, null);
    assert.ok(
      intel.outbound.some(
        (item) => item.url === "https://partner.example/" && item.via === "archive",
      ),
    );
    assert.equal(
      intel.outbound.some((item) => item.via === "graph"),
      false,
    );
  } finally {
    globalThis.fetch = original;
    clearNetCache();
    clearRobotsCache();
  }
});

test("blocked and challenge target pages cannot supply current HTML facts", async () => {
  const original = globalThis.fetch;
  setHostResolverForTests(async () => ["93.184.216.34"]);
  try {
    for (const [status, title, type] of [
      [403, "Access denied", "text/html"],
      [200, "Just a moment", "text/html"],
      [200, "JSON-looking body", "application/json"],
    ] as const) {
      clearNetCache();
      clearRobotsCache();
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
        if (url.hostname === "target.example" || url.hostname === "www.target.example")
          return new Response(
            `<html><head><title>${title}</title></head><body><a href="https://partner.example/">Trap</a>${"Challenge text. ".repeat(300)}</body></html>`,
            { status, headers: { "content-type": type } },
          );
        return Response.json({});
      };
      const intel = await inspectTarget("target.example", new Budget(30_000));
      assert.equal(intel.onPage, null, `${status}/${title}`);
      assert.equal(
        intel.outbound.some((item) => item.via === "graph"),
        false,
        `${status}/${title}`,
      );
    }
  } finally {
    globalThis.fetch = original;
    clearNetCache();
    clearRobotsCache();
  }
});

test("an archive browser challenge is not a recovery candidate", async () => {
  const { findLostLinks } = await import("./verify.server.ts");
  const original = globalThis.fetch;
  setHostResolverForTests(async () => ["93.184.216.34"]);
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
    if (url.hostname === "archive.org")
      return Response.json({
        archived_snapshots: {
          closest: {
            available: true,
            url: "https://web.archive.org/web/20200101000000/https://source.example/history",
            timestamp: "20200101000000",
          },
        },
      });
    return new Response(
      `<html><head><title>Just a moment</title></head><body><a href="https://target.example/">Challenge link</a>${"Verification text. ".repeat(100)}</body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  };
  try {
    const rows = await findLostLinks(["https://source.example/history"], {
      host: "target.example",
      brandTokens: [],
      budget: new Budget(30_000),
      limit: 1,
    });
    assert.equal(rows.length, 0);
  } finally {
    globalThis.fetch = original;
    clearNetCache();
    clearRobotsCache();
  }
});

test("fresh scan verification uses the same complete HTML challenge admission", async () => {
  const { verifyPages } = await import("./verify.server.ts");
  const original = globalThis.fetch;
  setHostResolverForTests(async () => ["93.184.216.34"]);
  globalThis.fetch = async (input) =>
    String(input).endsWith("/robots.txt")
      ? new Response("", { status: 404 })
      : new Response(
          `<html><head><title>Checking browser</title></head><body>Enable JavaScript and cookies to continue.<a href="https://target.example/">Challenge link</a>${"Verification text. ".repeat(100)}</body></html>`,
          { headers: { "content-type": "text/html" } },
        );
  try {
    const result = await verifyPages(
      [{ url: "https://source.example/challenge", title: "", via: "bing" }],
      { host: "target.example", brandTokens: [], limit: 1, budget: new Budget(30_000) },
    );
    assert.equal(result.backlinks.length, 0);
    assert.equal(result.edges.length, 0);
  } finally {
    globalThis.fetch = original;
    clearNetCache();
    clearRobotsCache();
  }
});
