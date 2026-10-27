#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { analyzeScanReport } from "../src/lib/backlinks/decision-engine.ts";

try {
  const [file, extra] = process.argv.slice(2);
  if (!file || extra)
    throw new Error(
      "Usage: node --experimental-strip-types scripts/intelligence-report.mjs <scan-export.json>",
    );
  const bytes = await readFile(file);
  if (bytes.length > 25_000_000) throw new Error("Scan export exceeds the 25 MB limit.");
  process.stdout.write(
    `${JSON.stringify(analyzeScanReport(JSON.parse(bytes.toString("utf8"))), null, 2)}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Scan analysis failed."}\n`);
  process.exitCode = 1;
}
