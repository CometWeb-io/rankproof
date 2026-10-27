/** Render jobs inherit this boundary through robots and every redirect hop. */
import { guardUrl } from "./ssrf.ts";
import { AsyncLocalStorage } from "node:async_hooks";

type Boundary = {
  requests: number;
  bytes: number;
  reserved: number;
  responses: number;
  maxRequests: number;
  maxBytes: number;
  scope: "fixtures" | "public";
};
const active = new AsyncLocalStorage<Boundary>();
export const renderedTransportActive = () => active.getStore() !== undefined;
export function assertRenderedUrl(url: string): void {
  const state = active.getStore();
  if (!state) return;
  if (state.scope === "public") {
    if (!guardUrl(url).allowed) throw new Error("Renderer admits public HTTP(S) URLs only.");
    return;
  }
  const parsed = new URL(url);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname.endsWith(".example") ||
    parsed.username ||
    parsed.password
  )
    throw new Error("Compatibility renderer permits authored .example resources only.");
}

export function reserveRenderedRequest(): void {
  const state = active.getStore();
  if (!state) return;
  if (state.requests >= state.maxRequests || state.bytes >= state.maxBytes)
    throw new Error("Renderer network budget exhausted.");
  state.requests++;
}
export function renderedResponseLimit(maxBytes: number): number {
  const state = active.getStore();
  return state
    ? Math.min(maxBytes, Math.max(1, state.maxBytes - state.bytes - state.reserved))
    : maxBytes;
}
/** Reserve the complete bounded response before I/O; unknown failures retain the charge. */
export function holdRenderedResponse(maxBytes: number) {
  const state = active.getStore();
  if (!state) return { limit: maxBytes, complete(_bytes: number) {}, fail() {} };
  const remaining = state.maxBytes - state.bytes - state.reserved;
  if (remaining <= 0) throw new Error("Renderer response budget exhausted.");
  const limit = Math.min(maxBytes, remaining);
  state.reserved += limit;
  let settled = false;
  return {
    limit,
    complete(bytes: number) {
      if (settled) return;
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit)
        throw new Error("Invalid renderer response byte count.");
      settled = true;
      state.reserved -= limit;
      state.bytes += bytes;
      state.responses++;
    },
    fail() {
      if (settled) return;
      settled = true;
      state.reserved -= limit;
      state.bytes += limit;
    },
  };
}
export function recordRenderedResponse(bytes: number): void {
  const state = active.getStore();
  if (!state) return;
  state.bytes += bytes;
  state.responses++;
  if (state.bytes > state.maxBytes) throw new Error("Renderer response budget exhausted.");
}
export function withRenderedTransport<T>(
  limits: { requests: number; bytes: number; scope?: "fixtures" | "public" },
  operation: () => Promise<T>,
) {
  const state: Boundary = {
    requests: 0,
    bytes: 0,
    reserved: 0,
    responses: 0,
    maxRequests: limits.requests,
    maxBytes: limits.bytes,
    scope: limits.scope ?? "fixtures",
  };
  return active.run(state, async () => ({
    result: await operation(),
    requests: state.requests,
    bytes: state.responses === state.requests ? state.bytes : null,
    budgetedBytes: state.bytes + state.reserved,
  }));
}
