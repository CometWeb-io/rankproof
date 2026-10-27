#!/usr/bin/env node
/** Offline holdout evaluation with exclusive, local single-use receipts. */
import { mkdir, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  evaluateCalibrationStudy,
  freezeCalibrationHoldout,
} from "../src/lib/backlinks/calibration.ts";
import { CALIBRATION_STUDY_SCHEMA } from "../src/lib/backlinks/calibration-schema.ts";

async function readJson(file) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    if (bytes > 45000000) throw new Error("Calibration input exceeds 45 MB.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

try {
  const [command, inputFile, frozenFile, actor, extra] = process.argv.slice(2);
  if (command === "schema" && !inputFile)
    process.stdout.write(`${JSON.stringify(CALIBRATION_STUDY_SCHEMA, null, 2)}\n`);
  else if (command === "freeze" && inputFile && frozenFile && actor && !extra) {
    const lock = freezeCalibrationHoldout(await readJson(inputFile), actor);
    await writeFile(frozenFile, `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(
      `${JSON.stringify({ frozen: frozenFile, datasetHash: lock.datasetHash, tuningDatasetHash: lock.tuningDatasetHash })}\n`,
    );
  } else if (command === "evaluate" && inputFile && frozenFile && !actor) {
    const report = evaluateCalibrationStudy(await readJson(inputFile), await readJson(frozenFile));
    const receiptDirectory = join(dirname(resolve(frozenFile)), ".rankproof-calibration-receipts");
    await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
    // Source-content identity survives renamed manifest files, datasets and case IDs.
    const contentSetHash = createHash("sha256")
      .update(JSON.stringify(report.holdout.contentHashes))
      .digest("hex");
    const receiptFile = join(receiptDirectory, `${contentSetHash}.json`);
    // Exclusive creation prevents concurrent evaluations from publishing two outcomes.
    await writeFile(
      receiptFile,
      `${JSON.stringify({ evaluatedAt: new Date().toISOString(), ...report }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    process.stdout.write(`${JSON.stringify({ ...report, receiptFile }, null, 2)}\n`);
  } else
    throw new Error(
      "Usage: calibration.mjs schema | freeze <partitions.json> <holdout.lock.json> <actor> | evaluate <study.json> <holdout.lock.json>",
    );
} catch (error) {
  process.stderr.write(
    `${error?.code === "EEXIST" ? "Frozen manifest or single-use evaluation receipt already exists; overwrite/reuse is refused." : error instanceof Error ? error.message : "Calibration failed."}\n`,
  );
  process.exitCode = 1;
}
