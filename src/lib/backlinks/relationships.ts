import type { BacklinkObservation } from "./verify-api.server.ts";
import { backlinkId } from "./score.ts";

export type RelationshipObservation = {
  pairId: string;
  sourceUrl: string;
  targetUrl: string;
  observedAt: string;
  status: "CONFIRMED" | "REPORTED" | "NOT_FOUND_IN_HTML" | "BLOCKED" | "UNKNOWN";
  extractionVersion: string;
  identityPolicy: string;
  representation: "fetched_html" | "rendered_dom";
  resolvedSourceUrl: string | null;
  responseHash: string | null;
  completeHtml: boolean;
  anchor?: string;
  rel?: string;
  placement?: string;
  attributeExtractionVersion?: string;
  contextHash?: string;
  linkKind?: "image" | "text";
};

/** A later observation must refer to the same measured resource and extraction cohort. */
export function relationshipComparable(
  before: RelationshipObservation,
  after: RelationshipObservation,
): boolean {
  return (
    before.pairId === after.pairId &&
    before.sourceUrl === after.sourceUrl &&
    before.targetUrl === after.targetUrl &&
    Date.parse(before.observedAt) < Date.parse(after.observedAt) &&
    Boolean(before.extractionVersion?.trim()) &&
    Boolean(before.identityPolicy?.trim()) &&
    before.extractionVersion === after.extractionVersion &&
    before.identityPolicy === after.identityPolicy &&
    before.representation === after.representation &&
    Boolean(before.resolvedSourceUrl) &&
    before.resolvedSourceUrl === after.resolvedSourceUrl
  );
}

/** A disappeared discovery candidate is never a relationship-loss observation. */
export function compareRelationship(observations: RelationshipObservation[]) {
  const ordered = observations
    .filter((row) => Number.isFinite(Date.parse(row.observedAt)))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const last = ordered.at(-1);
  const samePair = last
    ? ordered.filter(
        (row) =>
          row.pairId === last.pairId &&
          row.sourceUrl === last.sourceUrl &&
          row.targetUrl === last.targetUrl,
      )
    : [];
  const confirmed = samePair.filter(
    (row) =>
      row.status === "CONFIRMED" &&
      row.completeHtml &&
      /^[a-f0-9]{64}$/.test(row.responseHash ?? ""),
  );
  const previous = confirmed
    .filter((row) => row !== last && Date.parse(row.observedAt) < Date.parse(last!.observedAt))
    .at(-1);
  const comparable = !!last && !!previous && relationshipComparable(previous, last);
  const proof = !!last && last.completeHtml && /^[a-f0-9]{64}$/.test(last.responseHash ?? "");
  const absent = comparable && proof && last.status === "NOT_FOUND_IN_HTML";
  const changedFields =
    comparable && proof && last.status === "CONFIRMED"
      ? (["anchor", "rel", "placement", "contextHash", "linkKind"] as const).filter(
          (key) =>
            previous[key] !== undefined &&
            last[key] !== undefined &&
            (key === "anchor" ||
              key === "rel" ||
              (previous.attributeExtractionVersion === "html-relationship-context-v1" &&
                previous.attributeExtractionVersion === last.attributeExtractionVersion)) &&
            previous[key] !== last[key],
        )
      : [];
  const attributesChanged = changedFields.length > 0;
  return {
    pairId: last?.pairId ?? null,
    status:
      absent || attributesChanged
        ? "CONFIRMED_CHANGE"
        : proof && last?.status === "CONFIRMED"
          ? "CONFIRMED"
          : "UNKNOWN",
    change: absent ? "absent_in_representation" : attributesChanged ? "attributes_changed" : null,
    scope: last?.representation ?? null,
    firstObserved: samePair[0]?.observedAt ?? null,
    lastConfirmed: confirmed.at(-1)?.observedAt ?? null,
    lastAttempted: last?.observedAt ?? null,
    previousEvidence: previous ?? null,
    currentEvidence: last ?? null,
  };
}

/** The verifier's explicit HTML absence is narrower than rendered-page link loss. */
export function relationshipObservation(observation: BacklinkObservation): RelationshipObservation {
  return {
    pairId: backlinkId({ sourceUrl: observation.source_url, targetUrl: observation.target_url }),
    sourceUrl: observation.source_url,
    targetUrl: observation.target_url,
    observedAt: observation.checked_at,
    status:
      observation.status === "confirmed"
        ? "CONFIRMED"
        : observation.status === "not_found" && observation.absence_scope === "fetched_html"
          ? "NOT_FOUND_IN_HTML"
          : "UNKNOWN",
    extractionVersion: observation.extraction_version,
    identityPolicy: observation.identity_policy,
    representation: observation.observation_method,
    resolvedSourceUrl: observation.final_url,
    responseHash: observation.response_hash,
    completeHtml:
      observation.status === "confirmed" ||
      (observation.status === "not_found" && observation.absence_scope === "fetched_html"),
    anchor: observation.anchor ?? undefined,
    rel: observation.rel ?? undefined,
    ...(observation.relationship_context
      ? {
          attributeExtractionVersion: observation.relationship_context.version,
          placement: observation.relationship_context.placement,
          contextHash: observation.relationship_context.excerpt_hash ?? undefined,
          linkKind: observation.relationship_context.link_kind,
        }
      : {}),
  };
}
