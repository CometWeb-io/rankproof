/** JSON Schema 2020-12 for the offline evaluator; cross-partition checks are runtime gates. */
const nonempty = { type: "string", minLength: 1 };
const caseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "sourceUrl", "targetUrl", "sourceContent", "groundTruth"],
  properties: {
    id: { ...nonempty, maxLength: 200 },
    sourceUrl: { ...nonempty, format: "uri", maxLength: 2048 },
    targetUrl: { ...nonempty, format: "uri", maxLength: 2048 },
    sourceContent: { ...nonempty, maxLength: 2000000 },
    groundTruth: {
      type: "object",
      additionalProperties: false,
      required: ["label", "kind", "annotatedBy", "annotatedAt", "evidenceRef"],
      properties: {
        label: { enum: [0, 1] },
        kind: { enum: ["synthetic", "human_annotated"] },
        annotatedBy: nonempty,
        annotatedAt: { type: "string", format: "date-time" },
        evidenceRef: nonempty,
      },
    },
  },
};
const datasetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "datasetId", "kind", "cases"],
  properties: {
    schemaVersion: { const: 1 },
    datasetId: { ...nonempty, maxLength: 200 },
    kind: { enum: ["synthetic", "observed"] },
    cases: { type: "array", minItems: 100, maxItems: 10000, items: { $ref: "#/$defs/case" } },
  },
};
export const CALIBRATION_STUDY_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:rankproof:calibration-study:v1",
  title: "RankProof held-out calibration study v1",
  description:
    "Labels and prediction meaning require independent external review. Runtime additionally enforces source/case/content separation, frozen hashes, class/source admission floors and single-use holdout receipts.",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "candidateId",
    "event",
    "predictionKind",
    "predictionEvidenceRef",
    "predictedAt",
    "tuning",
    "holdout",
    "predictions",
  ],
  properties: {
    schemaVersion: { const: 1 },
    candidateId: nonempty,
    event: { const: "exact_html_anchor_present" },
    predictionKind: { enum: ["probability", "heuristic_score", "none"] },
    predictionEvidenceRef: nonempty,
    predictedAt: { type: "string", format: "date-time" },
    tuning: { $ref: "#/$defs/dataset" },
    holdout: { allOf: [{ $ref: "#/$defs/dataset" }, { properties: { cases: { minItems: 200 } } }] },
    predictions: {
      type: "array",
      maxItems: 10000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["caseId", "value"],
        properties: { caseId: nonempty, value: { type: ["number", "null"] } },
      },
    },
  },
  allOf: [
    {
      if: { properties: { predictionKind: { const: "probability" } } },
      then: {
        properties: {
          predictions: {
            items: { properties: { value: { type: ["number", "null"], minimum: 0, maximum: 1 } } },
          },
        },
      },
    },
    {
      if: { properties: { predictionKind: { const: "none" } } },
      then: { properties: { predictions: { items: { properties: { value: { type: "null" } } } } } },
    },
  ],
  $defs: { case: caseSchema, dataset: datasetSchema },
};
