#!/usr/bin/env node
// Regenerates contract/fixtures from the current engine. Review the diff:
// any change here is an API change for every consumer.
import { spawnSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (!process.execArgv.includes("--experimental-strip-types")) {
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)],
    { stdio: "inherit" },
  );
  process.exit(child.status ?? 1);
}
const { contractFixtures } = await import("../src/lib/backlinks/contract-fixtures.ts");
const dir = new URL("../contract/fixtures/", import.meta.url);
await mkdir(dir, { recursive: true });
for (const [name, value] of Object.entries(contractFixtures())) {
  await writeFile(new URL(name, dir), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote contract/fixtures/${name}`);
}
