/** Explicit held-out evaluation. This module never turns heuristic scores into probabilities. */
import { createHash } from "node:crypto";
import { registrableDomain } from "./parse.ts";

export const CALIBRATION_POLICY = Object.freeze({
  tuningCases: 100,
  holdoutCases: 200,
  tuningSources: 20,
  holdoutSources: 30,
  tuningEachClass: 10,
  holdoutEachClass: 20,
  reliabilityBins: 10,
});
export type CalibrationCase = {
  id: string;
  sourceUrl: string;
  targetUrl: string;
  sourceContent: string;
  groundTruth: {
    label: 0 | 1;
    kind: "synthetic" | "human_annotated";
    annotatedBy: string;
    annotatedAt: string;
    evidenceRef: string;
  };
};
export type CalibrationDataset = {
  schemaVersion: 1;
  datasetId: string;
  kind: "synthetic" | "observed";
  cases: CalibrationCase[];
};
export type FrozenHoldout = {
  schemaVersion: 1;
  kind: "frozen_calibration_holdout";
  datasetId: string;
  datasetHash: string;
  frozenAt: string;
  frozenBy: string;
  tuningDatasetId: string;
  tuningDatasetHash: string;
  policyHash: string;
  caseIds: string[];
  sourceIdentities: string[];
  contentHashes: string[];
};
export type CalibrationStudy = {
  schemaVersion: 1;
  candidateId: string;
  event: "exact_html_anchor_present";
  predictionKind: "probability" | "heuristic_score" | "none";
  predictionEvidenceRef: string;
  predictedAt: string;
  tuning: CalibrationDataset;
  holdout: CalibrationDataset;
  predictions: { caseId: string; value: number | null }[];
};
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compareText(a, b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown): value is string =>
  text(value) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
function url(raw: unknown): string {
  if (!text(raw) || raw.length > 2048)
    throw new Error("Calibration needs bounded source/target HTTP URLs.");
  const parsed = new URL(raw);
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error("Invalid calibration URL.");
  parsed.hash = "";
  return parsed.href;
}

/** Validated labels remain contributor assertions; source authenticity is an external gate. */
export function calibrationDataset(input: unknown): CalibrationDataset {
  if (
    !record(input) ||
    input.schemaVersion !== 1 ||
    !text(input.datasetId) ||
    input.datasetId.length > 200 ||
    !["synthetic", "observed"].includes(String(input.kind)) ||
    !Array.isArray(input.cases) ||
    !input.cases.length ||
    input.cases.length > 10000
  )
    throw new Error("Invalid calibration dataset.");
  const ids = new Set<string>();
  const contents = new Set<string>();
  let bytes = 0;
  const cases = input.cases
    .map((row): CalibrationCase => {
      if (
        !record(row) ||
        !text(row.id) ||
        row.id.length > 200 ||
        ids.has(row.id) ||
        !text(row.sourceContent) ||
        !record(row.groundTruth)
      )
        throw new Error("Invalid, duplicate or unlabelled calibration case.");
      const truth = row.groundTruth;
      if (
        (truth.label !== 0 && truth.label !== 1) ||
        !["synthetic", "human_annotated"].includes(String(truth.kind)) ||
        !text(truth.annotatedBy) ||
        !timestamp(truth.annotatedAt) ||
        !text(truth.evidenceRef)
      )
        throw new Error("Missing binary ground truth or annotation provenance.");
      if ((input.kind === "observed") !== (truth.kind === "human_annotated"))
        throw new Error(
          "Observed labels require human annotation; synthetic labels must remain synthetic.",
        );
      bytes += Buffer.byteLength(row.sourceContent);
      if (Buffer.byteLength(row.sourceContent) > 2000000 || bytes > 20000000)
        throw new Error("Calibration source-content limit exceeded.");
      const contentHash = hash(row.sourceContent);
      if (contents.has(contentHash))
        throw new Error("Duplicate source content cannot increase the independent case count.");
      contents.add(contentHash);
      ids.add(row.id);
      return {
        id: row.id,
        sourceUrl: url(row.sourceUrl),
        targetUrl: url(row.targetUrl),
        sourceContent: row.sourceContent,
        groundTruth: {
          label: truth.label,
          kind: truth.kind as CalibrationCase["groundTruth"]["kind"],
          annotatedBy: truth.annotatedBy,
          annotatedAt: truth.annotatedAt,
          evidenceRef: truth.evidenceRef,
        },
      };
    })
    .sort((a, b) => compareText(a.id, b.id));
  return {
    schemaVersion: 1,
    datasetId: input.datasetId,
    kind: input.kind as CalibrationDataset["kind"],
    cases,
  };
}
function identity(dataset: CalibrationDataset) {
  return {
    datasetId: dataset.datasetId,
    datasetHash: hash(dataset),
    caseIds: dataset.cases.map((c) => c.id).sort(),
    sourceIdentities: [
      ...new Set(dataset.cases.map((c) => registrableDomain(new URL(c.sourceUrl).hostname))),
    ].sort(),
    contentHashes: dataset.cases.map((c) => hash(c.sourceContent)).sort(),
  };
}
function minimum(dataset: CalibrationDataset, role: "tuning" | "holdout") {
  const policy = CALIBRATION_POLICY;
  const counts = identity(dataset);
  const cases = role === "holdout" ? policy.holdoutCases : policy.tuningCases;
  const sources = role === "holdout" ? policy.holdoutSources : policy.tuningSources;
  const eachClass = role === "holdout" ? policy.holdoutEachClass : policy.tuningEachClass;
  const positives = dataset.cases.filter((c) => c.groundTruth.label === 1).length;
  if (
    dataset.cases.length < cases ||
    counts.sourceIdentities.length < sources ||
    positives < eachClass ||
    dataset.cases.length - positives < eachClass
  )
    throw new Error(
      `${role} requires at least ${cases} cases, ${sources} source domains and ${eachClass} labels of each class; this floor is not statistical qualification.`,
    );
}
export function freezeCalibrationHoldout(
  input: unknown,
  frozenBy: string,
  frozenAt = new Date().toISOString(),
): FrozenHoldout {
  if (!record(input)) throw new Error("Freeze requires both tuning and holdout partitions.");
  const dataset = calibrationDataset(input.holdout);
  const tuning = calibrationDataset(input.tuning);
  minimum(dataset, "holdout");
  minimum(tuning, "tuning");
  const tune = identity(tuning),
    holdout = identity(dataset);
  if (tuning.kind !== dataset.kind || tuning.datasetId === dataset.datasetId)
    throw new Error("Tuning and holdout need matching kinds and distinct dataset IDs.");
  assertDisjoint(tune.caseIds, holdout.caseIds, "case identities");
  assertDisjoint(tune.sourceIdentities, holdout.sourceIdentities, "source domains");
  assertDisjoint(tune.contentHashes, holdout.contentHashes, "source content");
  if (!text(frozenBy) || !timestamp(frozenAt))
    throw new Error("Holdout freeze needs an actor and timestamp.");
  if (
    [...dataset.cases, ...tuning.cases].some(
      (c) => Date.parse(c.groundTruth.annotatedAt) > Date.parse(frozenAt),
    )
  )
    throw new Error("Ground truth was annotated after the claimed freeze.");
  return {
    schemaVersion: 1,
    kind: "frozen_calibration_holdout",
    ...holdout,
    frozenAt,
    frozenBy,
    tuningDatasetId: tuning.datasetId,
    tuningDatasetHash: tune.datasetHash,
    policyHash: hash(CALIBRATION_POLICY),
  };
}
function assertDisjoint(a: string[], b: string[], what: string) {
  const prior = new Set(a);
  if (b.some((value) => prior.has(value)))
    throw new Error(`Tuning/holdout leakage: shared ${what}.`);
}

