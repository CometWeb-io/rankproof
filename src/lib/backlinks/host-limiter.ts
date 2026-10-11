/**
 * Bounded per-host network admission. Queue waiters are cancellable and
 * transport slots remain occupied until the response body has been released.
 */
export function createHostLimiter(perHost: number, maxQueue = 64) {
  type Waiter = {
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    detach: () => void;
  };
  const active = new Map<string, number>();
  const queues = new Map<string, Waiter[]>();

  function releaseSlot(host: string): void {
    const waiting = queues.get(host);
    const next = waiting?.shift();
    if (next) {
      if (waiting?.length === 0) queues.delete(host);
      next.detach();
      next.resolve(createRelease(host));
      return;
    }
    const count = active.get(host) ?? 1;
    if (count <= 1) active.delete(host);
    else active.set(host, count - 1);
  }

  function createRelease(host: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseSlot(host);
    };
  }

  return async function acquire(host: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("Host request aborted.");
    const count = active.get(host) ?? 0;
    if (count < perHost && !queues.has(host)) {
      active.set(host, count + 1);
      return createRelease(host);
    }
    const waiting = queues.get(host) ?? [];
    if (waiting.length >= maxQueue) throw new Error("Host request queue is full.");
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const queue = queues.get(host);
        if (queue) {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          if (queue.length === 0) queues.delete(host);
        }
        reject(new Error("Host request aborted."));
      };
      const waiter: Waiter = {
        resolve,
        reject,
        detach: () => signal?.removeEventListener("abort", onAbort),
      };
      waiting.push(waiter);
      queues.set(host, waiting);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  };
}

/** A transport needs both one per-host slot and a global network slot. */
export function createTransportCapacity(perHost: number, globalMax: number) {
  const hostGate = createHostLimiter(perHost);
  const globalGate = createHostLimiter(globalMax);
  return async (host: string, signal?: AbortSignal): Promise<() => void> => {
    const releaseHost = await hostGate(host, signal);
    try {
      const releaseGlobal = await globalGate("all", signal);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseGlobal();
        releaseHost();
      };
    } catch (error) {
      releaseHost();
      throw error;
    }
  };
}
