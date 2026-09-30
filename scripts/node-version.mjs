/**
 * Pure Node version gate used by the CLI entry before --experimental-strip-types.
 * Kept as plain ESM so it can be unit-tested on any Node that can run .mjs.
 */

/** @param {string} version  process.version style, e.g. "v20.11.0" */
export function nodeMajorVersion(version) {
  const match = String(version).match(/^v?(\d+)/);
  return match ? Number(match[1]) : 0;
}

/** @param {string} version @param {number} [minMajor=22] */
export function meetsMinNodeVersion(version, minMajor = 22) {
  return nodeMajorVersion(version) >= minMajor;
}

/**
 * @param {string} version
 * @param {number} [minMajor=22]
 * @returns {string | null} error message when too old, otherwise null
 */
export function nodeVersionError(version, minMajor = 22) {
  if (meetsMinNodeVersion(version, minMajor)) return null;
  return `RankProof needs Node.js ${minMajor}+ (found ${version}). Upgrade Node or use a newer runtime.`;
}

/** Exit code for `doctor` when canary health is known — matches HTTP /doctor (503 when down). */
export function doctorExitCode(healthy) {
  return healthy ? 0 : 1;
}
