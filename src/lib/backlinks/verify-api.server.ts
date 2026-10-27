/** Fresh observations of explicitly requested source/target URL pairs. */
import { Budget, fetchText, mapLimit, normalizeError } from "./net.server.ts";
import { hostFromUrl, isTargetHost } from "./parse.ts";
import { guardUrl } from "./ssrf.ts";
import { sourceRevision } from "./measurement.server.ts";
import { emptyBacklinkObservation, observeBacklinkResponse } from "./evidence-response.ts";
import { extractionQuality } from "./measurement-quality.ts";
import type { CaptureResponseHook } from "./evidence-capture.server.ts";

export const BACKLINKS_SCHEMA_VERSION = "1" as const;
export const MAX_VERIFY_ITEMS = 50;
const MAX_BYTES = 2_000_000;
const BATCH_MS = 75_000;
export type VerifyPair = { source_url: string; target_url: string };
export type BacklinkObservation = VerifyPair & {
  status: "confirmed" | "not_found" | "error";
  checked_at: string;
  final_url: string | null;
  http_status: number | null;
  anchor: string | null;
  /** The anchor's actual rel tokens; an empty string means no rel attribute. */
  rel: string | null;
  reason: string | null;
  evidence_kind: "html_anchor" | null;
  observation_method: "fetched_html";
  absence_scope: "fetched_html" | "http_resource" | null;
  extraction_version: string;
  identity_policy: string;
  source_revision: string | null;
  response_hash: string | null;
  raw_href: string | null;
  resolved_href: string | null;
  matching_anchors: { raw_href: string; resolved_href: string; anchor: string; rel: string }[];
  relationship_context?: {
    version: "html-relationship-context-v1";
    primary_match: "first_matching_html_anchor";
    matching_anchor_count: number;
    placement: import("./types.ts").LinkPlacement;
    placement_is_heuristic: true;
    link_kind: "image" | "text";
    text_scope: "parser_text_not_rendered";
    excerpt: string | null;
    excerpt_hash: string | null;
  };
};

function validatedUrl(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2048 ||
    Array.from(value).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  ) {
    throw new Error(`${field} must be an absolute public HTTP(S) URL, at most 2048 characters.`);
  }
  const verdict = guardUrl(value);
  if (!verdict.allowed) throw new Error(`${field}: ${verdict.reason}`);
  return value;
}

/** Validate the entire batch before initiating any I/O. No silent truncation. */
export function verifyPairsFromBody(body: unknown): VerifyPair[] {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Expected a JSON object.");
  const { items } = body as Record<string, unknown>;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_VERIFY_ITEMS) {
    throw new Error(`items must contain 1 to ${MAX_VERIFY_ITEMS} source/target pairs.`);
  }
  return items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Each item must be an object.");
    const pair = {
      source_url: validatedUrl(item.source_url, "source_url"),
      target_url: validatedUrl(item.target_url, "target_url"),
    };
    return pair;
  });
}

async function observe(
  pair: VerifyPair,
  budget: Budget,
  index: number,
  onResponse?: CaptureResponseHook,
  relationshipContext = false,
): Promise<BacklinkObservation> {
  const context = () => ({ checkedAt: new Date().toISOString(), sourceRevision: sourceRevision() });
  const result = emptyBacklinkObservation(pair, context());
  const redirects: { from: string; to: string; status: number }[] | undefined = onResponse
    ? []
    : undefined;
  try {
    if (isTargetHost(hostFromUrl(pair.source_url), hostFromUrl(pair.target_url))) {
      throw new Error("Source belongs to target site; this is an internal link.");
    }
    if (budget.left() < 1000) throw new Error("Verification time budget exhausted.");
    const res = await fetchText(new URL(pair.source_url).href, {
      timeoutMs: Math.min(10_000, budget.left()),
      maxBytes: MAX_BYTES,
      cache: false,
      budget,
      signal: budget.signal,
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
      accept: "text/html,application/xhtml+xml;q=0.9",
      onRedirect: redirects
        ? (hop) => {
            redirects.push(hop);
          }
        : undefined,
    });
    const observation = observeBacklinkResponse(
      pair,
      {
        status: res.status,
        text: res.text,
        finalUrl: res.finalUrl,
        contentType: res.headers?.get("content-type") ?? "",
        truncated: res.truncated === true,
      },
      context(),
      { relationshipContext },
    );
    if (onResponse && !budget.signal.aborted)
      onResponse({ index, pair, response: res, redirects: redirects ?? [], observation });
    return observation;
  } catch (error) {
    result.reason = normalizeError(error);
  }
  result.checked_at = new Date().toISOString();
  return result;
}

export async function verifyBacklinks(
  body: unknown,
  options: { onResponse?: CaptureResponseHook; includeRelationshipContext?: boolean } = {},
): Promise<{
  ok: true;
  schema_version: typeof BACKLINKS_SCHEMA_VERSION;
  results: BacklinkObservation[];
  extraction_quality: ReturnType<typeof extractionQuality>;
}> {
  const pairs = verifyPairsFromBody(body);
  const budget = new Budget(BATCH_MS);
  const results = await mapLimit(pairs, 8, async (pair, index) => {
    const itemBudget = new Budget(Math.max(1, Math.min(10_000, budget.left())));
    // DNS, robots and host queues are included in the deadline too.
    let onAbort: () => void = () => {};
    const expired = new Promise<BacklinkObservation>((resolve) => {
      onAbort = () =>
        resolve({
          ...emptyBacklinkObservation(pair, {
            checkedAt: new Date().toISOString(),
            sourceRevision: sourceRevision(),
          }),
          reason: "Verification time budget exhausted.",
        });
      if (itemBudget.signal.aborted) onAbort();
      else itemBudget.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([
        observe(pair, itemBudget, index, options.onResponse, options.includeRelationshipContext),
        expired,
      ]);
    } finally {
      itemBudget.signal.removeEventListener("abort", onAbort);
    }
  });
  return {
    ok: true,
    schema_version: BACKLINKS_SCHEMA_VERSION,
    results,
    extraction_quality: extractionQuality(results),
  };
}
