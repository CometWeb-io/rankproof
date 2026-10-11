/**
 * Lightweight in-process admission control for TanStack server functions.
 * The standalone JSON API has its own gate; both prevent free scanners from
 * allocating arbitrarily many concurrent network-heavy jobs.
 */
export function createScanCapacity(maxActive: number) {
  let active = 0;
  return {
    acquire(): (() => void) | null {
      if (active >= maxActive) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
    get active() {
      return active;
    },
  };
}

const globalRef = globalThis as typeof globalThis & {
  __rankproofWebCapacity__?: ReturnType<typeof createScanCapacity>;
};
const configured = Number(process.env.RANKPROOF_WEB_MAX_ACTIVE_SCANS ?? 2);
const maxActive = Number.isSafeInteger(configured) ? Math.min(8, Math.max(1, configured)) : 2;
const shared = (globalRef.__rankproofWebCapacity__ ??= createScanCapacity(maxActive));

export async function withScanCapacity<T>(operation: () => Promise<T>): Promise<T> {
  const release = shared.acquire();
  if (!release) {
    throw new Error("RankProof is handling too many scans. Try again later.");
  }
  try {
    return await operation();
  } finally {
    release();
  }
}
