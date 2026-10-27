import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorBacklinks } from "./monitor-backlinks.mjs";

test("local monitor command creates finite plans, waits without network and exports only private new files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rankproof-monitor-cli-"));
  const database = join(directory, "queue.sqlite"),
    plan = join(directory, "plan.json"),
    created = join(directory, "created.json"),
    tick = join(directory, "tick.json"),
    exported = join(directory, "export.json");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Future schedule must not fetch");
  };
  try {
    writeFileSync(
      plan,
      JSON.stringify({
        id: "future",
        firstAt: Date.now() + 60_000,
        intervalMs: 3_600_000,
        occurrences: 2,
        pairs: [{ source_url: "https://publisher.example/", target_url: "https://brand.example/" }],
      }),
      { mode: 0o600 },
    );
    const common = [database, "local", "site", "operator"];
    await monitorBacklinks(["create", ...common, plan, created]);
    await monitorBacklinks(["tick", ...common, "future", tick]);
    await monitorBacklinks(["export", ...common, "future", exported]);
    assert.equal(JSON.parse(readFileSync(tick, "utf8")).state, "waiting");
    assert.equal(JSON.parse(readFileSync(exported, "utf8")).receipts.length, 0);
    for (const file of [created, tick, exported, database])
      assert.equal(statSync(file).mode & 0o077, 0);
    await assert.rejects(() => monitorBacklinks(["tick", ...common, "future", tick]), /EEXIST/);
    assert.equal(JSON.parse(readFileSync(tick, "utf8")).state, "waiting");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("independent Node processes resume a persisted original plan and export a comparable absence", async () => {
  const { execFile } = await import("node:child_process"),
    { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const directory = mkdtempSync(join(tmpdir(), "rankproof-monitor-restart-"));
  const database = join(directory, "queue.sqlite"),
    plan = join(directory, "plan.json"),
    base = Date.now();
  const present = '<html><body><a href="https://brand.example/offer">Offer</a></body></html>';
  const absent = "<html><body>The complete source now has no target anchor.</body></html>";
  const module = new URL("./monitor-backlinks.mjs", import.meta.url).href;
  try {
    writeFileSync(
      plan,
      JSON.stringify({
        id: "restart",
        firstAt: base,
        intervalMs: 3_600_000,
        occurrences: 2,
        pairs: [
          { source_url: "https://publisher.example/", target_url: "https://brand.example/offer" },
        ],
      }),
      { mode: 0o600 },
    );
    async function child(at, html, create) {
      const code = `import {mock} from 'node:test';import {monitorBacklinks} from ${JSON.stringify(module)};import {setHostResolverForTests} from ${JSON.stringify(new URL("../src/lib/backlinks/net.server.ts", import.meta.url).href)};mock.timers.enable({apis:['Date'],now:${at}});process.env.RANKPROOF_PIN_DNS='0';setHostResolverForTests(async()=>['93.184.216.34']);globalThis.fetch=async(input)=>String(input).endsWith('/robots.txt')?new Response('',{status:404}):new Response(${JSON.stringify(html)},{headers:{'content-type':'text/html'}});const common=${JSON.stringify([database, "local", "site", "operator"])};${create ? `await monitorBacklinks(['create',...common,${JSON.stringify(plan)},${JSON.stringify(join(directory, "created.json"))}]);` : ""}await monitorBacklinks(['tick',...common,'restart',${JSON.stringify(join(directory, `tick-${at}.json`))}]);mock.timers.reset();`;
      await exec(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "--eval", code],
        { timeout: 10000, maxBuffer: 32768 },
      );
    }
    await child(base, present, true);
    await child(base + 3_600_000, absent, false);
    const result = JSON.parse(
      readFileSync(join(directory, `tick-${base + 3_600_000}.json`), "utf8"),
    );
    assert.equal(result.receipt.alerts[0].kind, "html_link_absent");
    assert.equal(result.receipt.alerts[0].scope, "fetched_html");
    assert.equal(result.state, "finished");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
