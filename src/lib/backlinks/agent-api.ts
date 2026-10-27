/** Stable agent projections over the existing verifier/SERP engines. */
import {
  verifyBacklinks,
  verifyPairsFromBody,
  type BacklinkObservation,
} from "./verify-api.server.ts";
import { importDataset, type DatasetInput } from "./connectors.ts";
import type { SerpEngine, SerpMarket, SerpDevice, SerpStatus } from "./types.ts";
import { parseTarget } from "./parse.ts";
import { serpConnector, type SerpConnectorInput } from "./connectors.server.ts";
import { agentResponseSchema } from "./agent-api-schemas.ts";
import { SERP_PROVIDERS, isEngineConfigured } from "./serp-providers.ts";

import {
  createObservationStore,
  SESSION_RETENTION,
  type StoredObservation,
  type ObservationReport,
  type ObservationStore,
  type ObservationPersistence,
} from "./agent-api-store.ts";

export const AGENT_API_VERSION = "1" as const;
import {
  AGENT_INPUT_SCHEMAS,
  AGENT_OBSERVATION_SCHEMA,
  validateAgentSchema,
  validateObservationConsistency,
  type AgentOperation,
} from "./agent-api-contract.ts";
export { AGENT_INPUT_SCHEMAS, type AgentOperation } from "./agent-api-contract.ts";
import { compareRelationship, relationshipObservation } from "./relationships.ts";
import { verifyEvidenceLedger, type EvidenceLedger } from "./evidence-ledger.server.ts";
export type AgentInputs = {
  capabilities: Record<string, never>;
  verify_backlinks: { items: { source_url: string; target_url: string }[] };
  remeasure_backlinks: AgentInputs["verify_backlinks"];
  serp_status: SerpConnectorInput;
  import_dataset: DatasetInput;
  get_evidence: { observation_id: string };
  diff: { observations: AgentObservation[] } | { before_id: string; after_id: string };
  verify_evidence: { ledger: EvidenceLedger };
  list_findings: { report_id: string };
};
export type AgentObservation = Pick<
  BacklinkObservation,
  | "source_url"
  | "target_url"
  | "status"
  | "checked_at"
  | "final_url"
  | "http_status"
  | "reason"
  | "evidence_kind"
  | "observation_method"
  | "absence_scope"
  | "extraction_version"
  | "identity_policy"
  | "source_revision"
  | "response_hash"
  | "raw_href"
  | "resolved_href"
  | "anchor"
  | "rel"
>;
export type AgentOutputs = {
  capabilities: ReturnType<typeof agentCapabilities>;
  verify_backlinks: ObservationReport & { persistence: ObservationPersistence };
  remeasure_backlinks: AgentOutputs["verify_backlinks"];
  serp_status: {
    observed_at: string;
    queries: {
      keyword: string;
      engine: SerpEngine;
      market: SerpMarket;
      device: SerpDevice;
      status: SerpStatus;
      target_position: number | null;
      depth: number;
      results: { position: number; url: string; title: string }[];
    }[];
  };
  import_dataset: ReturnType<typeof importDataset>;
  get_evidence: {
    report_id: string;
    observation: StoredObservation;
    persistence: ObservationPersistence;
  };
  diff: {
    comparison: ReturnType<typeof compareRelationship>;
    evidence_origin: "caller_supplied_untrusted" | "rankproof_session" | "rankproof_history";
    persistence: "caller";
  };
  verify_evidence: {
    valid: boolean;
    integrity_scope: "internal_hashes_only";
    persistence: "caller";
  };
  list_findings: {
    report_id: string;
    findings: {
      observation_id: string;
      kind:
        "link_present" | "absent_in_fetched_html" | "source_unavailable" | "measurement_unknown";
      scope: AgentObservation["absence_scope"];
      reason: string | null;
    }[];
    persistence: ObservationPersistence;
  };
};
export type AgentResponse<K extends AgentOperation = AgentOperation> =
  | { ok: true; schema_version: "1"; operation: K; data: AgentOutputs[K] }
  | {
      ok: false;
      schema_version: "1";
      error: { code: "invalid_input" | "unsupported" | "collection_failed"; message: string };
    };

export function agentCapabilities(persistence: ObservationPersistence = SESSION_RETENTION) {
  return {
    api_version: AGENT_API_VERSION,
    operations: Object.keys(AGENT_INPUT_SCHEMAS).map((name) => ({ name, supported: true })),
    providers: SERP_PROVIDERS.map(({ id, kind }) => ({
      id,
      kind,
      configured: isEngineConfigured(id),
      availability: "not-probed" as const,
    })),
    persistence,
    owner_data: "explicit-credentials-in-process-only" as const,
    limits: { verify_items: 50, dataset_rows: 1000, dataset_bytes: 1_000_000, keywords: 10 },
  };
}

