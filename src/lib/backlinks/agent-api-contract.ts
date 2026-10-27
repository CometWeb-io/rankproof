/** Versioned input contracts and observation projection; no I/O. */
const str = { type: "string" };
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const timestamp = { type: "string", format: "date-time" };
const observationFields = {
  source_url: str,
  target_url: str,
  status: { enum: ["confirmed", "not_found", "error"] },
  checked_at: timestamp,
  final_url: nullable(str),
  http_status: nullable({ type: "integer" }),
  anchor: nullable(str),
  rel: nullable(str),
  reason: nullable(str),
  evidence_kind: { enum: ["html_anchor", null] },
  observation_method: { const: "fetched_html" },
  absence_scope: { enum: ["fetched_html", "http_resource", null] },
  extraction_version: str,
  identity_policy: str,
  source_revision: nullable(str),
  response_hash: nullable(str),
  raw_href: nullable(str),
  resolved_href: nullable(str),
};
export const AGENT_OBSERVATION_SCHEMA = {
  ...obj(observationFields),
  allOf: [
    {
      anyOf: [
        {
          type: "object",
          properties: { status: { enum: ["not_found", "error"] } },
          required: ["status"],
        },
        {
          type: "object",
          properties: {
            status: { const: "confirmed" },
            evidence_kind: { const: "html_anchor" },
            absence_scope: { type: "null" },
            response_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
            final_url: { type: "string", minLength: 1 },
            raw_href: { type: "string", minLength: 1 },
            resolved_href: { type: "string", minLength: 1 },
            http_status: { type: "integer", minimum: 200, maximum: 299 },
          },
          required: [
            "status",
            "evidence_kind",
            "absence_scope",
            "response_hash",
            "final_url",
            "raw_href",
            "resolved_href",
            "http_status",
          ],
        },
      ],
    },
  ],
};
const text = (maxLength: number, minLength = 1) => ({ type: "string", minLength, maxLength });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const array = (items: unknown, maxItems: number, minItems = 1) => ({
  type: "array",
  items,
  minItems,
  maxItems,
});
const url = { ...text(2048), format: "uri", pattern: "^https?://" };
const pair = object({ source_url: url, target_url: url });
const verifyInput = object({ items: array(pair, 50) });
const noInput = object({});
const serpInput = object(
  {
    url: text(400, 3),
    keywords: array(text(80, 2), 10),
    engines: array(
      { type: "string", enum: ["bing", "duckduckgo", "mojeek", "brave", "google"] },
      5,
    ),
    depth: { type: "integer", enum: [10, 20] },
    market: { type: "string", enum: ["pl", "us", "gb", "de", "fr", "es"] },
    device: { type: "string", enum: ["desktop", "mobile"] },
  },
  ["url", "keywords"],
);

export const AGENT_INPUT_SCHEMAS = {
  capabilities: noInput,
  verify_backlinks: verifyInput,
  remeasure_backlinks: verifyInput,
  serp_status: serpInput,
  import_dataset: object({
    format: { type: "string", enum: ["csv", "json"] },
    data: text(1_000_000, 0),
    dataset_id: text(200),
  }),
  get_evidence: object({ observation_id: text(200) }),
  diff: {
    anyOf: [
      object({ observations: array(AGENT_OBSERVATION_SCHEMA, 100) }),
      object({ before_id: text(200), after_id: text(200) }),
    ],
  },
  verify_evidence: object({ ledger: { type: "object" } }),
  list_findings: object({ report_id: text(200) }),
} as const;
export type AgentOperation = keyof typeof AGENT_INPUT_SCHEMAS;

/** Validate against our small, closed input-schema vocabulary before any I/O. */
export function validateAgentSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path = "input",
): void {
  for (const branch of (schema.allOf ?? []) as Record<string, unknown>[])
    validateAgentSchema(value, branch, path);
  if (schema.not) throw new Error(`Unsupported ${path}.`);
  if (schema.anyOf) {
    if (
      !(schema.anyOf as Record<string, unknown>[]).some((branch) => {
        try {
          validateAgentSchema(value, branch, path);
          return true;
        } catch {
          return false;
        }
      })
    )
      throw new Error(`Invalid ${path}.`);
    return;
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const)
    throw new Error(`Invalid ${path} constant.`);
  const type = schema.type;
  if (type === "boolean" && typeof value !== "boolean") throw new Error(`Invalid ${path} boolean.`);
  if (
    type === "integer" &&
    (typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < Number(schema.minimum ?? -Infinity) ||
      value > Number(schema.maximum ?? Infinity))
  )
    throw new Error(`Invalid ${path} integer.`);
  if (type === "null" && value !== null) throw new Error(`Invalid ${path}, expected null.`);
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`${path} must be an object.`);
    const data = value as Record<string, unknown>,
      properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema.required ?? []) as string[])
      if (!Object.hasOwn(data, key)) throw new Error(`${path}.${key} is required.`);
    for (const [key, field] of Object.entries(data)) {
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) throw new Error(`Unknown field ${path}.${key}.`);
      } else if (field !== undefined || ((schema.required ?? []) as string[]).includes(key))
        validateAgentSchema(field, properties[key]!, `${path}.${key}`);
    }
  } else if (type === "array") {
    if (
      !Array.isArray(value) ||
      value.length < Number(schema.minItems ?? 0) ||
      value.length > Number(schema.maxItems ?? Infinity)
    )
      throw new Error(`Invalid ${path} array size.`);
    value.forEach((item, index) =>
      validateAgentSchema(item, schema.items as Record<string, unknown>, `${path}[${index}]`),
    );
  } else if (type === "string") {
    if (
      typeof value !== "string" ||
      Array.from(value).length < Number(schema.minLength ?? 0) ||
      Array.from(value).length > Number(schema.maxLength ?? Infinity)
    )
      throw new Error(`Invalid ${path} string.`);
    if (
      schema.format === "date-time" &&
      (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        value as string,
      ) ||
        !Number.isFinite(Date.parse(value as string)))
    )
      throw new Error(`Invalid ${path} timestamp.`);
    if (schema.pattern && !new RegExp(String(schema.pattern)).test(value as string))
      throw new Error(`Invalid ${path} URL.`);
  }
  if (schema.enum && !(schema.enum as unknown[]).includes(value))
    throw new Error(`Unknown ${path} value.`);
}

/** Preserve exact URL path/query/www identity; fragments do not identify resources. */
export function validateObservationConsistency(row: Record<string, unknown>): void {
  if (row.status !== "confirmed") return;
  const exact = (value: unknown) => {
    if (typeof value !== "string") throw new Error("Confirmed observation requires URLs.");
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("Expected HTTP(S) observation URL.");
    url.hash = "";
    return url.href;
  };
  if (exact(row.resolved_href) !== exact(row.target_url))
    throw new Error("Confirmed resolved_href does not match exact target_url.");
  exact(row.final_url);
}
