import { createHash, timingSafeEqual } from "node:crypto";

/** Refuse invalid or unbounded operator-configured limits. */
export function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
}

/** Fixed-window limiter with bounded memory even under many distinct IPs. */
export function createRateLimiter(maxRequests, windowMs, maxClients = 4096) {
  const hits = new Map();
  return (client) => {
    const now = Date.now();
    const old = hits.get(client);
    if (old && now < old.reset) {
      if (old.count >= maxRequests) return false;
      old.count++;
      return true;
    }
    if (!old && hits.size >= maxClients) {
      for (const [key, entry] of hits) {
        if (now >= entry.reset) hits.delete(key);
      }
      if (hits.size >= maxClients) return false;
    }
    hits.set(client, { count: 1, reset: now + windowMs });
    return true;
  };
}

/** Cap expensive scans regardless of requests-per-minute limits. */
export function createConcurrencyGate(maxActive) {
  let active = 0;
  return () => {
    if (active >= maxActive) return null;
    active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
    };
  };
}

/** Shared secret for directly exposed instances; accepts Bearer only. */
export function validBearer(header, secret) {
  if (!secret) return true;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const actual = header.slice(7);
  const expectedHash = createHash("sha256").update(secret).digest();
  const actualHash = createHash("sha256").update(actual).digest();
  return timingSafeEqual(expectedHash, actualHash);
}

/** Publicly bound instances must pin outbound DNS, even in development mode. */
export function isExternallyBound(host) {
  return !["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.toLowerCase());
}
