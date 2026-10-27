import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("CLI captures private compact evidence, replays offline and never overwrites an existing file", () => {
  const directory = mkdtempSync(join(tmpdir(), "rankproof-private-capture-cli-"));
  const pairs = join(directory, "pairs.json");
  const output = join(directory, "capture.json");
  const marker = join(directory, "network-called");
  writeFileSync(
    pairs,
    JSON.stringify({
      items: [
        {
          source_url: "https://publisher.example/article",
          target_url: "https://brand.example/offer",
        },
      ],
    }),
  );
  const net = new URL("../src/lib/backlinks/net.server.ts", import.meta.url).href;
  const preload = `import {setHostResolverForTests} from ${JSON.stringify(net)};
import {appendFileSync} from 'node:fs';
setHostResolverForTests(async()=>['93.184.216.34']);
globalThis.fetch=async(input)=>{appendFileSync(${JSON.stringify(marker)},'request\\n');if(String(input).endsWith('/robots.txt'))return new Response('',{status:404});return new Response('<html><body><a href="https://brand.example/offer">Źródło</a></body></html>',{headers:{'content-type':'text/html'}})};`;
  const run = (args) =>
    spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        "bin/rankproof.mjs",
        ...args,
      ],
      { cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 10000 },
    );
  try {
    const first = run(["capture", pairs, "--out", output, "--quiet"]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, "");
    const body = readFileSync(output, "utf8");
    const captured = JSON.parse(body);
    assert.equal(captured.total_bytes, Buffer.byteLength(body));
    assert.equal(captured.entries[0].observation.status, "confirmed");
    if (process.platform !== "win32") assert.equal(statSync(output).mode & 0o077, 0);
    unlinkSync(marker);
    const second = run(["capture", pairs, "--out", output]);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already exists/);
    assert.equal(readFileSync(output, "utf8"), body);
    assert.equal(existsSync(marker), false);
    const replay = run(["replay", output]);
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(JSON.parse(replay.stdout).results[0].status, "confirmed");
    assert.equal(existsSync(marker), false);
    captured.entries[0].response.text = "<html><body>Changed HTML</body></html>";
    writeFileSync(output, JSON.stringify(captured));
    const corrupted = run(["replay", output]);
    assert.equal(corrupted.status, 1);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
