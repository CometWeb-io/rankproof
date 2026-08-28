/**
 * Loads a `.env` file into `process.env`.
 *
 * README and `.env.example` both tell people to copy `.env.example` to `.env`,
 * so something has to read it. This does, at the three entry points that own a
 * process: the CLI, the HTTP API and the wrapper `dev`/`build`/`preview` run
 * through. There is no dependency involved — `util.parseEnv` is built into the
 * Node version this project already requires.
 *
 * A variable already present in the environment always wins, so
 * `RANKPROOF_MARKET=us npm run cli -- scan example.com` still overrides the
 * file, and a deployed build keeps using the platform's own configuration.
 */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import process from "node:process";

/** Returns the names of the variables that were actually applied. */
export function loadDotEnv(path = ".env") {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return []; // No .env is the normal case, not an error.
  }

  const applied = [];
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (typeof value !== "string") continue;
    if (process.env[key] !== undefined) continue; // Explicit env wins.
    process.env[key] = value;
    applied.push(key);
  }
  return applied;
}
