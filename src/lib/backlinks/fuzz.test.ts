/**
 * Seeded property tests. Every case is reproducible: a failure message names
 * the seed and iteration; rerun with RANKPROOF_FUZZ_SEED=<seed>. Raise the
 * count with RANKPROOF_FUZZ_RUNS (default 300 per property).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { guardUrl, guardUrlWithDns } from "./ssrf.ts";
import { parsePairTable, pairKey } from "./observe.ts";
import { tokenizeHtml } from "./html-tokenizer.ts";
import { isAllowed, parseRobots } from "./robots.server.ts";
import { observeRepresentation } from "./verify-api.server.ts";

const SEED = Number(process.env.RANKPROOF_FUZZ_SEED ?? 20261112);
const RUNS = Number(process.env.RANKPROOF_FUZZ_RUNS ?? 300);

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
  return { next, int, pick };
}

function forAll(name: string, body: (r: ReturnType<typeof rng>, i: number) => void) {
  for (let i = 0; i < RUNS; i++) {
    const r = rng(SEED + i * 7919);
    try {
      body(r, i);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${name} failed at seed ${SEED}, iteration ${i}: ${message}`, {
        cause: error,
      });
    }
  }
}

/* ------------------------------ URL guard ------------------------------ */

const PRIVATE_V4: [number, number, number][] = [
  // [first octet, second-octet min, second-octet max] for each private block
  [10, 0, 255],
  [127, 0, 255],
  [169, 254, 254],
  [172, 16, 31],
  [192, 168, 168],
  [100, 64, 127],
  [0, 0, 255],
];

function privateV4(r: ReturnType<typeof rng>): number[] {
  const [a, lo, hi] = r.pick(PRIVATE_V4);
  return [a, r.int(lo, hi), r.int(0, 255), r.int(0, 255)];
}

/** The many spellings a URL parser accepts for one IPv4 address. */
function encodeV4(o: number[], r: ReturnType<typeof rng>): string {
  const n = ((o[0]! << 24) >>> 0) + (o[1]! << 16) + (o[2]! << 8) + o[3]!;
  const part = (v: number) =>
    r.pick([
      String(v),
      `0x${v.toString(16)}`,
      `0${v.toString(8)}`,
      `0X${v.toString(16).toUpperCase()}`,
    ]);
  const hex = (v: number) => v.toString(16).padStart(4, "0");
  const forms = [
    () => o.map(part).join("."),
    () => String(n),
    () => `0x${n.toString(16)}`,
    () => `0${n.toString(8)}`,
    () => `${part(o[0]!)}.${(o[1]! << 16) + (o[2]! << 8) + o[3]!}`,
    () => `${part(o[0]!)}.${part(o[1]!)}.${(o[2]! << 8) + o[3]!}`,
    () => `${o.join(".")}.`,
    () => `[::ffff:${o.join(".")}]`,
    () => `[::ffff:${hex((o[0]! << 8) + o[1]!)}:${hex((o[2]! << 8) + o[3]!)}]`,
    () => `[0:0:0:0:0:ffff:${hex((o[0]! << 8) + o[1]!)}:${hex((o[2]! << 8) + o[3]!)}]`,
    () => `[64:ff9b::${o.join(".")}]`,
    () => o.join("。"),
  ];
  return r.pick(forms)();
}

test("property: every spelling of a private IPv4 address is refused", () => {
  forAll("private-v4", (r) => {
    const host = encodeV4(privateV4(r), r);
    const url = `${r.pick(["http", "https", "HTTP"])}://${r.pick(["", "user@", "a:b@"])}${host}${r.pick(["", ":80", ":8080"])}/${r.pick(["", "x", "?q=1"])}`;
    assert.equal(guardUrl(url).allowed, false, url);
  });
});

test("property: private IPv6 ranges are refused in any case and compression", () => {
  const prefixes = ["fc00", "fd12", "fe80", "fe9f", "febf", "ff02"];
  forAll("private-v6", (r) => {
    const groups = [
      r.pick(prefixes),
      ...Array.from({ length: 7 }, () => r.int(0, 0xffff).toString(16)),
    ];
    let ip = groups.join(":");
    if (r.next() < 0.5) ip = ip.toUpperCase();
    if (r.next() < 0.3) ip = `${groups[0]}::${groups[7]}`;
    assert.equal(guardUrl(`http://[${ip}]/`).allowed, false, ip);
  });
  for (const ip of ["::1", "::", "0:0:0:0:0:0:0:1"]) {
    assert.equal(guardUrl(`http://[${ip}]/`).allowed, false, ip);
  }
});

