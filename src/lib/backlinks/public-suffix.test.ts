import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { registeredDomain } from "./public-suffix.ts";

const official = readFileSync(
  new URL("./fixtures/public-suffix-official.txt", import.meta.url),
  "utf8",
);

/**
 * Public Suffix List upstream conformance cases (public-domain test vectors).
 * The library returns IDN results as WHATWG ASCII/punycode, so expectations
 * from Unicode test vectors are normalized to the same representation.
 */
test("registrable domain conforms to official Public Suffix List test cases", () => {
  let count = 0;
  for (const line of official.split("\n")) {
    if (!line.startsWith("checkPublicSuffix(")) continue;
    const match = line.match(/^checkPublicSuffix\((null|'([^']*)'),\s*(null|'([^']*)')\);/);
    assert.ok(match, "Malformed official PSL vector: " + line);
    const input = match[1] === "null" ? null : match[2];
    const expected = match[3] === "null" ? "" : new URL("https://" + match[4]).hostname;
    assert.equal(registeredDomain(input as string), expected, line);
    count += 1;
  }
  assert.ok(count >= 60, "The official suite must contain substantial coverage");
});
