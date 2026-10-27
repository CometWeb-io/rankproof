/** node:sqlite was unflagged in Node 22.13 and 23.4. Base CLI does not import this feature. */
export function assertScanQueueRuntime(version = process.versions.node): void {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  if (!match || major < 22 || (major === 22 && minor < 13) || (major === 23 && minor < 4)) {
    throw new Error(
      "Optional platform queue requires Node >=22.13 (or >=23.4 on Node 23) with node:sqlite available.",
    );
  }
}
