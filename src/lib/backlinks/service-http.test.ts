import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";

// Exercise the actual standalone entry point; malformed inputs must never
// cause crawler I/O. Successful fetch/parse cases use hermetic unit fixtures.
test("standalone API advertises its contract, enforces auth, validates bounded JSON", async () => {
  const netModule = new URL("./net.server.ts", import.meta.url).href;
  const preload = `import { setHostResolverForTests } from ${JSON.stringify(netModule)};
    setHostResolverForTests(async () => ["93.184.216.34"]);
    globalThis.fetch = async (input) => String(input).endsWith("/robots.txt")
      ? new Response("", {status: 404})
      : new Response("<html><body>Article content without this target.</body></html>", {headers: {"content-type": "text/html"}});`;
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
      "scripts/serve-api.mjs",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
    ],
    {
      env: {
        ...process.env,
        RANKPROOF_API_TOKEN: "fixture-service-token",
        RANKPROOF_SERVICE_REVISION: "fixture-revision",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += String(data);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`API exited before listening: ${stderr}`)));
      child.stdout.on("data", (data) => {
        const match = /RankProof API: (http:\/\/127\.0\.0\.1:\d+)/.exec(String(data));
        if (match) resolve(match[1]!);
      });
    });
    const health = await fetch(`${endpoint}/health`);
    assert.equal(health.status, 200);
    const info = await health.json();
    assert.equal(info.service, "rankproof");
    assert.equal(info.schema_version, "1");
    assert.equal(info.revision, "fixture-revision");
    assert.ok(info.capabilities.includes("backlinks.verify.v1"));
    const url = `${endpoint}/v1/backlinks/verify`;
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
    const headers = {
      Authorization: "Bearer fixture-service-token",
      "content-type": "application/json",
    };
    for (const payload of [
      "null",
      "[]",
      "{broken",
      JSON.stringify({ items: [] }),
      JSON.stringify({
        items: Array(51).fill({
          source_url: "https://source.example/",
          target_url: "https://target.example/",
        }),
      }),
      JSON.stringify({
        items: [{ source_url: "http://127.0.0.1/secret", target_url: "https://target.example/" }],
      }),
      JSON.stringify({ overflow: "x".repeat(65_000) }),
    ]) {
      const response = await fetch(url, { method: "POST", headers, body: payload });
      assert.equal(response.status, 400, payload.slice(0, 80));
      assert.equal((await response.json()).ok, false);
    }
    const item = {
      source_url: "https://Source.example:443/zażółć?q=łódź%2f#sekcja",
      target_url: "https://Target.example:443/oferta?ref=żółw%2f",
    };
    const observed = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ items: [item] }),
    });
    assert.equal(observed.status, 200);
    const observation = (await observed.json()).results[0];
    assert.equal(observation.source_url, item.source_url);
    assert.equal(observation.target_url, item.target_url);
    assert.equal(observation.status, "not_found");
    assert.equal((await fetch(url, { headers })).status, 405);
  } finally {
    clearTimeout(timeout);
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await exited;
  }
});
