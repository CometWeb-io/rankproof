/** Replay uses only retained decoded HTML and the same extractor as live verification. */
import { captureHash, validateEvidenceCapture } from "./evidence-capture.ts";
import { observeBacklinkResponse } from "./evidence-response.ts";

export function replayEvidenceCapture(value: unknown) {
  validateEvidenceCapture(value);
  const results = value.entries.map((entry) => {
    const response = entry.response;
    const observation = observeBacklinkResponse(
      entry.request,
      {
        status: response.status,
        text: response.text,
        finalUrl: response.final_url,
        contentType: response.content_type,
        truncated: !response.complete,
      },
      {
        checkedAt: entry.observation.checked_at,
        sourceRevision: entry.observation.source_revision,
      },
    );
    if (observation.status === "error")
      throw new Error("Captured response cannot establish a complete HTML observation.");
    if (captureHash(observation) !== captureHash(entry.observation))
      throw new Error("Captured HTML does not reproduce the claimed observation.");
    return observation;
  });
  return {
    ok: true as const,
    version: "evidence-replay-v1" as const,
    capture_hash: value.root_hash,
    integrity_scope: "retained_decoded_html_only" as const,
    coverage: {
      captured: value.entries.length,
      omitted: value.omitted.length,
      requested: value.entries.length + value.omitted.length,
      complete: value.omitted.length === 0,
    },
    results,
  };
}
