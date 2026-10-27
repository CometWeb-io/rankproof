#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { renderedPolicy, compareRenderedSnapshots } from "../src/lib/backlinks/rendered-policy.ts";
import { buildTechnicalGraph } from "../src/lib/backlinks/technical-graph.ts";
import { buildCompetitiveIntelligence } from "../src/lib/backlinks/competitive-intelligence.ts";
import { buildEvidenceDecisions } from "../src/lib/backlinks/decision-engine.ts";
import { replayCitationDataset } from "../src/lib/backlinks/citation-lab.ts";

const commands = {
  "render-policy": renderedPolicy,
  "render-compare": compareRenderedSnapshots,
  graph: buildTechnicalGraph,
  competitive: buildCompetitiveIntelligence,
  decisions: buildEvidenceDecisions,
  citations: replayCitationDataset,
};

try {
  const [command, file, extra] = process.argv.slice(2);
  if (!Object.hasOwn(commands, command) || !file || extra) {
    throw new Error(
      "Usage: node --experimental-strip-types scripts/intelligence-replay.mjs <render-policy|render-compare|graph|competitive|decisions|citations> <input.json>",
    );
  }
  const bytes = await readFile(file);
  if (bytes.length > 25_000_000) throw new Error("Input exceeds the 25 MB limit.");
  const result = commands[command](JSON.parse(bytes.toString("utf8")));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Intelligence replay failed."}\n`,
  );
  process.exitCode = 1;
}