test("property: public addresses stay allowed; DNS answers into private space are refused", async () => {
  const publics = ["93.184.216.34", "1.1.1.1", "8.8.4.4", "151.101.1.69", "[2606:4700::6810:84e5]"];
  for (const ip of publics) assert.equal(guardUrl(`https://${ip}/`).allowed, true, ip);
  const r = rng(SEED);
  for (let i = 0; i < 50; i++) {
    const addr = privateV4(r).join(".");
    const verdict = await guardUrlWithDns("https://rebind.example/", async () => [
      "93.184.216.34",
      addr,
    ]);
    assert.equal(verdict.allowed, false, `a mixed answer with ${addr} must be refused`);
  }
});

const NOISE = [
  "",
  " ",
  "\t",
  "\u0000",
  "\uFEFF",
  "%",
  "%2e",
  "..",
  "@",
  "#",
  "?",
  "\\",
  "//",
  "[",
  "]",
  ":",
  "ä",
  "😀",
  "\u202e",
];

test("property: arbitrary strings never make the guard throw", () => {
  forAll("guard-total", (r) => {
    const raw = Array.from({ length: r.int(0, 12) }, () =>
      r.pick([...NOISE, "http://", "https://", "example.com", "127.0.0.1", "[::1]", "0x7f"]),
    ).join("");
    const verdict = guardUrl(raw);
    assert.equal(typeof verdict.allowed, "boolean");
  });
});

/* ------------------------------ pair table ----------------------------- */

const CELLS = [
  "https://pub.example/a",
  "https://pub.example/a?x=1",
  "http://blog.example/post",
  "https://brand.example/",
  "https://brand.example/guide",
  "javascript:alert(1)",
  "ftp://x.example/",
  "not a url",
  '"https://quoted.example/,comma"',
  "Brand, Inc.",
  "sponsored",
  "nofollow ugc",
  "content",
  "",
  "   ",
  "ä😀",
  "#comment",
  "source_url",
  "target_url",
];

test("property: the pair table parser is total and only emits valid, unique http(s) pairs", () => {
  forAll("pair-table", (r) => {
    const delimiter = r.pick([",", ";", "\t"]);
    const lines = Array.from({ length: r.int(0, 15) }, () =>
      Array.from({ length: r.int(0, 6) }, () => r.pick(CELLS)).join(delimiter),
    );
    const raw = (r.next() < 0.2 ? "\uFEFF" : "") + lines.join(r.pick(["\n", "\r\n"]));
    const table = parsePairTable(raw);
    const keys = new Set<string>();
    for (const row of table.rows) {
      for (const url of [row.source_url, row.target_url]) {
        assert.match(new URL(url).protocol, /^https?:$/, url);
      }
      const key = pairKey(row.source_url, row.target_url);
      assert.ok(!keys.has(key), `duplicate ${key}`);
      keys.add(key);
      assert.ok(row.line >= 1 && row.line <= lines.length, `line ${row.line}`);
    }
    assert.ok(table.rows.length + table.errors.length + table.duplicates <= lines.length + 1);
  });
});

/* ------------------------------ HTML ----------------------------------- */

const TARGET = "https://brand.example/guide";
const SOURCE = "https://pub.example/post";
const FRAGMENTS = [
  "<p>",
  "</p>",
  "<div class='a'>",
  "</div>",
  "<span>text</span>",
  "<br>",
  "<img src=x alt='y'>",
  "&amp;",
  "&lt;a href",
  "<",
  ">",
  "'",
  '"',
  "<a href='https://other.example/'>other</a>",
  "<a>empty</a>",
  "<nav>",
  "</nav>",
  "<footer>",
  "</footer>",
  "<article>",
  "</article>",
  "<table><tr><td>cell</td></tr></table>",
  "plain words ",
  "<!-- note -->",
  "<svg><path d='M0 0'/></svg>",
  "<ul><li>item</li></ul>",
];

/** Places where an exact-URL anchor must NOT count as a link on the page. */
const HIDDEN_HOMES = [
  (a: string) => `<!-- ${a} -->`,
  (a: string) => `<script>document.write('${a}');</script>`,
  (a: string) => `<script type="text/template">${a}</script>`,
  (a: string) => `<style>/* ${a} */</style>`,
  (a: string) => `<textarea>${a}</textarea>`,
  (a: string) => `<template>${a}</template>`,
  (a: string) => `<noscript>${a}</noscript>`,
  (a: string) => `<div data-x='${a.replace(/'/g, "&#39;")}'></div>`,
  (a: string) => `<title>${a}</title>`,
];

function soup(r: ReturnType<typeof rng>, size: number) {
  return Array.from({ length: size }, () => r.pick(FRAGMENTS)).join("");
}

