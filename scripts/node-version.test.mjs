import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  doctorExitCode,
  meetsMinNodeVersion,
  nodeMajorVersion,
  nodeVersionError,
} from "./node-version.mjs";

test("nodeMajorVersion parses process.version strings", () => {
  assert.equal(nodeMajorVersion("v22.11.0"), 22);
  assert.equal(nodeMajorVersion("v20.18.1"), 20);
  assert.equal(nodeMajorVersion("22.0.0"), 22);
  assert.equal(nodeMajorVersion("garbage"), 0);
});

test("meetsMinNodeVersion requires Node 22+", () => {
  assert.equal(meetsMinNodeVersion("v22.0.0"), true);
  assert.equal(meetsMinNodeVersion("v23.1.0"), true);
  assert.equal(meetsMinNodeVersion("v20.11.0"), false);
  assert.equal(meetsMinNodeVersion("v18.20.0"), false);
});

test("nodeVersionError names the floor clearly", () => {
  assert.equal(nodeVersionError("v22.3.0"), null);
  assert.match(nodeVersionError("v20.11.0") ?? "", /needs Node\.js 22\+/);
  assert.match(nodeVersionError("v20.11.0") ?? "", /found v20\.11\.0/);
});

test("doctorExitCode matches HTTP /doctor (503 when unhealthy)", () => {
  assert.equal(doctorExitCode(true), 0);
  assert.equal(doctorExitCode(false), 1);
});

test("CLI script imports are listed in the published package files", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const bin = readFileSync(join(root, "bin/rankproof.mjs"), "utf8");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const imported = [...bin.matchAll(/["']\.\.\/(scripts\/[^"']+)["']/g)].map((match) => match[1]);
  assert.ok(imported.includes("scripts/node-version.mjs"));
  for (const relativePath of imported) {
    assert.ok(
      pkg.files.includes(relativePath),
      `${relativePath} is imported by bin/rankproof.mjs but missing from package.json files`,
    );
  }
});
