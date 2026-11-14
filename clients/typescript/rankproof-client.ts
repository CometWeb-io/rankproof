/**
 * Reference TypeScript client for the RankProof HTTP API (schema "1").
 * Zero dependencies; works in Node 18+, Deno, Bun and browsers (fetch).
 *
 *   const client = new RankProofClient({ baseUrl: "http://127.0.0.1:8787" });
 *   await client.require("backlinks.verify.contract.v1");
 *   const results = await client.verify([{ source_url, target_url, expected_rel: "sponsored" }]);
 *
 * Contract rules: an `unverified` verdict is a measurement gap, never a lost
 * link; fields are additive within schema "1"; check capabilities, not versions.
 */

export const SCHEMA_VERSION = "1";
export const MAX_BATCH = 50;

export type Verdict = "meets" | "deviates" | "missing" | "unverified";
export type Mark = "match" | "mismatch" | "unspecified" | "unobserved";

export type VerifyItem = {
  source_url: string;
  target_url: string;
  expected_anchor?: string | null;
  expected_rel?: "follow" | "nofollow" | "sponsored" | "ugc" | null;
  expected_placement?: "content" | "navigation" | "footer" | "sidebar" | "comment" | null;
};

export type Observation = {
  source_url: string;
  target_url: string;
  status: "confirmed" | "not_found" | "error";
  checked_at: string;
  final_url: string | null;
  http_status: number | null;
  anchor: string | null;
  rel: string | null;
  reason: string | null;
  absence_scope: "fetched_html" | "http_resource" | "rendered_dom" | null;
  extraction_version: string;
  identity_policy: string;
  response_hash: string | null;
  resolved_href: string | null;
  placement?: string | null;
  context?: string | null;
  contract?: {
    policy: string;
    verdict: Verdict;
    target: "exact" | "near" | "none" | "unresolved";
    anchor: Mark;
    rel: Mark;
    placement?: Mark;
    visibility?: Mark;
    basis?: "fetched_html" | "rendered_dom";
    mentioned?: boolean;
    notes: string[];
  };
  rendered?: { status: string; visible: boolean | null; dom_hash: string | null } | null;
  [extra: string]: unknown;
};

export class RankProofError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "RankProofError";
    this.status = status;
  }
}

/** Verdict with a fallback for servers that predate link contracts. */
export function verdictOf(observation: Observation): Verdict {
  if (observation.contract) return observation.contract.verdict;
  return observation.status === "confirmed"
    ? "meets"
    : observation.status === "not_found"
      ? "missing"
      : "unverified";
}

export function parseVerifyResponse(document: unknown): Observation[] {
  const doc = document as { schema_version?: unknown; results?: unknown };
  if (doc?.schema_version !== SCHEMA_VERSION) {
    throw new RankProofError(`Unsupported schema_version ${JSON.stringify(doc?.schema_version)}`);
  }
  return Array.isArray(doc.results) ? (doc.results as Observation[]) : [];
}

/** Confirmed before, missing now. Errors never count as losses. */
export function lostLinks(previous: Observation[], current: Observation[]): Observation[] {
  const key = (o: Observation) => `${o.source_url}\u0000${o.target_url}`;
  const before = new Map(previous.map((o) => [key(o), o]));
  return current.filter(
    (o) => before.get(key(o))?.status === "confirmed" && verdictOf(o) === "missing",
  );
}

export class RankProofClient {
  private healthCache: Record<string, unknown> | null = null;
  private readonly baseUrl: string;
  private readonly options: {
    baseUrl: string;
    token?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  };

  constructor(options: {
    baseUrl: string;
    token?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.options = options;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown) {
    const fetchImpl = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(this.baseUrl + path, {
        method,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
      });
    } catch (error) {
      throw new RankProofError(`RankProof unreachable: ${(error as Error).message}`);
    }
    let parsed: { ok?: boolean; error?: string } & Record<string, unknown>;
    try {
      parsed = await response.json();
    } catch {
      throw new RankProofError(
        `RankProof returned non-JSON (HTTP ${response.status})`,
        response.status,
      );
    }
    if (!response.ok || parsed.ok === false) {
      throw new RankProofError(parsed.error ?? `HTTP ${response.status}`, response.status);
    }
    return parsed;
  }

  async health() {
    this.healthCache = await this.request("GET", "/health");
    return this.healthCache;
  }

  async require(...capabilities: string[]) {
    const health = this.healthCache ?? (await this.health());
    if (health.schema_version !== SCHEMA_VERSION) {
      throw new RankProofError(`Unsupported RankProof schema ${String(health.schema_version)}`);
    }
    const have = new Set((health.capabilities as string[] | undefined) ?? []);
    const missing = capabilities.filter((c) => !have.has(c));
    if (missing.length > 0)
      throw new RankProofError(`RankProof lacks capabilities: ${missing.join(", ")}`);
    return health;
  }

  /** Any number of pairs, sent in batches of 50; order is preserved. */
  async verify(items: VerifyItem[], options: { render?: "fallback" | "always" } = {}) {
    const out: Observation[] = [];
    for (let i = 0; i < items.length; i += MAX_BATCH) {
      const body = {
        items: items.slice(i, i + MAX_BATCH),
        ...(options.render ? { render: options.render } : {}),
      };
      out.push(...parseVerifyResponse(await this.request("POST", "/v1/backlinks/verify", body)));
    }
    return out;
  }
}
