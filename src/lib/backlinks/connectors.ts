/** Connector SDK: discovery records are claims, never backlink confirmations. */
import { createHash } from "node:crypto";
import { guardUrl } from "./ssrf.ts";

export const CONNECTOR_SCHEMA_VERSION = "1" as const;
export type ConnectorStatus =
  "ok" | "no-results" | "not-configured" | "blocked" | "rate-limited" | "error";
export type ConnectorCapability = "backlinks.discover" | "serp.query" | "owner.performance";
export type ConnectorManifest = {
  schema_version: "1";
  id: string;
  capabilities: ConnectorCapability[];
  credentials: "none" | "caller";
};
export type ConnectorResult<T> = {
  schema_version: "1";
  connector_id: string;
  status: ConnectorStatus;
  records: T[];
  observed_at: string;
  reason: string | null;
};
export interface DataConnector<I, O> {
  manifest: ConnectorManifest;
  collect(input: I): Promise<ConnectorResult<O>>;
}
export type ImportedCandidate = {
  source_url: string;
  target_url: string;
  verification_status: "unverified";
  provenance: {
    connector_id: "byo-dataset";
    dataset_id: string;
    dataset_sha256: string;
    format: "csv" | "json";
    imported_at: string;
    row_number: number;
    original_record: Record<string, unknown>;
  };
};
export type DatasetInput = { format: "csv" | "json"; data: string; dataset_id: string };
export const DATASET_MAX_BYTES = 1_000_000;
export const DATASET_MAX_ROWS = 1000;

export function connectorResult<T>(
  id: string,
  status: ConnectorStatus,
  records: T[],
  reason: string | null = null,
): ConnectorResult<T> {
  if (status !== "ok" && records.length)
    throw new Error("Failed or empty connectors cannot carry records.");
  if (status === "ok" && !records.length)
    throw new Error("Use no-results for a successful empty collection.");
  return {
    schema_version: CONNECTOR_SCHEMA_VERSION,
    connector_id: id,
    status,
    records,
    observed_at: new Date().toISOString(),
    reason,
  };
}

export function assertCapability(
  manifest: ConnectorManifest,
  capability: ConnectorCapability,
): void {
  if (manifest.schema_version !== "1" || !manifest.capabilities.includes(capability)) {
    throw new Error(`Connector ${manifest.id} does not support ${capability}.`);
  }
}

/** Run a third-party adapter through the same status/capability boundary. */
export async function collectConnector<I, O>(
  connector: DataConnector<I, O>,
  capability: ConnectorCapability,
  input: I,
): Promise<ConnectorResult<O>> {
  const manifest = connector.manifest;
  if (
    !manifest ||
    typeof manifest.id !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(manifest.id) ||
    !Array.isArray(manifest.capabilities) ||
    manifest.capabilities.some(
      (value) => !["backlinks.discover", "serp.query", "owner.performance"].includes(value),
    ) ||
    !["none", "caller"].includes(manifest.credentials)
  )
    throw new Error("Invalid connector manifest.");
  assertCapability(manifest, capability);
  const result = await connector.collect(input);
  if (
    !result ||
    result.schema_version !== "1" ||
    result.connector_id !== manifest.id ||
    !["ok", "no-results", "not-configured", "blocked", "rate-limited", "error"].includes(
      result.status,
    ) ||
    !Array.isArray(result.records) ||
    typeof result.observed_at !== "string" ||
    !Number.isFinite(Date.parse(result.observed_at)) ||
    (result.reason !== null && typeof result.reason !== "string")
  )
    throw new Error("Invalid connector result.");
  connectorResult(result.connector_id, result.status, result.records, result.reason);
  return result;
}

/** RFC 4180 quoting, including quoted newlines; malformed rows fail atomically. */
function csvRecords(text: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  const pushField = () => {
    row.push(field);
    field = "";
    closed = false;
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else field += ch;
    } else if (ch === '"') {
      if (field || closed) throw new Error("Malformed CSV quote.");
      quoted = true;
    } else if (ch === ",") pushField();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      pushRow();
    } else {
      if (closed) throw new Error("Unexpected character after CSV quote.");
      field += ch;
    }
    if (rows.length > DATASET_MAX_ROWS + 1) throw new Error("Dataset exceeds row limit.");
  }
  if (quoted) throw new Error("Unterminated CSV quote.");
  if (row.length || field || closed) pushRow();
  const headers = rows.shift();
  if (!headers || headers.some((key) => !key) || new Set(headers).size !== headers.length)
    throw new Error("CSV requires unique nonempty headers.");
  return rows.map((values) => {
    if (values.length !== headers.length) throw new Error("CSV row width does not match headers.");
    return Object.fromEntries(headers.map((key, index) => [key, values[index]!]));
  });
}

export function importDataset(input: DatasetInput): ConnectorResult<ImportedCandidate> {
  if (
    !input ||
    !["json", "csv"].includes(input.format) ||
    typeof input.data !== "string" ||
    Buffer.byteLength(input.data) > DATASET_MAX_BYTES
  )
    throw new Error("Expected CSV/JSON up to 1 MB.");
  if (
    typeof input.dataset_id !== "string" ||
    !input.dataset_id.trim() ||
    input.dataset_id.length > 200
  )
    throw new Error("dataset_id must contain 1–200 characters.");
  const data = input.data.replace(/^\uFEFF/, "");
  const rows: unknown = input.format === "json" ? JSON.parse(data) : csvRecords(data);
  if (!Array.isArray(rows) || rows.length > DATASET_MAX_ROWS)
    throw new Error("Dataset must contain an array of at most 1000 rows.");
  const importedAt = new Date().toISOString();
  const hash = createHash("sha256").update(input.data).digest("hex");
  const records = rows.map((row: unknown, index): ImportedCandidate => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new Error(`Row ${index + 1} must be an object.`);
    const original = row as Record<string, unknown>;
    for (const field of ["source_url", "target_url"] as const) {
      const value = original[field];
      if (
        typeof value !== "string" ||
        value.length > 2048 ||
        Array.from(value).some(
          (char) => /\s/.test(char) || char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
        ) ||
        !guardUrl(value).allowed
      )
        throw new Error(`Invalid ${field} in row ${index + 1}.`);
    }
    return {
      source_url: original.source_url as string,
      target_url: original.target_url as string,
      verification_status: "unverified",
      provenance: {
        connector_id: "byo-dataset",
        dataset_id: input.dataset_id,
        dataset_sha256: hash,
        format: input.format,
        imported_at: importedAt,
        row_number: index + 1,
        original_record: original,
      },
    };
  });
  return connectorResult("byo-dataset", records.length ? "ok" : "no-results", records);
}

export const datasetConnector: DataConnector<DatasetInput, ImportedCandidate> = {
  manifest: {
    schema_version: "1",
    id: "byo-dataset",
    capabilities: ["backlinks.discover"],
    credentials: "none",
  },
  collect: async (input) => importDataset(input),
};