function observe(html: string) {
  return observeRepresentation(
    { source_url: SOURCE, target_url: TARGET },
    { text: html, finalUrl: SOURCE, status: 200, contentType: "text/html" },
  );
}

test("property: the tokenizer is total, ordered and in bounds", () => {
  forAll("tokenizer", (r) => {
    const html = soup(r, r.int(0, 60)) + (r.next() < 0.3 ? "<a href='" : "");
    const doc = tokenizeHtml(html);
    let last = -1;
    for (const token of doc.tokens) {
      assert.ok(token.index >= 0 && token.end <= html.length && token.index < token.end);
      assert.ok(token.index > last, "tokens move forward");
      last = token.index;
    }
  });
});

test("property: a plain anchor to the exact URL in page content is always confirmed", () => {
  forAll("anchor-found", (r) => {
    const anchor = r.pick([
      `<a href="${TARGET}">Brand guide</a>`,
      `<a href='${TARGET}' rel="sponsored">Brand</a>`,
      `<A HREF=${TARGET}>Brand</A>`,
      `<a class="x" href="https://brand.example:443/guide">Brand</a>`,
      `<a href="https://BRAND.example/guide">Brand</a>`,
    ]);
    // Balanced noise around it: fragments that close what they open.
    const safe = FRAGMENTS.filter(
      (f) => !/^<\/?(p|div|nav|footer|article)>$|^<$|^>$|^'$|^"$|&lt;a/.test(f),
    );
    const body = Array.from({ length: r.int(0, 20) }, () => r.pick(safe));
    body.splice(r.int(0, body.length), 0, anchor);
    const html = `<!doctype html><html><head><title>t</title></head><body><main>${body.join("")}</main></body></html>`;
    const result = observe(html);
    assert.equal(result.status, "confirmed", `${result.reason}\n${html}`);
  });
});

test("property: the exact URL inside comments, scripts, styles, attributes or templates is never a link", () => {
  forAll("anchor-hidden", (r) => {
    const anchor = `<a href="${TARGET}">Brand</a>`;
    const hidden = r.pick(HIDDEN_HOMES)(anchor);
    const safe = FRAGMENTS.filter((f) => !/^<$|^>$|^'$|^"$|&lt;a/.test(f));
    const html = `<html><body>${Array.from({ length: r.int(0, 10) }, () => r.pick(safe)).join("")}${hidden}<p>end</p></body></html>`;
    const result = observe(html);
    // A readable page that only hides the URL is a definite absence: not a
    // link, and not an unreadable page either.
    assert.equal(result.status, "not_found", `${result.reason}\n${html}`);
  });
});

test("property: arbitrary markup never crashes the extractor and never confirms a URL it does not contain", () => {
  forAll("extractor-total", (r) => {
    const html = soup(r, r.int(0, 80));
    const result = observe(html);
    assert.ok(["confirmed", "not_found", "error"].includes(result.status));
    assert.notEqual(result.status, "confirmed", "no fragment links to the target");
  });
});

/* ------------------------------ robots.txt ----------------------------- */

const ROBOT_LINES = [
  "User-agent: *",
  "User-agent: RankProof",
  "User-agent: Googlebot",
  "Disallow: /",
  "Disallow: /private",
  "Disallow: /*.pdf$",
  "Disallow:",
  "Allow: /private/ok",
  "Allow: /",
  "Crawl-delay: 5",
  "Crawl-delay: nope",
  "Sitemap: https://x.example/sitemap.xml",
  "# comment",
  "garbage line",
  "",
  "\uFEFFUser-agent: *",
];

test("property: robots.txt parsing is total and Disallow: / for our group blocks everything", () => {
  forAll("robots", (r) => {
    const text = Array.from({ length: r.int(0, 20) }, () => r.pick(ROBOT_LINES)).join("\n");
    const rules = parseRobots(text);
    for (const path of ["/", "/private", "/private/ok", "/a.pdf", "/a.pdf?x", "/%E2%9C%93"]) {
      assert.equal(typeof isAllowed(rules, path), "boolean");
    }
    // RFC 9309: blank lines do not end a group, and on equal-length matches
    // Allow wins — so the property holds only without Allow lines.
    const noAllow = text
      .split("\n")
      .filter((line) => !line.startsWith("Allow"))
      .join("\n");
    const strict = parseRobots(`User-agent: rankproof\nDisallow: /\n\n${noAllow}`);
    assert.equal(isAllowed(strict, "/anything"), false);
    if (/^Allow: \/$/m.test(text) && !text.includes("User-agent")) {
      const tie = parseRobots(`User-agent: rankproof\nDisallow: /\n${text}`);
      assert.equal(isAllowed(tie, "/anything"), true, "equal-length Allow wins (RFC 9309 2.2.2)");
    }
  });
});
