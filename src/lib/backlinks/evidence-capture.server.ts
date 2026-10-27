/** Explicit, bounded capture; the default verifier does not retain response bodies. */
import {
  verifyBacklinks,
  verifyPairsFromBody,
  type BacklinkObservation,
  type VerifyPair,
} from "./verify-api.server.ts";
import type { FetchResult } from "./net.server.ts";
import { EXTRACTION_VERSION, responseHash } from "./measurement.server.ts";
import { URL_IDENTITY_POLICY } from "./parse.ts";
import { assertUtf8HtmlEncoding } from "./evidence-response.ts";
import { tokenizeHtml } from "./html-tokenizer.ts";
import {
  CAPTURE_MAX_BODY_BYTES,
  CAPTURE_MAX_TOTAL_BYTES,
  CAPTURE_MIN_TOTAL_BYTES,
  sealEvidenceCapture,
  captureHash,
  captureSafeUrl,
  type CaptureRedirect,
  type CapturedEntry,
  type EvidenceCapture,
} from "./evidence-capture.ts";
export { captureHash } from "./evidence-capture.ts";

export type CaptureResponseHook = (event: {
  index: number;
  pair: VerifyPair;
  response: FetchResult;
  redirects: CaptureRedirect[];
  observation: BacklinkObservation;
}) => void;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

export async function captureBacklinks(body: unknown, options: { maxTotalBytes?: number } = {}) {
  const maximum = options.maxTotalBytes ?? CAPTURE_MAX_TOTAL_BYTES;
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < CAPTURE_MIN_TOTAL_BYTES ||
    maximum > CAPTURE_MAX_TOTAL_BYTES
  )
    throw new Error("Capture total limit must be 16384–8000000 bytes.");
  const pairs = verifyPairsFromBody(body);
  const entries: CapturedEntry[] = [];
  const omitted = new Map<number, EvidenceCapture["omitted"][number]["reason"]>(
    pairs.map((_, index) => [index, "no_complete_response"]),
  );
  const createdAt = new Date().toISOString();
  const seal = (rows: CapturedEntry[]) =>
    sealEvidenceCapture({
      version: "evidence-capture-v1",
      hash_algorithm: "sha256",
      body_hash_scope: "utf8_decoded_response_text",
      extraction_version: EXTRACTION_VERSION,
      identity_policy: URL_IDENTITY_POLICY,
      created_at: createdAt,
      limits: { max_body_bytes: CAPTURE_MAX_BODY_BYTES, max_total_bytes: maximum },
      entries: [...rows].sort((a, b) => a.index - b.index),
      omitted: [...omitted].sort(([a], [b]) => a - b).map(([index, reason]) => ({ index, reason })),
    });
  let sealed = false;
  const verification = await verifyBacklinks(
    { items: pairs },
    {
      onResponse: ({ index, pair, response, redirects, observation }) => {
        if (sealed) return;
        const omit = (reason: EvidenceCapture["omitted"][number]["reason"]) => {
          omitted.set(index, reason);
        };
        try {
          assertUtf8HtmlEncoding(
            response.text,
            response.headers?.get("content-type") ?? "",
            tokenizeHtml(response.text),
          );
        } catch {
          return omit("unreplayable_response");
        }
        if (
          ![
            pair.source_url,
            pair.target_url,
            response.finalUrl,
            ...redirects.flatMap((hop) => [hop.from, hop.to]),
          ].every(captureSafeUrl) ||
          response.headers?.has("set-cookie") ||
          response.headers?.has("www-authenticate") ||
          /(?:private|no-store)/i.test(response.headers?.get("cache-control") ?? "") ||
          /(?:cookie|authorization|\*)/i.test(response.headers?.get("vary") ?? "") ||
          /<input\b[^>]*\btype\s*=\s*["']?password\b|["'](?:access_token|refresh_token|id_token)["']\s*:/i.test(
            response.text,
          )
        )
          return omit("sensitive_response");
        let resolved = new URL(pair.source_url).href;
        for (const hop of redirects) {
          if (hop.from !== resolved) return omit("unreplayable_response");
          resolved = hop.to;
        }
        if (resolved !== response.finalUrl || redirects.length > 5)
          return omit("unreplayable_response");
        const bytes = Buffer.byteLength(response.text, "utf8");
        if (bytes > CAPTURE_MAX_BODY_BYTES) return omit("body_limit");
        if (
          response.truncated ||
          response.fromCache ||
          observation.status === "error" ||
          !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
            response.headers?.get("content-type") ?? "",
          ) ||
          (response.headers?.get("content-type")?.length ?? 0) > 256 ||
          (observation.source_revision?.length ?? 0) > 4096
        )
          return omit("unreplayable_response");
        const content = {
          index,
          request: structuredClone(pair),
          response: {
            requested_url: new URL(pair.source_url).href,
            final_url: response.finalUrl,
            status: response.status,
            content_type: response.headers?.get("content-type") ?? "",
            text: response.text,
            decoded_utf8_bytes: bytes,
            body_sha256: responseHash(response.text),
            complete: true,
            from_cache: false as const,
            redirects: structuredClone(redirects),
            redirect_chain_complete: true as const,
          },
          observation: structuredClone(observation),
        };
        const entry = { ...content, id: captureHash(content) };
        omitted.delete(index);
        if (seal([...entries, entry]).total_bytes > maximum) return omit("total_limit");
        entries.push(entry);
      },
    },
  );
  sealed = true;
  return { verification, capture: freeze(seal(entries)) };
}
