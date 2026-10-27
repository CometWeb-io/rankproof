import { AsyncLocalStorage } from "node:async_hooks";
import type { ScanQueue, ScanLease } from "./scan-queue.server.ts";
import type { TenantScope } from "./tenant-scope.ts";

type RequestContext = {
  queue: ScanQueue;
  scope: TenantScope;
  lease: ScanLease;
  requests: number;
  bytes: number;
  responses: number;
  expiresAt?: number;
};
const context = new AsyncLocalStorage<RequestContext>();

/** Bind once at the actual network attempt, after DNS checks and immediately before I/O. */
export function reserveScanQueueRequest(url: string): void {
  const active = context.getStore();
  if (!active) return;
  if (active.expiresAt !== undefined && Date.now() >= active.expiresAt)
    throw new Error("Scan operator grant expired.");
  active.queue.reserveRequest(active.scope, active.lease, url);
  active.requests += 1;
}

/** Decoded response bytes, not wire bytes; call once after reading each response (also redirects). */
export function recordScanQueueResponse(bytes: number): void {
  const active = context.getStore();
  if (!active) return;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid response byte count.");
  active.bytes += bytes;
  active.responses += 1;
}

export async function withScanQueueRequests<T>(
  queue: ScanQueue,
  scope: TenantScope,
  lease: ScanLease,
  operation: () => Promise<T>,
  expiresAt?: number,
): Promise<{ result: T; requests: number; bytes: number | null }> {
  const active: RequestContext = {
    queue,
    scope,
    lease,
    requests: 0,
    responses: 0,
    bytes: 0,
    expiresAt,
  };
  return context.run(active, async () => ({
    result: await operation(),
    requests: active.requests,
    bytes: active.responses === active.requests ? active.bytes : null,
  }));
}
