/** Fresh observations of explicitly requested source/target URL pairs. */
import { documentBase, parseAnchors, decodeText, stripTags } from "./html.ts";
import type { LinkPlacement } from "./types.ts";
import type { RenderedObservation } from "./render.server.ts";
import { Budget, fetchText, mapLimit, normalizeError } from "./net.server.ts";
import { tokenizeHtml } from "./html-tokenizer.ts";
import { hostFromUrl, isTargetHost } from "./parse.ts";
import { guardUrl } from "./ssrf.ts";
import { EXTRACTION_VERSION, responseHash, sourceRevision } from "./measurement.server.ts";
import { URL_IDENTITY_POLICY } from "./parse.ts";
import {
  CONTRACT_POLICY,
  evaluateContract,
  normalizeExpectedPlacement,
  normalizeExpectedRel,
  type ExpectedPlacement,
  type ExpectedRel,
  type LinkContract,
} from "./observe.ts";

export const BACKLINKS_SCHEMA_VERSION = "1" as const;
export const MAX_VERIFY_ITEMS = 50;
const MAX_BYTES = 2_000_000;
const BATCH_MS = 75_000;
export type VerifyPair = {
  source_url: string;
  target_url: string;
  /** Optional link contract: what the publisher agreed to place. */
  expected_anchor?: string | null;
  expected_rel?: ExpectedRel | null;
  /** Where on the page the link was agreed to sit, e.g. "content". */
  expected_placement?: ExpectedPlacement | null;
};
export type MatchingAnchor = {
  raw_href: string;
  resolved_href: string;
  anchor: string;
  rel: string;
  /** Page region the anchor sits in (heuristic from landmarks and class names). */
  placement: LinkPlacement;
  /** Visible text around the anchor, bounded. */
  context: string;
};
export type Mention = { term: string; snippet: string };
export type NearMatch = {
  resolved_href: string;
  anchor: string;
  rel: string;
  /** How the href differs from the exact target, e.g. "query string differs". */
  difference: string;
};
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
  matching_anchors: MatchingAnchor[];
  /** Placement and context of the first matching anchor. */
  placement: LinkPlacement | null;
  context: string | null;
  /** When no link is found: the target host or expected anchor seen as plain text. */
  mentions: Mention[];
  /** Links to the target site that are not the exact target URL (max 10). */
  near_matches: NearMatch[];
  /** Expected-vs-observed comparison; `unspecified` when no expectation was sent. */
  contract: LinkContract;
  /** Second observation in headless Chromium; null unless rendering was requested. */
  rendered: RenderedObservation | null;
};

/** Raw fetched representation, kept only when capture is requested (CLI evidence). */
export type CapturedRepresentation = {
  response_hash: string;
  final_url: string;
  http_status: number;
  content_type: string;
  body: string;
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
    near_matches: [],
    placement: null,
    context: null,
    mentions: [],
    rendered: null,
  };
}

const PENDING_CONTRACT: LinkContract = {
  policy: CONTRACT_POLICY,
  verdict: "unverified",
  target: "unresolved",
  anchor: "unspecified",
  rel: "unspecified",
  placement: "unspecified",
  mentioned: false,
  visibility: "unspecified",
  basis: "fetched_html",
  notes: [],
};

export type RenderMode = "off" | "fallback" | "always";

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
    const pair: VerifyPair = {
      source_url: validatedUrl(item.source_url, "source_url"),
      target_url: validatedUrl(item.target_url, "target_url"),
    };
    if (item.expected_anchor !== undefined && item.expected_anchor !== null) {
      if (typeof item.expected_anchor !== "string" || item.expected_anchor.length > 500) {
        throw new Error("expected_anchor must be a string of at most 500 characters.");
      }
      if (item.expected_anchor.trim()) pair.expected_anchor = item.expected_anchor.trim();
    }
    if (item.expected_rel !== undefined && item.expected_rel !== null && item.expected_rel !== "") {
      const rel = normalizeExpectedRel(item.expected_rel);
      if (!rel) throw new Error("expected_rel must be one of follow, nofollow, sponsored, ugc.");
      pair.expected_rel = rel;
    }
    if (
      item.expected_placement !== undefined &&
      item.expected_placement !== null &&
      item.expected_placement !== ""
    ) {
      const placement = normalizeExpectedPlacement(item.expected_placement);
      if (!placement) {
        throw new Error(
          "expected_placement must be one of content, navigation, footer, sidebar, comment.",
        );
      }
      pair.expected_placement = placement;
    }
    return pair;
  });
}

function exactUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  return url.href;
}

function emptyObservation(pair: VerifyPair): BacklinkObservation {
  return {
    ...pair,
    ...metadata(),
    status: "error",
    checked_at: new Date().toISOString(),
    final_url: null,
    http_status: null,
    anchor: null,
    rel: null,
    reason: null,
    contract: PENDING_CONTRACT,
  };
}

const CONTEXT_RADIUS = 120;

/**
 * Visible text around an anchor: the text just before its start tag and just
 * after it, cut at tag boundaries so partial markup never leaks in.
 */
export function contextAround(html: string, index: number, anchorText: string): string {
  let before = html.slice(Math.max(0, index - 1500), index);
  const firstClose = before.indexOf(">");
  if (index > 1500 && firstClose >= 0) before = before.slice(firstClose + 1);
  let after = html.slice(index, index + 1500 + anchorText.length);
  const lastOpen = after.lastIndexOf("<");
  if (lastOpen > 0 && index + 1500 < html.length) after = after.slice(0, lastOpen);
  const pre = stripTags(before).slice(-CONTEXT_RADIUS);
  const post = stripTags(after).slice(0, anchorText.length + CONTEXT_RADIUS);
  const joined = `${pre} ${post}`.replace(/\s+/g, " ").trim();
  return joined.slice(0, 400);
}

/** Plain-text occurrences of the target host or agreed anchor (no link). */
export function findMentions(visibleText: string, terms: string[]): Mention[] {
  const text = visibleText.replace(/\s+/g, " ");
  const lower = text.toLocaleLowerCase();
  const out: Mention[] = [];
  for (const term of [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 3))]) {
    const at = lower.indexOf(term.toLocaleLowerCase());
    if (at === -1) continue;
    const start = Math.max(0, at - CONTEXT_RADIUS);
    const end = Math.min(text.length, at + term.length + CONTEXT_RADIUS);
    out.push({
      term,
      snippet: `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`,
    });
    if (out.length >= 3) break;
  }
  return out;
}

/** Describes how a same-site href differs from the exact target URL. */
export function hrefDifference(href: string, target: string): string {
  try {
    const a = new URL(href);
    const b = new URL(target);
    a.hash = "";
    b.hash = "";
    if (a.protocol !== b.protocol)
      return `protocol ${a.protocol.replace(":", "")} instead of ${b.protocol.replace(":", "")}`;
    if (a.hostname !== b.hostname) return `host ${a.hostname} instead of ${b.hostname}`;
    if (a.pathname !== b.pathname) {
      const strip = (p: string) => p.replace(/\/+$/, "") || "/";
      return strip(a.pathname) === strip(b.pathname)
        ? "trailing slash differs"
        : `path ${a.pathname}`;
    }
    if (a.search !== b.search)
      return a.search ? `query string ${a.search.slice(0, 80)}` : "query string missing";
    if (a.port !== b.port) return "port differs";
    return "URL differs";
  } catch {
    return "URL differs";
  }
}

/**
 * Pure extraction step: interprets one fetched HTTP representation of the source.
 * No I/O, so the same function re-analyses a captured snapshot offline (replay).
 */
export function observeRepresentation(
  pair: VerifyPair,
  res: {
    text: string;
    finalUrl: string;
    status: number;
    contentType: string;
    truncated?: boolean;
    checkedAt?: string;
  },
): BacklinkObservation {
  const result = emptyObservation(pair);
  result.checked_at = res.checkedAt ?? result.checked_at;
  try {
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
    if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(res.contentType)) {
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
      withPlacement: true,
      exact: true,
      document,
    });
    const target = exactUrl(pair.target_url);
    const targetHost = hostFromUrl(pair.target_url);
    const matches = anchors.filter((anchor) => {
      try {
        return exactUrl(anchor.href) === target;
      } catch {
        return false;
      }
    });
    result.near_matches = anchors
      .filter((anchor) => {
        try {
          return (
            exactUrl(anchor.href) !== target && isTargetHost(hostFromUrl(anchor.href), targetHost)
          );
        } catch {
          return false;
        }
      })
      .slice(0, 10)
      .map((anchor) => ({
        resolved_href: anchor.resolvedHref.slice(0, 2048),
        anchor: anchor.text.slice(0, 500),
        rel: anchor.rel.slice(0, 512),
        difference: hrefDifference(anchor.resolvedHref, pair.target_url),
      }));
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
        placement: a.placement,
        context: contextAround(res.text, a.index, a.text),
      }));
      result.placement = result.matching_anchors[0]!.placement;
      result.context = result.matching_anchors[0]!.context;
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
    // Text inside any <a> is a link, not a plain mention. The tokenizer output is
    // linear in the input; regex tag stripping over 2 MB of hostile HTML is not.
    // The title counts as page text, as it did with tag stripping.
    const plainText = `${document.title ?? ""} ${document.textOutsideAnchors}`;
    result.mentions = findMentions(decodeText(plainText), [
      targetHost.replace(/^www\./, ""),
      pair.expected_anchor ?? "",
    ]);
  } catch (error) {
    result.status = "error";
    result.reason = normalizeError(error);
    result.near_matches = [];
    result.mentions = [];
  }
  return result;
}

