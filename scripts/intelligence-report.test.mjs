import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("graph CLI exports every retained repair URL and refuses legacy graph-less reports", () => {
  const dir = mkdtempSync(join(tmpdir(), "rankproof-graph-cli-"));
  try {
    const input = join(dir, "report with spaces.json");
    const graph = {
      schemaVersion: 2,
      issues: [],
      orphanCandidates: [],
      repairTargets: Array.from({ length: 150 }, (_, i) => ({
        kind: "orphan-candidate",
        url: `https://site.example/page/${i}`,
        relatedUrls: [],
        evidenceRefs: ["inventory:fixture"],
        certainty: "inventory-not-reached",
      })),
    };
    const report = {
      version: 8,
      queriedAt: "2026-10-27T00:00:00.000Z",
      target: { url: "https://site.example/" },
      backlinks: [],
      siteAudit: { issues: [], technicalGraph: graph },
      plan: { items: [] },
    };
    writeFileSync(input, JSON.stringify({ ok: true, report }));
    const run = (...args) =>
      execFileSync(
        process.execPath,
        [new URL("../bin/rankproof.mjs", import.meta.url).pathname, "graph", input, ...args],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    const json = JSON.parse(run());
    assert.equal(json.technicalGraph.repairTargets.length, 150);
    assert.equal(json.source.target, "https://site.example/");
    const csv = run("--format", "csv");
    assert.equal(csv.trim().split("\n").length, 151);
    assert.match(csv, /https:\/\/site.example\/page\/149/);
    assert.match(csv, /inventory-not-reached/);
    report.siteAudit = null;
    writeFileSync(input, JSON.stringify(report));
    assert.throws(() => run(), /no current technical graph/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("intelligence script consumes an existing scan-export envelope and fails on invalid JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "rankproof-intelligence-"));
  try {
    const input = join(dir, "scan.json");
    writeFileSync(
      input,
      JSON.stringify({
        ok: true,
        report: {
          version: 8,
          queriedAt: "2026-10-27T10:00:00Z",
          target: { url: "https://site.example/" },
          backlinks: [],
          siteAudit: null,
          plan: { items: [] },
        },
      }),
    );
    const output = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        new URL("./intelligence-report.mjs", import.meta.url).pathname,
        input,
      ],
      { encoding: "utf8" },
    );
    const result = JSON.parse(output);
    assert.equal(result.rendering.status, "unavailable");
    assert.equal(result.source.target, "https://site.example/");
    const main = execFileSync(
      process.execPath,
      [new URL("../bin/rankproof.mjs", import.meta.url).pathname, "analyze", input],
      { encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(main), result);
    writeFileSync(input, "not json");
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          new URL("./intelligence-report.mjs", import.meta.url).pathname,
          input,
        ],
        { stdio: "pipe" },
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("intelligence replay command emits the fail-closed renderer contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "rankproof-intelligence-"));
  try {
    const input = join(dir, "url.json");
    writeFileSync(input, JSON.stringify("https://site.example/"));
    const output = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        new URL("./intelligence-replay.mjs", import.meta.url).pathname,
        "render-policy",
        input,
      ],
      { encoding: "utf8" },
    );
    assert.equal(JSON.parse(output).networkPolicy, "deny_all");
    writeFileSync(
      input,
      JSON.stringify({
        schemaVersion: 1,
        prompts: [{ id: "p1", version: "1", text: "Synthetic adapter check", systemPrompt: "" }],
        samples: [],
      }),
    );
    const main = execFileSync(
      process.execPath,
      [new URL("../bin/rankproof.mjs", import.meta.url).pathname, "citations", input],
      { encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(main).summaries, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
