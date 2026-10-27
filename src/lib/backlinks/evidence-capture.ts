/** Portable capture format: decoded response text, never original wire bytes. */
import { createHash } from "node:crypto";
import { EXTRACTION_VERSION, responseHash } from "./measurement.server.ts";
import { URL_IDENTITY_POLICY } from "./parse.ts";
import { guardUrl } from "./ssrf.ts";
import type { BacklinkObservation, VerifyPair } from "./verify-api.server.ts";

export const CAPTURE_MAX_BODY_BYTES = 2_000_000;
export const CAPTURE_MAX_TOTAL_BYTES = 8_000_000;
export const CAPTURE_MIN_TOTAL_BYTES = 16_384;
export type CaptureRedirect = { from: string; to: string; status: number };
export type CapturedEntry = {
  index: number;
  id: string;
  request: VerifyPair;
  response: {
    requested_url: string;
    final_url: string;
    status: number;
    content_type: string;
    text: string;
    decoded_utf8_bytes: number;
    body_sha256: string;
    complete: boolean;
    from_cache: false;
    redirects: CaptureRedirect[];
    redirect_chain_complete: true;
  };
  observation: BacklinkObservation;
};
export type EvidenceCapture = {
  version: "evidence-capture-v1";
  hash_algorithm: "sha256";
  body_hash_scope: "utf8_decoded_response_text";
  extraction_version: string;
  identity_policy: string;
  created_at: string;
  limits: { max_body_bytes: number; max_total_bytes: number };
  entries: CapturedEntry[];
  omitted: {
    index: number;
    reason:
      | "sensitive_response"
      | "body_limit"
      | "total_limit"
      | "unreplayable_response"
      | "no_complete_response";
  }[];
  total_bytes: number;
  root_hash: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const captureHash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const captureBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Include the envelope and omission records in the serialized JSON limit. */
export function sealEvidenceCapture(
  content: Omit<EvidenceCapture, "total_bytes" | "root_hash">,
): EvidenceCapture {
  const capture = { ...content, total_bytes: 0, root_hash: "0".repeat(64) };
  while (capture.total_bytes !== captureBytes(capture)) capture.total_bytes = captureBytes(capture);
  const { root_hash: _placeholder, ...hashed } = capture;
  capture.root_hash = captureHash(hashed);
  return capture;
}

/** Omit credential-looking queries and all resource fragments rather than rewrite evidence. */
export function captureSafeUrl(value: string): boolean {
  if (
    !guardUrl(value).allowed ||
    value.length > 2048 ||
    Array.from(value).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  )
    return false;
  const url = new URL(value);
  if (url.hash) return false;
  return ![...url.searchParams.keys()].some((name) =>
    /(?:token|password|passwd|secret|api.?key|authorization|auth|signature|credential|session|jwt|bearer|^code$|^key$|^sig$|^pwd$|^pass$)/i.test(
      name,
    ),
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function keys(value: unknown, expected: string[]) {
  if (
    !record(value) ||
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Invalid capture fields.");
}
const isoDate = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) &&
  Number.isFinite(Date.parse(value));

/** Validate the whole bounded artifact before any extraction; never fetches a URL. */
export function validateEvidenceCapture(value: unknown): asserts value is EvidenceCapture {
  keys(value, [
    "version",
    "hash_algorithm",
    "body_hash_scope",
    "extraction_version",
    "identity_policy",
    "created_at",
    "limits",
    "entries",
    "omitted",
    "total_bytes",
    "root_hash",
  ]);
  const capture = value as EvidenceCapture;
  if (
    capture.version !== "evidence-capture-v1" ||
    capture.hash_algorithm !== "sha256" ||
    capture.body_hash_scope !== "utf8_decoded_response_text" ||
    capture.extraction_version !== EXTRACTION_VERSION ||
    capture.identity_policy !== URL_IDENTITY_POLICY
  )
    throw new Error("Unsupported capture method or version.");
  keys(capture.limits, ["max_body_bytes", "max_total_bytes"]);
  if (
    !isoDate(capture.created_at) ||
    capture.limits.max_body_bytes !== CAPTURE_MAX_BODY_BYTES ||
    !Number.isSafeInteger(capture.limits.max_total_bytes) ||
    capture.limits.max_total_bytes < CAPTURE_MIN_TOTAL_BYTES ||
    capture.limits.max_total_bytes > CAPTURE_MAX_TOTAL_BYTES ||
    !Array.isArray(capture.entries) ||
    capture.entries.length > 50 ||
    !Array.isArray(capture.omitted) ||
    capture.omitted.length > 50 ||
    !Number.isSafeInteger(capture.total_bytes)
  )
    throw new Error("Invalid capture bounds.");
  if (typeof capture.root_hash !== "string" || !/^[a-f0-9]{64}$/.test(capture.root_hash))
    throw new Error("Invalid capture root hash.");
  let entryBytes = 0;
  const indices = new Set<number>();
  for (const entry of capture.entries) {
    keys(entry, ["index", "id", "request", "response", "observation"]);
    if (
      !Number.isSafeInteger(entry.index) ||
      entry.index < 0 ||
      entry.index >= 50 ||
      indices.has(entry.index)
    )
      throw new Error("Invalid capture item index.");
    indices.add(entry.index);
    keys(entry.request, ["source_url", "target_url"]);
    if (
      typeof entry.request.source_url !== "string" ||
      typeof entry.request.target_url !== "string" ||
      !captureSafeUrl(entry.request.source_url) ||
      !captureSafeUrl(entry.request.target_url)
    )
      throw new Error("Capture contains a sensitive or invalid URL.");
    const response = entry.response;
    keys(response, [
      "requested_url",
      "final_url",
      "status",
      "content_type",
      "text",
      "decoded_utf8_bytes",
      "body_sha256",
      "complete",
      "from_cache",
      "redirects",
      "redirect_chain_complete",
    ]);
    if (
      typeof response.text !== "string" ||
      typeof response.content_type !== "string" ||
      response.content_type.length > 256 ||
      !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.content_type) ||
      !Number.isSafeInteger(response.status) ||
      response.status < 100 ||
      response.status > 599 ||
      response.complete !== true ||
      response.from_cache !== false ||
      response.redirect_chain_complete !== true ||
      typeof response.final_url !== "string" ||
      !captureSafeUrl(response.final_url) ||
      response.requested_url !== new URL(entry.request.source_url).href
    )
      throw new Error("Invalid or incomplete capture response.");
    if (
      response.text.length > CAPTURE_MAX_BODY_BYTES ||
      response.decoded_utf8_bytes !== Buffer.byteLength(response.text, "utf8") ||
      response.decoded_utf8_bytes > CAPTURE_MAX_BODY_BYTES ||
      response.body_sha256 !== responseHash(response.text)
    )
      throw new Error("Capture body integrity hash or byte limit mismatch.");
    if (!Array.isArray(response.redirects) || response.redirects.length > 5)
      throw new Error("Invalid redirect provenance.");
    let current = response.requested_url;
    for (const hop of response.redirects) {
      keys(hop, ["from", "to", "status"]);
      if (
        hop.from !== current ||
        typeof hop.to !== "string" ||
        !captureSafeUrl(hop.to) ||
        !Number.isInteger(hop.status) ||
        hop.status < 300 ||
        hop.status >= 400
      )
        throw new Error("Invalid redirect provenance.");
      current = hop.to;
    }
    if (current !== response.final_url) throw new Error("Incomplete redirect provenance.");
    const observation = entry.observation;
    keys(observation, [
      "source_url",
      "target_url",
      "status",
      "checked_at",
      "final_url",
      "http_status",
      "anchor",
      "rel",
      "reason",
      "evidence_kind",
      "observation_method",
      "absence_scope",
      "extraction_version",
      "identity_policy",
      "source_revision",
      "response_hash",
      "raw_href",
      "resolved_href",
      "matching_anchors",
    ]);
    const nullableString = (value: unknown, max: number) =>
      value === null || (typeof value === "string" && value.length <= max);
    if (
      !["confirmed", "not_found"].includes(observation.status) ||
      !nullableString(observation.anchor, 160) ||
      !nullableString(observation.rel, 512) ||
      !nullableString(observation.reason, 160) ||
      !nullableString(observation.raw_href, CAPTURE_MAX_BODY_BYTES) ||
      !nullableString(observation.resolved_href, CAPTURE_MAX_BODY_BYTES) ||
      !nullableString(observation.source_revision, 4096) ||
      !Array.isArray(observation.matching_anchors) ||
      observation.matching_anchors.length > 50 ||
      ![null, "html_anchor"].includes(observation.evidence_kind) ||
      ![null, "fetched_html", "http_resource"].includes(observation.absence_scope)
    )
      throw new Error("Invalid captured observation.");
    for (const anchor of observation.matching_anchors) {
      keys(anchor, ["raw_href", "resolved_href", "anchor", "rel"]);
      if (
        typeof anchor.raw_href !== "string" ||
        anchor.raw_href.length > 2048 ||
        typeof anchor.resolved_href !== "string" ||
        anchor.resolved_href.length > 2048 ||
        typeof anchor.anchor !== "string" ||
        anchor.anchor.length > 160 ||
        typeof anchor.rel !== "string" ||
        anchor.rel.length > 512
      )
        throw new Error("Invalid captured anchor bounds.");
    }
    if (
      !record(observation) ||
      !isoDate(observation.checked_at) ||
      observation.source_url !== entry.request.source_url ||
      observation.target_url !== entry.request.target_url ||
      observation.final_url !== response.final_url ||
      observation.http_status !== response.status ||
      observation.response_hash !== response.body_sha256 ||
      observation.extraction_version !== capture.extraction_version ||
      observation.identity_policy !== capture.identity_policy ||
      observation.observation_method !== "fetched_html" ||
      !(observation.source_revision === null || typeof observation.source_revision === "string")
    )
      throw new Error("Captured observation provenance mismatch.");
    entryBytes += captureBytes(entry);
    if (entryBytes > capture.limits.max_total_bytes)
      throw new Error("Capture total byte limit mismatch.");
    const { id, ...entryContent } = entry;
    if (id !== captureHash(entryContent)) throw new Error("Capture entry integrity hash mismatch.");
  }
  for (const omitted of capture.omitted) {
    keys(omitted, ["index", "reason"]);
    if (
      !Number.isSafeInteger(omitted.index) ||
      omitted.index < 0 ||
      omitted.index >= 50 ||
      indices.has(omitted.index) ||
      ![
        "sensitive_response",
        "body_limit",
        "total_limit",
        "unreplayable_response",
        "no_complete_response",
      ].includes(omitted.reason)
    )
      throw new Error("Invalid capture omission.");
    indices.add(omitted.index);
  }
  if (indices.size < 1 || [...indices].some((index) => index >= indices.size))
    throw new Error("Incomplete capture item coverage.");
  if (
    captureBytes(capture) !== capture.total_bytes ||
    capture.total_bytes > capture.limits.max_total_bytes
  )
    throw new Error("Capture total byte limit mismatch.");
  const { root_hash, ...content } = capture;
  if (root_hash !== captureHash(content)) throw new Error("Capture integrity hash mismatch.");
}
