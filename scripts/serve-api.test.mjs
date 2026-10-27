import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

for (const [name, env, message] of [
  ["missing authentication", { RANKPROOF_API_TOKEN: "" }, /requires RANKPROOF_API_TOKEN/],
  [
    "unsafe DNS override",
    { RANKPROOF_API_TOKEN: "fixture", RANKPROOF_PIN_DNS: "0" },
    /refuses unsafe/,
  ],
]) {
  test(`public API refuses ${name} before opening a listener`, () => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/serve-api.mjs", "--host", "0.0.0.0", "--port", "0"],
      {
        cwd: new URL("../", import.meta.url),
        env: { ...process.env, ...env },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stdout, /RankProof API:/);
  });
}
