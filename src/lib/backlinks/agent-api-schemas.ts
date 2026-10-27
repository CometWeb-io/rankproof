import { SESSION_RETENTION, DURABLE_RETENTION } from "./agent-api-store.ts";
import {
  AGENT_INPUT_SCHEMAS,
  AGENT_OBSERVATION_SCHEMA,
  type AgentOperation,
} from "./agent-api-contract.ts";

const str = { type: "string" };
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const arr = (items: unknown) => ({ type: "array", items });
const timestamp = { type: "string", format: "date-time" };
const observation = AGENT_OBSERVATION_SCHEMA;
const retention = {
  anyOf: [SESSION_RETENTION, DURABLE_RETENTION].map((policy) =>
    obj(Object.fromEntries(Object.entries(policy).map(([key, value]) => [key, { const: value }]))),
  ),
};
const storedObservation = {
  ...obj({ ...observation.properties, observation_id: str }),
  allOf: observation.allOf,
};
const verifyOutput = obj({
  report_id: str,
  created_at: timestamp,
  results: arr(storedObservation),
  persistence: retention,
});
const imported = obj({
  source_url: str,
  target_url: str,
  verification_status: { const: "unverified" },
  provenance: obj({
    connector_id: { const: "byo-dataset" },
    dataset_id: str,
    dataset_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    format: { enum: ["csv", "json"] },
    imported_at: timestamp,
    row_number: { type: "integer", minimum: 1 },
    original_record: { type: "object" },
  }),
});
const relationship = {
  ...obj({
    pairId: str,
    sourceUrl: str,
    targetUrl: str,
    observedAt: timestamp,
    status: { enum: ["CONFIRMED", "REPORTED", "NOT_FOUND_IN_HTML", "BLOCKED", "UNKNOWN"] },
    extractionVersion: str,
    identityPolicy: str,
    representation: { enum: ["fetched_html", "rendered_dom"] },
    resolvedSourceUrl: nullable(str),
    responseHash: nullable(str),
    completeHtml: { type: "boolean" },
    anchor: str,
    rel: str,
    placement: str,
  }),
  required: [
    "pairId",
    "sourceUrl",
    "targetUrl",
    "observedAt",
    "status",
    "extractionVersion",
    "identityPolicy",
    "representation",
    "resolvedSourceUrl",
    "responseHash",
    "completeHtml",
  ],
};
export const AGENT_OUTPUT_SCHEMAS: Record<AgentOperation, object> = {
  capabilities: obj({
    api_version: { const: "1" },
    operations: arr(
      obj({ name: { enum: Object.keys(AGENT_INPUT_SCHEMAS) }, supported: { type: "boolean" } }),
    ),
    providers: arr(
      obj({
        id: str,
        kind: str,
        configured: { type: "boolean" },
        availability: { const: "not-probed" },
      }),
    ),
    persistence: retention,
    owner_data: { const: "explicit-credentials-in-process-only" },
    limits: obj({
      verify_items: { const: 50 },
      dataset_rows: { const: 1000 },
      dataset_bytes: { const: 1_000_000 },
      keywords: { const: 10 },
    }),
  }),
  verify_backlinks: verifyOutput,
  remeasure_backlinks: verifyOutput,
  serp_status: obj({
    observed_at: timestamp,
    queries: arr(
      obj({
        keyword: str,
        engine: { enum: ["bing", "duckduckgo", "mojeek", "brave", "google"] },
        market: { enum: ["pl", "us", "gb", "de", "fr", "es"] },
        device: { enum: ["desktop", "mobile"] },
        status: {
          enum: [
            "ok",
            "no-results",
            "blocked",
            "rate-limited",
            "parser-failed",
            "empty-response",
            "not-configured",
            "error",
          ],
        },
        target_position: nullable({ type: "integer", minimum: 1, maximum: 20 }),
        depth: { type: "integer", minimum: 0, maximum: 20 },
        results: arr(obj({ position: { type: "integer", minimum: 1 }, url: str, title: str })),
      }),
    ),
  }),
  import_dataset: obj({
    schema_version: { const: "1" },
    connector_id: { const: "byo-dataset" },
    status: { enum: ["ok", "no-results"] },
    records: arr(imported),
    observed_at: timestamp,
    reason: { type: "null" },
  }),
  diff: obj({
    comparison: obj({
      pairId: nullable(str),
      status: { enum: ["CONFIRMED_CHANGE", "CONFIRMED", "UNKNOWN"] },
      change: { enum: ["absent_in_representation", "attributes_changed", null] },
      scope: { enum: ["fetched_html", "rendered_dom", null] },
      firstObserved: nullable(timestamp),
      lastConfirmed: nullable(timestamp),
      lastAttempted: nullable(timestamp),
      previousEvidence: nullable(relationship),
      currentEvidence: nullable(relationship),
    }),
    evidence_origin: {
      enum: ["caller_supplied_untrusted", "rankproof_session", "rankproof_history"],
    },
    persistence: { const: "caller" },
  }),
  verify_evidence: obj({
    valid: { type: "boolean" },
    integrity_scope: { const: "internal_hashes_only" },
    persistence: { const: "caller" },
  }),
  get_evidence: obj({ report_id: str, observation: storedObservation, persistence: retention }),
  list_findings: obj({
    report_id: str,
    findings: arr(
      obj({
        observation_id: str,
        kind: {
          enum: [
            "link_present",
            "absent_in_fetched_html",
            "source_unavailable",
            "measurement_unknown",
          ],
        },
        scope: { enum: ["fetched_html", "http_resource", null] },
        reason: nullable(str),
      }),
    ),
    persistence: retention,
  }),
};
const error = obj({
  ok: { const: false },
  schema_version: { const: "1" },
  error: obj({
    code: { enum: ["invalid_input", "unsupported", "collection_failed"] },
    message: str,
  }),
});
export function agentResponseSchema(operation: AgentOperation) {
  return {
    anyOf: [
      obj({
        ok: { const: true },
        schema_version: { const: "1" },
        operation: { const: operation },
        data: AGENT_OUTPUT_SCHEMAS[operation],
      }),
      error,
    ],
  };
}

