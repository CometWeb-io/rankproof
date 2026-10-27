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

/** Reject unbounded or malformed scanner workloads before allocating a slot. */
export function validateApiBody(endpoint, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  const data = value;
  const textField = (key, min, max) => {
    const item = data[key];
    if (typeof item !== "string" || item.trim().length < min || item.length > max) {
      throw new Error(`Invalid ${key}: expected a string of ${min}–${max} characters.`);
    }
    return item.trim();
  };
  const listField = (key, limit, min, max) => {
    const items = data[key];
    if (!Array.isArray(items) || items.length < 1 || items.length > limit) {
      throw new Error(`Invalid ${key}: expected 1–${limit} entries.`);
    }
    return items.map((item) => {
      if (typeof item !== "string" || item.trim().length < min || item.length > max) {
        throw new Error(`Invalid ${key} entry.`);
      }
      return item.trim();
    });
  };
  const options = {};
  if (data.market !== undefined) {
    if (!["pl", "us", "gb", "de", "fr", "es"].includes(data.market)) {
      throw new Error("Unknown market.");
    }
    options.market = data.market;
  }
  if (data.device !== undefined) {
    if (!["desktop", "mobile"].includes(data.device)) {
      throw new Error("Unknown device.");
    }
    options.device = data.device;
  }
  if (data.engines !== undefined) {
    const engines = listField("engines", 5, 3, 20);
    const valid = ["bing", "duckduckgo", "mojeek", "brave", "google"];
    if (engines.some((engine) => !valid.includes(engine))) {
      throw new Error("Unknown search engine.");
    }
    options.engines = [...new Set(engines)];
  }
  if (endpoint === "/scan") {
    if (data.skipSiteAudit !== undefined && typeof data.skipSiteAudit !== "boolean") {
      throw new Error("skipSiteAudit must be boolean.");
    }
    return {
      ...data,
      url: textField("url", 3, 400),
      ...options,
      skipSiteAudit: data.skipSiteAudit === true,
    };
  }
  if (endpoint === "/serp") {
    if (data.depth !== undefined && data.depth !== 10 && data.depth !== 20) {
      throw new Error("depth must be 10 or 20.");
    }
    return {
      url: textField("url", 3, 400),
      keywords: listField("keywords", 10, 2, 80),
      depth: data.depth ?? 10,
      ...options,
    };
  }
  if (endpoint === "/ideas") {
    const limit = data.limit ?? 60;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("limit must be 1–100.");
    }
    return { keywords: listField("keywords", 5, 2, 80), limit };
  }
  if (endpoint === "/gap") {
    return {
      url: textField("url", 3, 400),
      competitors: listField("competitors", 5, 3, 400),
    };
  }
  return data;
}