async function observe(
  pair: VerifyPair,
  budget: Budget,
  capture?: (item: CapturedRepresentation) => void,
): Promise<BacklinkObservation> {
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
    const contentType = res.headers?.get("content-type") ?? "";
    const observation = observeRepresentation(pair, {
      text: res.text,
      finalUrl: res.finalUrl,
      status: res.status,
      contentType,
      truncated: res.truncated,
      checkedAt: new Date().toISOString(),
    });
    if (capture && observation.response_hash && !res.truncated) {
      capture({
        response_hash: observation.response_hash,
        final_url: res.finalUrl,
        http_status: res.status,
        content_type: contentType,
        body: res.text,
      });
    }
    return observation;
  } catch (error) {
    const result = emptyObservation(pair);
    result.reason = normalizeError(error);
    return result;
  }
}

/** Which results are worth a second look in a browser. Never 404s, challenges or policy refusals. */
export function needsRender(result: BacklinkObservation, mode: RenderMode): boolean {
  if (mode === "off") return false;
  if (result.status === "not_found") return result.absence_scope === "fetched_html";
  if (result.status === "error") return /requires JavaScript rendering/i.test(result.reason ?? "");
  return mode === "always";
}

export function readRenderMode(body: unknown, allowRender: boolean): RenderMode {
  const raw =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { render?: unknown }).render
      : undefined;
  if (raw === undefined || raw === null || raw === false || raw === "off") return "off";
  if (raw !== true && raw !== "fallback" && raw !== "always") {
    throw new Error('render must be "off", "fallback" or "always".');
  }
  if (!allowRender) {
    throw new Error("Rendering is not enabled on this server (start it with RANKPROOF_RENDER=1).");
  }
  return raw === "always" ? "always" : "fallback";
}

export async function verifyBacklinks(
  body: unknown,
  options: {
    capture?: (item: CapturedRepresentation) => void;
    /** Server/CLI permission for `body.render`; the CLI may also force a mode. */
    allowRender?: boolean;
    render?: RenderMode;
  } = {},
): Promise<{
  ok: true;
  schema_version: typeof BACKLINKS_SCHEMA_VERSION;
  results: BacklinkObservation[];
}> {
  const pairs = verifyPairsFromBody(body);
  const renderMode = options.render ?? readRenderMode(body, options.allowRender === true);
  const budget = new Budget(BATCH_MS);
  const results = await mapLimit(pairs, 8, async (pair) => {
    const itemBudget = new Budget(Math.max(1, Math.min(10_000, budget.left())));
    // DNS, robots and host queues are included in the deadline too.
    let onAbort: () => void = () => {};
    const expired = new Promise<BacklinkObservation>((resolve) => {
      onAbort = () =>
        resolve({ ...emptyObservation(pair), reason: "Verification time budget exhausted." });
      if (itemBudget.signal.aborted) onAbort();
      else itemBudget.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([observe(pair, itemBudget, options.capture), expired]);
    } finally {
      itemBudget.signal.removeEventListener("abort", onAbort);
    }
  });
  const toRender = results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => needsRender(result, renderMode));
  if (toRender.length > 0) {
    const { renderObserve, skipped } = await import("./render.server.ts");
    try {
      const rendered = await renderObserve(
        toRender.map(({ result }) => ({
          source_url: result.source_url,
          target_url: result.target_url,
        })),
      );
      toRender.forEach(({ index }, i) => {
        results[index]!.rendered = rendered[i] ?? null;
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      for (const { index } of toRender) results[index]!.rendered = skipped(reason);
    }
  }
  for (const result of results) result.contract = evaluateContract(result, result);
  return { ok: true, schema_version: BACKLINKS_SCHEMA_VERSION, results };
}
