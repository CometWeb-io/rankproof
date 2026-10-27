/** Shared, network-free extraction from the exact decoded response inspected live. */
import { MIMEType } from "node:util";
import { documentBase, parseAnchors, decodeText, decodeAttribute, parseTagAttrs } from "./html.ts";
import { tokenizeHtml, type HtmlDocument } from "./html-tokenizer.ts";
import { hostFromUrl, isTargetHost, URL_IDENTITY_POLICY } from "./parse.ts";
import { EXTRACTION_VERSION, responseHash } from "./measurement.server.ts";
import type { BacklinkObservation, VerifyPair } from "./verify-api.server.ts";

export type BacklinkResponse = {
  status: number;
  text: string;
  finalUrl: string;
  contentType: string;
  truncated: boolean;
};
export type ObservationContext = { checkedAt: string; sourceRevision: string | null };

export function emptyBacklinkObservation(
  pair: VerifyPair,
  context: ObservationContext,
): BacklinkObservation {
  return {
    ...pair,
    status: "error",
    checked_at: context.checkedAt,
    final_url: null,
    http_status: null,
    anchor: null,
    rel: null,
    reason: null,
    evidence_kind: null,
    observation_method: "fetched_html",
    absence_scope: null,
    extraction_version: EXTRACTION_VERSION,
    identity_policy: URL_IDENTITY_POLICY,
    source_revision: context.sourceRevision,
    response_hash: null,
    raw_href: null,
    resolved_href: null,
    matching_anchors: [],
  };
}
function exactUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  return url.href;
}

/** The text transport supports UTF-8; other declarations cannot establish HTML facts. */
export function assertUtf8HtmlEncoding(
  text: string,
  contentType: string,
  document?: HtmlDocument,
): void {
  if (text.includes("\0")) throw new Error("HTML contains NUL; UTF-8 text decoding is uncertain.");
  const charset = (value: string) => {
    try {
      return new MIMEType(value).params.get("charset") ?? undefined;
    } catch {
      throw new Error("Invalid HTML content-type declaration.");
    }
  };
  const supported = (label: string) => {
    try {
      if (label.trim() && new TextDecoder(label.trim()).encoding === "utf-8") return;
    } catch {
      /* Unknown labels are unavailable, not HTML absence. */
    }
    throw new Error("Unsupported HTML character encoding; UTF-8 text is required.");
  };
  const declared = charset(contentType);
  if (declared !== undefined) supported(declared);
  if (/^application\/xhtml\+xml(?:;|$)/i.test(contentType)) {
    const xml = text.match(/^\s*<\?xml\b([\s\S]*?)\?>/i);
    if (xml) {
      const attributes = parseTagAttrs(xml[1] ?? "");
      if (Object.hasOwn(attributes, "encoding")) supported(attributes.encoding ?? "");
    }
  }
  if (declared !== undefined) return;
  for (const token of (document ?? tokenizeHtml(text)).tokens) {
    if (token.closing || token.name !== "meta") continue;
    const label = Object.hasOwn(token.attrs, "charset")
      ? decodeAttribute(token.attrs.charset ?? "")
      : decodeAttribute(token.attrs["http-equiv"] ?? "")
            .trim()
            .toLowerCase() === "content-type"
        ? charset(decodeAttribute(token.attrs.content ?? ""))
        : undefined;
    if (label !== undefined) {
      supported(label);
      return;
    }
  }
}

/** Complete HTML admission shared by raw extraction and optional browser navigation. */
export function parseHtmlResponse(res: BacklinkResponse) {
  if (res.status < 200 || res.status >= 300) throw new Error(`Source returned HTTP ${res.status}.`);
  const contentType = res.contentType;
  if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) {
    throw new Error("Source did not return HTML.");
  }
  if (!res.text.trim()) throw new Error("Source returned an empty document.");
  if (res.truncated) throw new Error("Source HTML exceeds the verification size limit.");
  const document = tokenizeHtml(res.text, true);
  assertUtf8HtmlEncoding(res.text, contentType, document);
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
  return document;
}

export function observeBacklinkResponse(
  pair: VerifyPair,
  res: BacklinkResponse,
  context: ObservationContext,
  options: { relationshipContext?: boolean } = {},
): BacklinkObservation {
  const result = emptyBacklinkObservation(pair, context);
  result.final_url = res.finalUrl;
  result.http_status = res.status;
  result.response_hash = responseHash(res.text);
  try {
    if (isTargetHost(hostFromUrl(pair.source_url), hostFromUrl(pair.target_url)))
      throw new Error("Source belongs to target site; this is an internal link.");
    if (isTargetHost(hostFromUrl(res.finalUrl), hostFromUrl(pair.target_url))) {
      throw new Error("Source redirected into the target site; this is an internal link.");
    }
    if (res.status === 404 || res.status === 410) {
      result.status = "not_found";
      result.reason = `Source returned HTTP ${res.status}.`;
      result.absence_scope = "http_resource";
      return result;
    }
    const document = parseHtmlResponse(res);
    const anchors = parseAnchors(res.text, documentBase(document, res.finalUrl), {
      limit: Number.MAX_SAFE_INTEGER,
      withPlacement: options.relationshipContext === true,
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
      if (options.relationshipContext) {
        const text = decodeText(document.visibleText).replace(/\s+/g, " ").trim();
        // Prefix tokenization locates this anchor even when its text appeared earlier.
        const before = decodeText(tokenizeHtml(res.text.slice(0, match.index)).visibleText)
          .replace(/\s+/g, " ")
          .trim();
        const excerpt = text.startsWith(before)
          ? text
              .slice(Math.max(0, before.length - 140), before.length + match.text.length + 140)
              .trim()
              .slice(0, 400)
          : null;
        result.relationship_context = {
          version: "html-relationship-context-v1",
          primary_match: "first_matching_html_anchor",
          matching_anchor_count: matches.length,
          placement: match.placement,
          placement_is_heuristic: true,
          link_kind: match.isImage ? "image" : "text",
          text_scope: "parser_text_not_rendered",
          excerpt,
          excerpt_hash: excerpt === null ? null : responseHash(excerpt),
        };
      }
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
    result.reason = error instanceof Error ? error.message.slice(0, 160) : "Source error";
  }
  return result;
}