/** Freeze and source-disjointness are checked before evaluating any holdout prediction. */
export function evaluateCalibrationStudy(
  input: unknown,
  frozen: unknown,
  previouslyUsedHashes: readonly string[] = [],
) {
  if (
    !record(input) ||
    input.schemaVersion !== 1 ||
    !text(input.candidateId) ||
    input.event !== "exact_html_anchor_present" ||
    !["probability", "heuristic_score", "none"].includes(String(input.predictionKind)) ||
    !text(input.predictionEvidenceRef) ||
    !timestamp(input.predictedAt) ||
    !Array.isArray(input.predictions) ||
    input.predictions.length > 10000
  )
    throw new Error("Invalid calibration study or probability event.");
  const tuning = calibrationDataset(input.tuning);
  const holdout = calibrationDataset(input.holdout);
  minimum(tuning, "tuning");
  minimum(holdout, "holdout");
  if (tuning.kind !== holdout.kind)
    throw new Error("Synthetic tuning and observed holdout cannot be mixed.");
  if (
    !record(frozen) ||
    frozen.schemaVersion !== 1 ||
    frozen.kind !== "frozen_calibration_holdout" ||
    !timestamp(frozen.frozenAt) ||
    !text(frozen.frozenBy)
  )
    throw new Error("Missing frozen holdout manifest.");
  const expectedFreeze = freezeCalibrationHoldout(
    { tuning, holdout },
    frozen.frozenBy,
    frozen.frozenAt,
  );
  if (hash(frozen) !== hash(expectedFreeze))
    throw new Error("Frozen holdout manifest or dataset content hash does not match.");
  const holdoutIdentity = identity(holdout);
  const tuningIdentity = identity(tuning);
  if (holdout.datasetId === tuning.datasetId)
    throw new Error("Tuning/holdout dataset IDs must be distinct.");
  if (previouslyUsedHashes.includes(holdoutIdentity.datasetHash))
    throw new Error("Frozen holdout has already been evaluated; obtain a new independent holdout.");
  assertDisjoint(tuningIdentity.caseIds, holdoutIdentity.caseIds, "case identities");
  assertDisjoint(
    tuningIdentity.sourceIdentities,
    holdoutIdentity.sourceIdentities,
    "source domains",
  );
  assertDisjoint(tuningIdentity.contentHashes, holdoutIdentity.contentHashes, "source content");
  const freezeTime = Date.parse(frozen.frozenAt);
  if (Date.parse(input.predictedAt) < freezeTime)
    throw new Error("Predictions must reference the frozen holdout after its freeze.");
  if (tuning.cases.some((c) => Date.parse(c.groundTruth.annotatedAt) > freezeTime))
    throw new Error("Tuning annotations changed after holdout freeze; freeze a fresh study.");
  const predicted = new Map<string, number | null>();
  const ids = new Set(holdoutIdentity.caseIds);
  for (const row of input.predictions) {
    if (
      !record(row) ||
      !text(row.caseId) ||
      !ids.has(row.caseId) ||
      predicted.has(row.caseId) ||
      (row.value !== null && (typeof row.value !== "number" || !Number.isFinite(row.value)))
    )
      throw new Error("Invalid, duplicate or out-of-holdout prediction.");
    if (
      input.predictionKind === "probability" &&
      row.value !== null &&
      ((row.value as number) < 0 || (row.value as number) > 1)
    )
      throw new Error(
        "Probabilities must lie in [0,1]; heuristic scores must not be divided by 100.",
      );
    if (input.predictionKind === "none" && row.value !== null)
      throw new Error("A non-predictive study cannot carry numeric predictions.");
    predicted.set(row.caseId, row.value as number | null);
  }
  const complete =
    predicted.size === holdout.cases.length && [...predicted.values()].every((p) => p !== null);
  const probabilities = input.predictionKind === "probability" && complete;
  const bins = Array.from({ length: CALIBRATION_POLICY.reliabilityBins }, (_, index) => ({
    lower: index / 10,
    upper: (index + 1) / 10,
    count: 0,
    probabilitySum: 0,
    positives: 0,
  }));
  let squaredError = 0;
  if (probabilities)
    for (const row of holdout.cases) {
      const prediction = predicted.get(row.id)!;
      const p = prediction as number;
      squaredError += (p - row.groundTruth.label) ** 2;
      const bin = bins[Math.min(9, Math.floor(p * 10))]!;
      bin.count++;
      bin.probabilitySum += p;
      bin.positives += row.groundTruth.label;
    }
  const reliability = probabilities
    ? bins.map((bin) => ({
        lower: bin.lower,
        upper: bin.upper,
        count: bin.count,
        meanProbability: bin.count ? bin.probabilitySum / bin.count : null,
        observedFraction: bin.count ? bin.positives / bin.count : null,
      }))
    : null;
  const ece =
    reliability?.reduce(
      (sum, bin) =>
        sum +
        (bin.count
          ? (bin.count / holdout.cases.length) *
            Math.abs(bin.meanProbability! - bin.observedFraction!)
          : 0),
      0,
    ) ?? null;
  return {
    schemaVersion: 1,
    candidateId: input.candidateId,
    event: input.event,
    status: probabilities
      ? holdout.kind === "synthetic"
        ? "synthetic_evaluation"
        : "heldout_probability_evaluation"
      : "not_calibrated",
    calibrationQualified: false,
    freezeHash: hash(expectedFreeze),
    tuning: tuningIdentity,
    holdout: holdoutIdentity,
    datasetKind: holdout.kind,
    predictionKind: input.predictionKind,
    predictionEvidenceRef: input.predictionEvidenceRef,
    predictedAt: input.predictedAt,
    predictionsHash: hash([...predicted].sort(([a], [b]) => compareText(a, b))),
    predictions: {
      expected: holdout.cases.length,
      supplied: predicted.size,
      missing: holdout.cases.length - predicted.size,
      null: [...predicted.values()].filter((p) => p === null).length,
    },
    brier: probabilities ? squaredError / holdout.cases.length : null,
    ece,
    reliability,
    reason: probabilities
      ? "Descriptive held-out metrics do not by themselves certify calibration or label authenticity."
      : "No complete set of explicit event probabilities; no calibration metrics inferred from scores.",
    externalGates: [
      "Independently review source authenticity, label correctness, annotation independence and collection rights.",
      "Freeze the training procedure and acceptance thresholds before accessing holdout outcomes.",
      "Demonstrate external validity on the intended production population; synthetic fixtures cannot satisfy this gate.",
    ],
    limitations: [
      "No fitting or tuning is performed and no production score is changed.",
      "Human annotation and freeze times are supplied assertions, not remotely attested facts.",
      "Minimum sizes are admission floors, not a statistical guarantee; source observations may remain correlated.",
      "The CLI retains source-content-hash keyed single-use receipts in the frozen manifest directory. Pure callers must persist and supply all previously used holdout hashes; filesystem owners can copy manifests to new directories or erase local audit records.",
    ],
  };
}
