#!/usr/bin/env node
/**
 * Opt-in local update of the MPL-2.0 Public Suffix List.
 * No CI job or daemon. Uses only Node 22 and the official PSL endpoint.
 */
import { writeFile } from "node:fs/promises";

const url = "https://publicsuffix.org/list/public_suffix_list.dat";
const result = await fetch(url, { signal: AbortSignal.timeout(15_000) });
if (!result.ok) throw new Error(`PSL download failed: ${result.status}`);
const text = await result.text();
if (text.length > 1_000_000 || !text.includes("===BEGIN PRIVATE DOMAINS===")) {
  throw new Error("PSL structure/size validation failed");
}
const groups = { icann: [], private: [] };
let group = "icann";
for (const line of text.split(/\r?\n/)) {
  const rule = line.trim();
  if (rule.includes("===BEGIN PRIVATE DOMAINS===")) {
    group = "private";
    continue;
  }
  if (rule.includes("===END PRIVATE DOMAINS===")) break;
  if (!rule || rule.startsWith("//")) continue;
  if (!/^[^\s`$]+$/.test(rule)) throw new Error("Invalid PSL rule");
  groups[group].push(rule);
}
if (groups.icann.length < 5_000 || groups.private.length < 1_000) {
  throw new Error("Unexpectedly small PSL response");
}
const out = [
  "// Generated from the Public Suffix List (MPL-2.0).",
  "// Source: https://publicsuffix.org/list/public_suffix_list.dat",
  `// Generated manually at: ${new Date().toISOString().slice(0, 10)}`,
  "// This data includes ICANN and PRIVATE sections, including wildcard/exception rules.",
  '// Edit via "npm run psl:update", not manually. Source data license: MPL-2.0.',
  "export const ICANN_RULES = `",
  ...groups.icann,
  "`;",
  "export const PRIVATE_RULES = `",
  ...groups.private,
  "`;",
  "",
].join("\n");
await writeFile(new URL("../src/lib/backlinks/public-suffix-data.ts", import.meta.url), out, "utf8");
console.log(`PSL updated: ${groups.icann.length} ICANN + ${groups.private.length} private rules`);
