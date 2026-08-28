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
  const rules: RobotsRules = {
    disallow: [],
    allow: [],
    crawlDelay: null,
    sitemaps: [],
    missing: false,
  };
  const wildcard: RobotsRules = { ...ALLOW_ALL, disallow: [], allow: [], missing: false };

  let currentAgents: string[] = [];
  let sawDirective = false;
  let sawNamedGroup = false;
  const lower = agent.toLowerCase();

  for (const rawLine of text.split(/\r?\n/).slice(0, 3000)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "sitemap") {
      if (value) rules.sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      // A new agent block starts only after directives, not between agents.
      if (sawDirective) {
        currentAgents = [];
        sawDirective = false;
      }
      currentAgents.push(value.toLowerCase());
      continue;
    }

    sawDirective = true;
    const targets: RobotsRules[] = [];
    // Token matching, not substring matching. `lower.includes(item)` treated a
    // group written for "a", "pro", "rank" or "roof" as if it addressed us.
    // RFC 9309 matches on a prefix of the product token, so require that.
    if (currentAgents.some((item) => item !== "*" && item !== "" && lower.startsWith(item))) {
      targets.push(rules);
      sawNamedGroup = true;
    }
    if (currentAgents.includes("*")) targets.push(wildcard);
    if (targets.length === 0) continue;

    for (const target of targets) {
      if (field === "disallow") {
        if (value) target.disallow.push(value);
      } else if (field === "allow") {
        if (value) target.allow.push(value);
      } else if (field === "crawl-delay") {
        const delay = Number(value.replace(",", "."));
        if (Number.isFinite(delay) && delay >= 0) target.crawlDelay = Math.min(30, delay);
      }
    }
  }

  // A group addressed to us wins even when it produced no rules: `Disallow:`
  // with an empty value is how a site says "fetch anything".
  const chosen = sawNamedGroup ? rules : { ...wildcard, sitemaps: rules.sitemaps };
  return { ...chosen, sitemaps: rules.sitemaps, missing: false };
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
    const { fetchText } = await import("./net.server.ts");
    const { status, text } = await fetchText(`${origin}/robots.txt`, {
      timeoutMs: budget.timeout(4000),
      maxBytes: 120_000,
      signal: budget.signal,
      // robots.txt itself is always fetchable; skipping the guard here would
      // be circular.
      skipRobots: true,
    });
    // 4xx means "no rules"; 5xx means the host is unhappy — back off politely.
    if (status >= 200 && status < 300 && text.trim()) rules = parseRobots(text, agent);
    else if (status >= 500) {
      rules = { ...ALLOW_ALL, missing: false, disallow: ["/"] };
      ttl = ERROR_TTL_MS;
    }
  } catch {
    rules = ALLOW_ALL;
    ttl = ERROR_TTL_MS;
  }

  CACHE.set(key, { rules, until: Date.now() + ttl });
  return rules;
}

export function clearRobotsCache(): void {
  CACHE.clear();
}
