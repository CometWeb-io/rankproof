import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearNetCache, setHostResolverForTests } from "./net.server.ts";
import { clearRobotsCache } from "./robots.server.ts";
import {
  combineStrictExitCode,
  formatVerifyRun,
  interleaveByHost,
  progressLine,
  replayRun,
  runVerifyFile,
  strictExitCode,
} from "./verify-run.server.ts";

const originalFetch = globalThis.fetch;
setHostResolverForTests(async () => ["93.184.216.34"]);
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearNetCache();
  clearRobotsCache();
});

function site(pages: Record<string, string | number>) {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    const page = pages[url];
    if (typeof page === "number") return new Response("down", { status: page });
    if (page === undefined) return new Response("", { status: 404 });
    return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
  };
}

const TABLE = [
  "source_url,target_url,expected_anchor,expected_rel",
  "https://a.example/post,https://brand.example/,Brand,follow",
  "https://b.example/post,https://brand.example/,,",
  "https://c.example/post,https://brand.example/,,",
].join("\n");

test("verify run: contract summary, capture, change report and replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rankproof-"));
  site({
    "https://a.example/post": `<html><body><a href="https://brand.example/">Brand</a></body></html>`,
    "https://b.example/post": `<html><body><a rel="sponsored" href="https://brand.example/">x</a></body></html>`,
    "https://c.example/post": 503,
  });
  const first = await runVerifyFile({ table: TABLE, captureDir: dir });
  assert.deepEqual(
    first.results.map((r) => r.contract.verdict),
    ["meets", "meets", "unverified"],
  );
  assert.equal(first.results[0]!.change, null);
  assert.equal(strictExitCode(first), 3, "an unverified pair fails --strict");

  // Next run: A lost its link, B changed rel, C is still down.
  site({
    "https://a.example/post": `<html><body><p>moved on</p></body></html>`,
    "https://b.example/post": `<html><body><a rel="nofollow" href="https://brand.example/">x</a></body></html>`,
    "https://c.example/post": 503,
  });
  const second = await runVerifyFile({ table: TABLE, previous: first.results });
  assert.deepEqual(
    second.results.map((r) => r.change?.kind),
    ["missing_in_representation", "changed_detail", "still_unverified"],
  );
  assert.equal(second.summary.changed, 2);
  assert.match(formatVerifyRun(second, "text"), /Gone from HTML/);
  assert.match(formatVerifyRun(second, "html"), /<table>/);

  const replay = await replayRun(first, dir);
  // The 503 body is stored too, so even the error replays to the same verdict.
  assert.deepEqual(replay.summary, {
    reproduced: 3,
    differs: 0,
    no_snapshot: 0,
    integrity_failed: 0,
  });

  // Tampering with a stored snapshot is detected by its hash.
  const hash = first.results[0]!.response_hash!;
  await writeFile(join(dir, `${hash}.html`), "<html>edited</html>");
  const tampered = await replayRun(first, dir);
  assert.equal(tampered.results[0]!.outcome, "integrity_failed");
  assert.ok((await readFile(join(dir, `${hash}.json`), "utf8")).includes("captured_at"));

  // A recorded hash is a file name: a path in it is refused before any read.
  const forged = {
    ...first,
    results: [{ ...first.results[1]!, response_hash: `../${first.results[1]!.response_hash}` }],
  };
  const refused = await replayRun(forged, dir);
  assert.equal(refused.results[0]!.outcome, "integrity_failed");
  assert.match(refused.results[0]!.detail, /not a SHA-256/);
});

test("replay keeps each observation's status when two responses share identical bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rankproof-"));
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    // Two empty bodies hash to the same snapshot file with different statuses.
    if (url === "https://d.example/denied") return new Response("", { status: 403 });
    return new Response("", { status: 404, headers: { "content-type": "text/html" } });
  };
  const table = [
    "https://d.example/denied,https://brand.example/",
    "https://e.example/gone,https://brand.example/",
  ].join("\n");
  const run = await runVerifyFile({ table, captureDir: dir });
  assert.deepEqual(
    run.results.map((r) => r.status),
    ["error", "not_found"],
  );
  assert.equal(run.results[0]!.response_hash, run.results[1]!.response_hash);
  const replay = await replayRun(run, dir);
  assert.deepEqual(
    replay.results.map((r) => r.outcome),
    ["reproduced", "reproduced"],
  );
});

test("verify run refuses an input without a single valid pair", async () => {
  await assert.rejects(() => runVerifyFile({ table: "nonsense\nfoo,bar" }), /Line 1/);
});

