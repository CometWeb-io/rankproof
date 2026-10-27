import { createHash } from "node:crypto";
import { documentBase, parseAnchors } from "./html.ts";
import { tokenizeHtml } from "./html-tokenizer.ts";
import { normalizeUrl } from "./parse.ts";
import { guardUrl } from "./ssrf.ts";

export const RENDER_LIMITS = Object.freeze({
  wallTimeMs: 15_000,
  cpuTimeMs: 5_000,
  memoryBytes: 256 * 1024 * 1024,
  requests: 40,
  responseBytes: 2_000_000,
  redirects: 3,
});

/** This is a capability report, never permission to launch a browser. */
export function renderedPolicy(url: string) {
  const verdict = guardUrl(url);
  return {
    schemaVersion: 1,
    status: "unavailable" as const,
    requestedUrl: url,
    reason: verdict.allowed ? "qualified_runtime_not_configured" : "unsafe_url",
    detail: verdict.allowed
      ? "No explicit qualified runtime is configured for this report. Use the optional isolated renderer with a reviewed runtime."
      : verdict.reason,
    networkPolicy: "deny_all" as const,
    limits: RENDER_LIMITS,
    requiredControls: [
      "OS sandbox and enforced CPU, memory and wall time limits",
      "egress proxy with DNS pinning and public-address validation at connect time",
      "all navigations, redirects, subresources, workers, WebSockets and WebRTC confined",
      "robots policy checked before navigation and after redirects",
      "request, response-byte and redirect budgets enforced by the executor",
    ],
  };
}

/** Offline replay: importing DOM snapshots does not execute JavaScript or fetch URLs. */
export function compareRenderedSnapshots(input: {
  url: string;
  rawUrl?: string;
  renderedUrl?: string;
  rawHtml: string;
  renderedHtml: string;
  capturedAt: string;
  evidenceRef: string;
}) {
  if (
    !input ||
    typeof input.url !== "string" ||
    !guardUrl(input.url).allowed ||
    !guardUrl(input.rawUrl ?? input.url).allowed ||
    !guardUrl(input.renderedUrl ?? input.url).allowed ||
    typeof input.rawHtml !== "string" ||
    typeof input.renderedHtml !== "string" ||
    Buffer.byteLength(input.rawHtml) > RENDER_LIMITS.responseBytes ||
    Buffer.byteLength(input.renderedHtml) > RENDER_LIMITS.responseBytes ||
    typeof input.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(input.capturedAt)) ||
    typeof input.evidenceRef !== "string" ||
    !input.evidenceRef.trim()
  )
    throw new Error("Invalid or oversized snapshot input.");
  const links = (html: string, url: string) => {
    const document = tokenizeHtml(html, true);
    return [
      ...new Set(
        parseAnchors(html, documentBase(document, url), {
          exact: true,
          document,
          limit: html.length,
        }).map((a) => normalizeUrl(a.href)),
      ),
    ].sort();
  };
  const rawUrl = input.rawUrl ?? input.url;
  const renderedUrl = input.renderedUrl ?? input.url;
  const raw = links(input.rawHtml, rawUrl);
  const rendered = links(input.renderedHtml, renderedUrl);
  const rawSet = new Set(raw);
  const renderedSet = new Set(rendered);
  return {
    schemaVersion: 1,
    kind: "imported_snapshot_comparison" as const,
    url: input.url,
    urlContext: {
      requested: input.url,
      raw: rawUrl,
      rendered: renderedUrl,
      redirectRelationship: "not_inferred" as const,
    },
    capturedAt: input.capturedAt,
    evidenceRef: input.evidenceRef,
    hashes: {
      raw: createHash("sha256").update(input.rawHtml).digest("hex"),
      rendered: createHash("sha256").update(input.renderedHtml).digest("hex"),
    },
    raw,
    rendered,
    renderedOnly: rendered.filter((url) => !rawSet.has(url)),
    rawOnly: raw.filter((url) => !renderedSet.has(url)),
    indexability: "unknown" as const,
    limitations: [
      "Imported snapshots are caller assertions; no browser execution or search-engine indexing was verified.",
    ],
  };
}
