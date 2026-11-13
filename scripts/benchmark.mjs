#!/usr/bin/env node
// Offline extractor benchmark: `npm run benchmark [-- --json] [--render]`. Exit 1 on any failure.
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (!process.execArgv.includes("--experimental-strip-types")) {
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: "inherit" },
  );
  process.exit(child.status ?? 1);
}

const { runBenchmark, benchmarkText, runRenderedBenchmark, renderedBenchmarkText } =
  await import("../src/lib/backlinks/benchmark.ts");
const json = process.argv.includes("--json");
const corpusFlag = process.argv.indexOf("--corpus");
let cases;
if (corpusFlag !== -1) {
  const { readFile } = await import("node:fs/promises");
  const { loadCorpus } = await import("../src/lib/backlinks/corpus.server.ts");
  const path = process.argv[corpusFlag + 1];
  if (!path) throw new Error("--corpus needs a file from `rankproof corpus`.");
  const loaded = loadCorpus(JSON.parse(await readFile(path, "utf8")));
  cases = loaded.scored;
  if (!json) {
    console.log(
      `Corpus ${path}: ${loaded.scored.length} reviewed case(s) scored, ${loaded.unreviewed} not yet reviewed (ignored).\n`,
    );
  }
  if (cases.length === 0) process.exit(0);
}
const report = runBenchmark(cases);
const rendered = process.argv.includes("--render") ? await runRenderedBenchmark(cases) : null;
if (json) {
  console.log(JSON.stringify(rendered ? { ...report, rendered } : report, null, 2));
} else {
  console.log(benchmarkText(report));
  if (rendered) console.log(`\n${renderedBenchmarkText(rendered)}`);
}
if (report.passed !== report.scored) process.exitCode = 1;
if (rendered && rendered.passed !== rendered.scored) process.exitCode = 1;
