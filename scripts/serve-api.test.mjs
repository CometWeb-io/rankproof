import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("standalone API health and authentication", { timeout: 20_000 }, async () => {
  const project = fileURLToPath(new URL("../", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-strip-types",
      "scripts/serve-api.mjs",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
    ],
    {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RANKPROOF_API_TOKEN: "synthetic-integration-token" },
    },
  );
  let log = "";
  try {
    const origin = await new Promise((resolve, reject) => {
      const onTimeout = () => reject(new Error("API startup timeout: " + log));
      const timeout = setTimeout(onTimeout, 12_000);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error("API exited " + code + ": " + log)));
      child.stderr.on("data", (chunk) => {
        log += chunk.toString();
      });
      child.stdout.on("data", (chunk) => {
        log += chunk.toString();
        const match = log.match(/RankProof API: (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });
    });

    const post = (path, token, body) =>
      fetch(origin + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: "Bearer " + token } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });

    const health = await fetch(origin + "/health");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const unauthorized = await post("/scan", null, { url: "" });
    assert.equal(unauthorized.status, 401);

    const invalid = await post("/scan", "synthetic-integration-token", { url: "" });
    assert.equal(invalid.status, 400);

    const excessive = await post("/serp", "synthetic-integration-token", {
      url: "example.com",
      keywords: Array(11).fill("seo keyword"),
    });
    assert.equal(excessive.status, 400);

    const wrongMethod = await fetch(origin + "/nonexistent", {
      headers: { authorization: "Bearer synthetic-integration-token" },
    });
    assert.equal(wrongMethod.status, 405);
  } finally {
    child.kill("SIGTERM");
  }
});