export function validateAgentInput(operation: AgentOperation, input: unknown): void {
  validateAgentSchema(input, AGENT_INPUT_SCHEMAS[operation]);
  if (operation === "verify_backlinks" || operation === "remeasure_backlinks")
    verifyPairsFromBody(input);
  if (operation === "diff" && "observations" in (input as AgentInputs["diff"])) {
    const observations = (input as { observations: AgentObservation[] }).observations;
    verifyPairsFromBody({ items: observations.slice(0, 50) });
    if (observations.length > 50) verifyPairsFromBody({ items: observations.slice(50) });
    for (const row of observations) {
      validateObservationConsistency(row);
      if (!Number.isFinite(Date.parse(row.checked_at)))
        throw new Error("Invalid observation timestamp.");
      if (
        row.status === "confirmed" &&
        (row.evidence_kind !== "html_anchor" ||
          !/^[a-f0-9]{64}$/.test(row.response_hash ?? "") ||
          !row.raw_href ||
          !row.resolved_href ||
          !row.final_url ||
          !row.http_status ||
          row.http_status < 200 ||
          row.http_status >= 300 ||
          row.absence_scope !== null)
      )
        throw new Error("Confirmed observations require HTML anchor evidence.");
      if (
        row.status === "not_found" &&
        row.absence_scope === "fetched_html" &&
        (!/^[a-f0-9]{64}$/.test(row.response_hash ?? "") ||
          !row.final_url ||
          !row.http_status ||
          row.http_status < 200 ||
          row.http_status >= 300)
      )
        throw new Error("HTML absence requires a complete successful response.");
    }
    if (
      observations.some(
        (row) =>
          row.source_url !== observations[0]!.source_url ||
          row.target_url !== observations[0]!.target_url,
      )
    )
      throw new Error("Relationship diff requires one exact source/target pair.");
  }
  if (operation === "serp_status") {
    const data = input as AgentInputs["serp_status"];
    parseTarget(data.url);
    if (data.keywords.some((keyword) => keyword.trim().length < 2))
      throw new Error("Empty keyword.");
  }
}

export function createAgentApi(store: ObservationStore = createObservationStore()) {
  const persistence = store.persistence;
  return async function callAgent<K extends AgentOperation>(
    operation: K,
    input: unknown,
  ): Promise<AgentResponse<K>> {
    if (!Object.hasOwn(AGENT_INPUT_SCHEMAS, operation))
      return {
        ok: false,
        schema_version: "1",
        error: { code: "unsupported", message: "Unknown operation." },
      };
    try {
      validateAgentInput(operation, input);
    } catch (error) {
      return {
        ok: false,
        schema_version: "1",
        error: {
          code: "invalid_input",
          message: error instanceof Error ? error.message : "Invalid input.",
        },
      };
    }
    try {
      let data: unknown;
      if (operation === "capabilities") data = agentCapabilities(persistence);
      else if (operation === "verify_evidence")
        data = {
          valid: verifyEvidenceLedger((input as AgentInputs["verify_evidence"]).ledger),
          integrity_scope: "internal_hashes_only",
          persistence: "caller",
        };
      else if (operation === "get_evidence")
        data = {
          ...store.observation((input as AgentInputs["get_evidence"]).observation_id),
          persistence,
        };
      else if (operation === "list_findings") {
        const report = store.report((input as AgentInputs["list_findings"]).report_id);
        data = {
          report_id: report.report_id,
          persistence,
          findings: report.results.map((row) => ({
            observation_id: row.observation_id,
            kind:
              row.status === "confirmed"
                ? "link_present"
                : row.status === "not_found" && row.absence_scope === "fetched_html"
                  ? "absent_in_fetched_html"
                  : row.status === "not_found" && row.absence_scope === "http_resource"
                    ? "source_unavailable"
                    : "measurement_unknown",
            scope: row.absence_scope,
            reason: row.reason,
          })),
        };
      } else if (operation === "diff") {
        const request = input as AgentInputs["diff"];
        const fromSession = "before_id" in request;
        const observations: AgentObservation[] = fromSession
          ? [
              store.observation(request.before_id).observation,
              store.observation(request.after_id).observation,
            ].map(({ observation_id: _id, ...row }) => row)
          : request.observations;
        validateAgentInput("diff", { observations });
        if (
          fromSession &&
          Date.parse(observations[0]!.checked_at) >= Date.parse(observations[1]!.checked_at)
        )
          throw new Error("before_id must precede after_id.");
        data = {
          comparison: compareRelationship(
            observations.map((row) => relationshipObservation({ ...row, matching_anchors: [] })),
          ),
          evidence_origin: fromSession
            ? persistence.kind === "bounded_sqlite"
              ? "rankproof_history"
              : "rankproof_session"
            : "caller_supplied_untrusted",
          persistence: "caller",
        };
      } else if (operation === "verify_backlinks" || operation === "remeasure_backlinks") {
        const result = await verifyBacklinks(input);
        const observations = result.results.map(
          (observation) =>
            Object.fromEntries(
              Object.keys(AGENT_OBSERVATION_SCHEMA.properties).map((key) => [
                key,
                observation[key as keyof BacklinkObservation],
              ]),
            ) as AgentObservation,
        );
        data = { ...store.save(observations), persistence };
      } else if (operation === "import_dataset") data = importDataset(input as DatasetInput);
      else {
        const result = await serpConnector.collect(input as SerpConnectorInput);
        if (result.status !== "ok") throw new Error(result.reason ?? "SERP collection failed.");
        data = {
          observed_at: result.observed_at,
          queries: result.records.map((query) => ({
            keyword: query.keyword,
            engine: query.engine,
            market: query.market,
            device: query.device,
            status: query.status,
            target_position: query.targetPosition,
            depth: query.depth,
            results: query.results.map(({ position, url, title }) => ({ position, url, title })),
          })),
        };
      }
      const response = {
        ok: true as const,
        schema_version: "1" as const,
        operation,
        data: data as AgentOutputs[K],
      };
      validateAgentSchema(response, agentResponseSchema(operation));
      return response;
    } catch (error) {
      return {
        ok: false,
        schema_version: "1",
        error: {
          code: operation === "import_dataset" ? "invalid_input" : "collection_failed",
          message: error instanceof Error ? error.message : "Collection failed.",
        },
      };
    }
  };
}

/** Convenience instance for in-process callers; transports create isolated instances. */
export const callAgent = createAgentApi();
