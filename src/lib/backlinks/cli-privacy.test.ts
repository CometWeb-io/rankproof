import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "./cli.ts";

test("private webmaster data requires explicit local scan opt-in", () => {
  assert.equal(parseArgs(["scan", "example.com"]).includeWebmaster, false);
  assert.equal(parseArgs(["scan", "example.com", "--webmaster"]).includeWebmaster, true);
  assert.match(parseArgs(["gap", "example.com", "rival.com", "--webmaster"]).error ?? "", /scan/);
  assert.match(parseArgs(["doctor", "--webmaster"]).error ?? "", /scan/);
});

test("scan profiles are explicit and reject misspellings", () => {
  assert.equal(parseArgs(["scan", "example.com", "--profile", "quick"]).profile, "quick");
  assert.equal(parseArgs(["scan", "example.com", "--profile=deep"]).profile, "deep");
  assert.equal(parseArgs(["scan", "example.com"]).profile, undefined);
  assert.match(parseArgs(["scan", "example.com", "--profile", "unbounded"]).error ?? "", /profile/);
  assert.match(parseArgs(["doctor", "--profile", "quick"]).error ?? "", /scan/);
});

test("offline evidence commands accept paths and enforce JSON output", () => {
  for (const command of ["analyze", "citations", "ledger", "replay"]) {
    const options = parseArgs([command, "/tmp/report with spaces.json"]);
    assert.equal(options.command, command);
    assert.equal(options.target, "/tmp/report with spaces.json");
    assert.equal(options.error, undefined);
    assert.match(parseArgs([command, "report.json", "--format", "csv"]).error ?? "", /JSON/);
  }
});

test("capture requires an explicit output path and rejects publication formats", () => {
  assert.match(parseArgs(["capture", "pairs.json"]).error ?? "", /--out/);
  assert.equal(parseArgs(["capture", "pairs.json", "--out", "private.json"]).error, undefined);
  assert.match(
    parseArgs(["capture", "pairs.json", "--out", "private.json", "--format", "html"]).error ?? "",
    /JSON/,
  );
  assert.match(parseArgs(["replay"]).error ?? "", /JSON file/);
  assert.match(parseArgs(["render", "runtime.json"]).error ?? "", /--out/);
  assert.equal(parseArgs(["render", "runtime.json", "--out", "private-dom.json"]).error, undefined);
});

test("technical graph exports require a file and permit JSON or repair CSV", () => {
  assert.match(parseArgs(["graph"]).error ?? "", /input JSON/);
  assert.equal(parseArgs(["graph", "report.json"]).error, undefined);
  assert.equal(parseArgs(["graph", "report.json", "--format", "csv"]).error, undefined);
  assert.match(parseArgs(["graph", "report.json", "--format", "html"]).error ?? "", /JSON/);
});
