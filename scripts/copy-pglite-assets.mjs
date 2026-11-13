#!/usr/bin/env node
// @ts-check
/**
 * The server bundle inlines @electric-sql/pglite but not the files it loads
 * next to itself at runtime (`new URL("pglite.data", import.meta.url)`), so a
 * built app without DATABASE_URL crashed on its first query. Copy them beside
 * every bundled copy of the module. No-op when the output has no PGLite.
 */
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const ASSETS = ["pglite.data", "pglite.wasm", "initdb.wasm"];

/** @param {string} dir @returns {string[]} directories holding a bundled PGLite */
export function findPgliteBundles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...findPgliteBundles(path));
    else if (/pglite.*\.m?js$/i.test(entry)) out.push(dir);
  }
  return [...new Set(out)];
}

export function copyPgliteAssets(outputDir = ".vercel/output") {
  const source = dirname(createRequire(import.meta.url).resolve("@electric-sql/pglite"));
  const targets = findPgliteBundles(outputDir);
  for (const target of targets) {
    for (const asset of ASSETS) {
      const from = join(source, asset);
      if (existsSync(from)) copyFileSync(from, join(target, asset));
    }
  }
  return targets;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const targets = copyPgliteAssets(process.argv[2]);
  console.log(
    targets.length
      ? `[pglite] copied ${ASSETS.join(", ")} to ${targets.join(", ")}`
      : "[pglite] no bundled PGLite in the output — nothing to copy",
  );
}
