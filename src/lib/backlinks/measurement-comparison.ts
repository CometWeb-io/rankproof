import type { RunManifest } from "./measurement.server.ts";

function valid(manifest: RunManifest): boolean {
  return (
    !!manifest &&
    typeof manifest.extractionVersion === "string" &&
    typeof manifest.identityPolicy === "string" &&
    typeof manifest.domainPolicy === "string" &&
    !!manifest.scores &&
    typeof manifest.scores.version === "string" &&
    typeof manifest.scores.comparisonKey === "string" &&
    !!manifest.visibility &&
    typeof manifest.visibility.method === "string" &&
    typeof manifest.visibility.comparisonKey === "string"
  );
}

/** Revisions are provenance; versioned extraction and identity policies define compatibility. */
export function measurementComparability(previous: RunManifest, current: RunManifest) {
  const sameMethod =
    valid(previous) &&
    valid(current) &&
    previous.extractionVersion === current.extractionVersion &&
    previous.identityPolicy === current.identityPolicy &&
    previous.domainPolicy === current.domainPolicy;
  return {
    scores:
      sameMethod &&
      previous.scores.version === current.scores.version &&
      previous.scores.comparisonKey === current.scores.comparisonKey,
    visibility:
      sameMethod &&
      previous.visibility.method === current.visibility.method &&
      previous.visibility.measured &&
      current.visibility.measured &&
      previous.visibility.comparisonKey === current.visibility.comparisonKey,
  };
}

export function comparableObservationCohort(previous: RunManifest, current: RunManifest): boolean {
  return (
    valid(previous) &&
    valid(current) &&
    previous.extractionVersion === current.extractionVersion &&
    previous.identityPolicy === current.identityPolicy &&
    previous.domainPolicy === current.domainPolicy &&
    previous.cohort?.population === "verified_live_observations_v2" &&
    previous.cohort.population === current.cohort?.population &&
    previous.cohort?.key !== undefined &&
    previous.cohort.key === current.cohort?.key
  );
}