export function agentSchemaDocument() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "urn:rankproof:agent-api:1",
    title: "RankProof Agent API v1",
    $defs: Object.fromEntries(
      Object.keys(AGENT_INPUT_SCHEMAS).flatMap((name) => {
        const operation = name as AgentOperation;
        return [
          [`${name}_input`, AGENT_INPUT_SCHEMAS[operation]],
          [`${name}_response`, agentResponseSchema(operation)],
        ];
      }),
    ),
  };
}
export function agentOpenApiDocument() {
  return {
    openapi: "3.1.0",
    info: { title: "RankProof Agent API", version: "1.0.0" },
    servers: [{ url: "http://127.0.0.1:8788" }],
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    paths: Object.fromEntries(
      Object.keys(AGENT_INPUT_SCHEMAS).map((name) => {
        const operation = name as AgentOperation;
        return [
          `/v1/agent/${name}`,
          {
            post: {
              operationId: name,
              requestBody: {
                required: true,
                content: { "application/json": { schema: AGENT_INPUT_SCHEMAS[operation] } },
              },
              responses: Object.fromEntries([
                ...[200, 400, 422, 501].map((status) => [
                  status,
                  {
                    description:
                      status === 200
                        ? "Measurement or capability response"
                        : "Structured operation error",
                    content: { "application/json": { schema: agentResponseSchema(operation) } },
                  },
                ]),
                ...[401, 404, 405, 413, 415, 429, 503].map((status) => [
                  status,
                  { description: "Transport rejection" },
                ]),
              ]),
            },
          },
        ];
      }),
    ),
  };
}