test("markdown report escapes table cells and shows changes", async () => {
  const { verifyRunMarkdown } = await import("./verify-run.server.ts");
  site({
    "https://a.example/post": `<html><body><a href="https://brand.example/">Brand | Co</a></body></html>`,
  });
  const first = await runVerifyFile({
    table: "https://a.example/post,https://brand.example/,Other,,",
  });
  const md = verifyRunMarkdown(first);
  assert.match(md, /^### RankProof: 0\/1 links meet their contract/);
  assert.match(md, /⚠️ Deviates/);
  assert.ok(!/Brand \| Co/.test(md.split("\n").slice(4).join("\n")) || md.includes("\\|"));
});

test("checkpoint: completed pairs are not fetched again; a torn last line is tolerated", async () => {
  const { appendFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "rankproof-checkpoint-"));
  const checkpoint = join(dir, "progress.jsonl");
  const fetched: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    fetched.push(url);
    return new Response(`<html><body><a href="https://brand.example/">Brand</a></body></html>`, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
  const two =
    "https://a.example/1,https://brand.example/\nhttps://b.example/2,https://brand.example/";
  await runVerifyFile({ table: two, checkpoint, captureDir: dir });
  assert.equal(fetched.length, 2);
  await appendFile(checkpoint, '{"source_url":"https://c.example/3","targ'); // interrupted write

  fetched.length = 0;
  const three = `${two.replace("https://brand.example/\n", "https://brand.example/,Other\n")}\nhttps://c.example/3,https://brand.example/`;
  const resumed = await runVerifyFile({ table: three, checkpoint });
  assert.deepEqual(fetched, ["https://c.example/3"], "only the missing pair is fetched");
  assert.equal(resumed.input.resumed, 2);
  assert.deepEqual(
    resumed.results.map((r) => r.source_url),
    ["https://a.example/1", "https://b.example/2", "https://c.example/3"],
    "table order is kept",
  );
  // A changed expectation is applied to the resumed observation.
  assert.equal(resumed.results[0]!.contract.verdict, "deviates");
});

test("checkpoint: pairs stored as errors are retried on resume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rankproof-checkpoint-"));
  const checkpoint = join(dir, "progress.jsonl");
  const fetched: string[] = [];
  let down = true;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    fetched.push(url);
    if (down && url.includes("b.example")) return new Response("down", { status: 503 });
    return new Response(`<html><body><a href="https://brand.example/">Brand</a></body></html>`, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
  const table =
    "https://a.example/1,https://brand.example/\nhttps://b.example/2,https://brand.example/";
  const first = await runVerifyFile({ table, checkpoint });
  assert.equal(first.results[1]!.status, "error");
  fetched.length = 0;
  down = false;
  const resumed = await runVerifyFile({ table, checkpoint });
  assert.deepEqual(fetched, ["https://b.example/2"], "only the failed pair is fetched again");
  assert.equal(resumed.input.resumed, 1);
  assert.equal(resumed.results[1]!.status, "confirmed");
});

test("hosts are spread across batches, each host keeping its own order", () => {
  const rows = [
    "https://a.example/1",
    "https://www.a.example/2",
    "https://a.example/3",
    "https://b.example/1",
    "https://c.example/1",
    "https://b.example/2",
  ].map((source_url) => ({ source_url }));
  assert.deepEqual(
    interleaveByHost(rows).map((r) => r.source_url),
    [
      "https://a.example/1",
      "https://b.example/1",
      "https://c.example/1",
      "https://www.a.example/2",
      "https://b.example/2",
      "https://a.example/3",
    ],
  );
  assert.equal(interleaveByHost([{ source_url: "not a url" }]).length, 1);
});

test("progress line with an estimate only while work remains", () => {
  assert.equal(
    progressLine(50, 200, 40, 30_000),
    "50/200 pairs (25%) · 40 confirmed · about 2 min left",
  );
  assert.equal(
    progressLine(150, 200, 120, 30_000),
    "150/200 pairs (75%) · 120 confirmed · about 10 s left",
  );
  assert.equal(progressLine(200, 200, 160, 60_000), "200/200 pairs (100%) · 160 confirmed");
});

test("--strict keeps a webhook failure (4) unless a contract fails (3)", () => {
  const run = (meets: number, total: number) =>
    ({ summary: { meets, total } }) as Parameters<typeof combineStrictExitCode>[1];
  assert.equal(combineStrictExitCode(4, run(2, 2)), 4, "a passing --strict never clears 4");
  assert.equal(combineStrictExitCode(4, run(1, 2)), 3);
  assert.equal(combineStrictExitCode(0, run(2, 2)), 0);
  assert.equal(combineStrictExitCode(undefined, run(1, 2)), 3);
});
