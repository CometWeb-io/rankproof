/** Fresh observations of explicitly requested source/target URL pairs. */
import { documentBase, parseAnchors, decodeText } from "./html.ts";
import { Budget, fetchText, mapLimit, normalizeError } from "./net.server.ts";
import { tokenizeHtml } from "./html-tokenizer.ts";
import { hostFromUrl, isTargetHost } from "./parse.ts";
import { guardUrl } from "./ssrf.ts";
import { EXTRACTION_VERSION, responseHash, sourceRevision } from "./measurement.server.ts";
import { URL_IDENTITY_POLICY } from "./parse.ts";

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
};

function metadata() {
  return {
    evidence_kind: null,
    observation_method: "fetched_html" as const,
    absence_scope: null,
    extraction_version: EXTRACTION_VERSION,
    identity_policy: URL_IDENTITY_POLICY,
    source_revision: sourceRevision(),
    response_hash: null,
    raw_href: null,
    resolved_href: null,
    matching_anchors: [],
  };
}

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

function exactUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  return url.href;
}

async function observe(pair: VerifyPair, budget: Budget): Promise<BacklinkObservation> {
  const result: BacklinkObservation = {
    ...pair,
    ...metadata(),
    status: "error",
    checked_at: new Date().toISOString(),
    final_url: null,
    http_status: null,
    anchor: null,
    rel: null,
    reason: null,
  };
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
    });
    result.checked_at = new Date().toISOString();
    result.final_url = res.finalUrl;
    result.http_status = res.status;
    result.response_hash = responseHash(res.text);
    if (isTargetHost(hostFromUrl(res.finalUrl), hostFromUrl(pair.target_url))) {
      throw new Error("Source redirected into the target site; this is an internal link.");
    }
    if (res.status === 404 || res.status === 410) {
      result.status = "not_found";
      result.reason = `Source returned HTTP ${res.status}.`;
      result.absence_scope = "http_resource";
      return result;
    }
    if (res.status < 200 || res.status >= 300)
      throw new Error(`Source returned HTTP ${res.status}.`);
    const contentType = res.headers?.get("content-type") ?? "";
    if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) {
      throw new Error("Source did not return HTML.");
    }
    if (!res.text.trim()) throw new Error("Source returned an empty document.");
    if (res.truncated) throw new Error("Source HTML exceeds the verification size limit.");
    const document = tokenizeHtml(res.text, true);
    if (
      /^(?:just a moment|access denied|attention required)/i.test(
        decodeText(document.title ?? "").trim(),
      ) ||
      /challenge-platform|cf-browser-verification|cf-chl-|enable javascript and cookies to continue|javascript is required to complete this challenge|verify (?:that )?you are (?:a )?human|please (?:enable|turn on) javascript/i.test(
        res.text,
      )
    ) {
      throw new Error("Source returned a browser or JavaScript challenge.");
    }
    const anchors = parseAnchors(res.text, documentBase(document, res.finalUrl), {
      limit: Number.MAX_SAFE_INTEGER,
      withPlacement: false,
      exact: true,
      document,
    });
    const matches = anchors.filter((anchor) => {
      try {
        return exactUrl(anchor.href) === exactUrl(pair.target_url);
      } catch {
        return false;
      }
    });
    const match = matches[0];
    if (match) {
      result.evidence_kind = "html_anchor";
      result.raw_href = match.rawHref;
      result.resolved_href = match.resolvedHref;
      result.matching_anchors = matches.slice(0, 50).map((a) => ({
        raw_href: a.rawHref.slice(0, 2048),
        resolved_href: a.resolvedHref.slice(0, 2048),
        anchor: a.text,
        rel: a.rel.slice(0, 512),
      }));
      result.status = "confirmed";
      result.anchor = match.text;
      result.rel = match.rel.slice(0, 512);
      return result;
    }
    // An application shell cannot establish absence in the rendered page.
    if (/<script\b/i.test(res.text) && !decodeText(document.visibleText).trim()) {
      throw new Error("Source requires JavaScript rendering; no readable HTML content.");
    }
    result.status = "not_found";
    result.reason = "Exact target URL absent from fetched HTML; rendered-page presence is unknown.";
    result.absence_scope = "fetched_html";
  } catch (error) {
    result.reason = normalizeError(error);
  }
  result.checked_at = new Date().toISOString();
  return result;
}

export async function verifyBacklinks(body: unknown): Promise<{
  ok: true;
  schema_version: typeof BACKLINKS_SCHEMA_VERSION;
  results: BacklinkObservation[];
}> {
  const pairs = verifyPairsFromBody(body);
  const budget = new Budget(BATCH_MS);
  const results = await mapLimit(pairs, 8, async (pair) => {
    const itemBudget = new Budget(Math.max(1, Math.min(10_000, budget.left())));
    // DNS, robots and host queues are included in the deadline too.
    let onAbort: () => void = () => {};
    const expired = new Promise<BacklinkObservation>((resolve) => {
      onAbort = () =>
        resolve({
          ...pair,
          ...metadata(),
          status: "error",
          checked_at: new Date().toISOString(),
          final_url: null,
          http_status: null,
          anchor: null,
          rel: null,
          reason: "Verification time budget exhausted.",
        });
      if (itemBudget.signal.aborted) onAbort();
      else itemBudget.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([observe(pair, itemBudget), expired]);
    } finally {
      itemBudget.signal.removeEventListener("abort", onAbort);
    }
  });
  return { ok: true, schema_version: BACKLINKS_SCHEMA_VERSION, results };
}
