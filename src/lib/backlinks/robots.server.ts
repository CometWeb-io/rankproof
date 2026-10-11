import type { Budget } from "./net.server.ts";

/**
 * robots.txt support.
 *
 * This tool fetches other people's servers. Ignoring their stated rules is
 * both rude and a fast way to get blocked, so the crawler asks first and
 * honours `Disallow` and `Crawl-delay` for our own user-agent (falling back
 * to the `*` group).
 *
 * SERP endpoints are deliberately exempt: search engines disallow their
 * result pages for indexing bots, while every rank-checking tool in
 * existence reads them. We apply robots to pages we crawl, not to lookups.
 */

export type RobotsRules = {
  /** Path prefixes we must not fetch. */
  disallow: string[];
  /** Prefixes that re-allow a subtree inside a disallowed one. */
  allow: string[];
  /** Seconds the host asked us to wait between requests, if any. */
  crawlDelay: number | null;
  sitemaps: string[];
  /** True when robots.txt was missing or unreadable — then everything is allowed. */
  missing: boolean;
};

export const ALLOW_ALL: RobotsRules = {
  disallow: [],
  allow: [],
  crawlDelay: null,
  sitemaps: [],
  missing: true,
};

/**
 * Parses robots.txt for a given agent. Groups are matched by the most
 * specific agent that applies: our own name wins over `*`.
 */
export function parseRobots(text: string, agent = "rankproof"): RobotsRules {
  type Group = {
    agents: string[];
    allow: string[];
    disallow: string[];
    crawlDelay: number | null;
  };
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let group: Group | null = null;
  let sawDirective = false;
  const productToken = agent.toLowerCase();

  // UTF-8 BOM is allowed at the beginning of a robots.txt file.
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/).slice(0, 3000)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!group || sawDirective) {
        group = { agents: [], allow: [], disallow: [], crawlDelay: null };
        groups.push(group);
        sawDirective = false;
      }
      if (value) group.agents.push(value.toLowerCase());
      continue;
    }
    if (!group) continue;
    sawDirective = true;
    if (field === "allow" && value) group.allow.push(value);
    if (field === "disallow" && value) group.disallow.push(value);
    if (field === "crawl-delay") {
      const delay = Number(value.replace(",", "."));
      if (Number.isFinite(delay) && delay >= 0) {
        group.crawlDelay = Math.min(30, delay);
      }
    }
  }

  // RFC 9309 merges rules from applicable groups, not rules belonging to
  // shorter-prefix agents or the wildcard group when a specific one matches.
  const matching: { group: Group; specificity: number }[] = [];
  for (const candidate of groups) {
    let specificity = 0;
    for (const name of candidate.agents) {
      if (name !== "*" && productToken.startsWith(name)) {
        specificity = Math.max(specificity, name.length);
      }
    }
    matching.push({ group: candidate, specificity });
  }
  const specificity = Math.max(0, ...matching.map((item) => item.specificity));
  const chosen =
    specificity > 0
      ? matching.filter((item) => item.specificity === specificity)
      : matching.filter((item) => item.group.agents.includes("*"));
  const combined: RobotsRules = {
    allow: chosen.flatMap((item) => item.group.allow),
    disallow: chosen.flatMap((item) => item.group.disallow),
    crawlDelay: chosen.reduce<number | null>((delay, item) => {
      const value = item.group.crawlDelay;
      return value === null ? delay : Math.max(delay ?? 0, value);
    }, null),
    sitemaps,
    missing: false,
  };
  return combined;
}

function matches(path: string, prefix: string): boolean {
  // robots.txt supports `*` wildcards and `$` end-anchors.
  if (!prefix.includes("*") && !prefix.endsWith("$")) return path.startsWith(prefix);
  const escaped = prefix
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\$$/, "$")
    .replace(/\*/g, ".*");
  try {
    return new RegExp(`^${escaped}`).test(path);
  } catch {
    return false;
  }
}

/** True when the rules permit fetching this path. Longest match wins. */
export function isAllowed(rules: RobotsRules, path: string): boolean {
  if (rules.missing) return true;
  const target = path || "/";
  let blockedBy = -1;
  for (const prefix of rules.disallow) {
    if (prefix === "/") {
      blockedBy = Math.max(blockedBy, 1);
      continue;
    }
    if (matches(target, prefix)) blockedBy = Math.max(blockedBy, prefix.length);
  }
  if (blockedBy === -1) return true;
  let allowedBy = -1;
  for (const prefix of rules.allow) {
    if (matches(target, prefix)) allowedBy = Math.max(allowedBy, prefix.length);
  }
  return allowedBy >= blockedBy;
}

type CacheEntry = { rules: RobotsRules; until: number };
const CACHE = new Map<string, CacheEntry>();

/** Successful fetches are cheap to keep; a back-off must not outlive the incident. */
const CACHE_TTL_MS = 30 * 60_000;
const ERROR_TTL_MS = 5 * 60_000;
const MAX_ROBOTS_CACHE_ENTRIES = 512;

/**
 * Fetches and caches robots.txt per origin. Entries expire: `scripts/serve-api.mjs`
 * is long-running, and a single 502 during one scan used to disallow the host
 * permanently for every later scan in that process.
 */
export async function robotsFor(
  origin: string,
  budget: Budget,
  agent = "rankproof",
): Promise<RobotsRules> {
  const key = `${origin}|${agent}`;
  const hit = CACHE.get(key);
  if (hit && hit.until > Date.now()) return hit.rules;

  let rules = ALLOW_ALL;
  let ttl = CACHE_TTL_MS;
  try {
    const { fetchText, API_UA } = await import("./net.server.ts");
    const { status, text, truncated } = await fetchText(`${origin}/robots.txt`, {
      timeoutMs: budget.timeout(4000),
      maxBytes: 120_000,
      signal: budget.signal,
      ua: API_UA,
      // robots.txt itself is always fetchable; skipping the guard here would
      // be circular.
      skipRobots: true,
    });
    // A 200 HTML anti-bot challenge or a partially downloaded robots file
    // is not proof that all paths are permitted.
    const appearsHtml = /<\s*(?:!doctype\s+html|html|head|body|form|script)\b/i.test(
      text.slice(0, 2_048),
    );
    if (truncated || appearsHtml || (status >= 300 && status < 400)) {
      rules = { ...ALLOW_ALL, missing: false, disallow: ["/"] };
      ttl = ERROR_TTL_MS;
    } else if (status >= 200 && status < 300 && text.trim()) {
      rules = parseRobots(text, agent);
    } else if (status === 429 || status >= 500) {
      rules = { ...ALLOW_ALL, missing: false, disallow: ["/"] };
      ttl = ERROR_TTL_MS;
    }
  } catch {
    // RFC 9309: unreachable robots.txt is not the same as a missing 404.
    // A network/TLS/timeout failure must not grant crawl permission.
    rules = { ...ALLOW_ALL, missing: false, disallow: ["/"] };
    ttl = ERROR_TTL_MS;
  }

  CACHE.set(key, { rules, until: Date.now() + ttl });
  if (CACHE.size > MAX_ROBOTS_CACHE_ENTRIES) {
    const oldest = CACHE.keys().next().value;
    if (oldest) CACHE.delete(oldest);
  }
  return rules;
}

export function clearRobotsCache(): void {
  CACHE.clear();
}
