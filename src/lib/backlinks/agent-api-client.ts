import {
  AGENT_INPUT_SCHEMAS,
  validateAgentSchema,
  validateObservationConsistency,
} from "./agent-api-contract.ts";
import { agentResponseSchema } from "./agent-api-schemas.ts";
import type { AgentInputs, AgentOperation, AgentOutputs, AgentResponse } from "./agent-api.ts";
export type {
  AgentInputs,
  AgentOperation,
  AgentOutputs,
  AgentObservation,
  AgentResponse,
} from "./agent-api.ts";

export class RankProofApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "RankProofApiError";
  }
}
export class RankProofClient {
  private readonly endpoint: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  constructor(endpoint = "http://127.0.0.1:8788", token?: string, timeoutMs = 90_000) {
    const url = new URL(endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Expected an HTTP(S) API origin/path without credentials, query or fragment.",
      );
    this.endpoint = endpoint.replace(/\/$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
  }
  async call<K extends AgentOperation>(
    operation: K,
    input: AgentInputs[K],
  ): Promise<AgentOutputs[K]> {
    if (!Object.hasOwn(AGENT_INPUT_SCHEMAS, operation))
      throw new RankProofApiError("unsupported", "Unknown operation.");
    try {
      validateAgentSchema(input, AGENT_INPUT_SCHEMAS[operation]);
    } catch {
      throw new RankProofApiError("invalid_input", "Request does not match agent schema v1.");
    }
    const response = await fetch(`${this.endpoint}/v1/agent/${operation}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(input),
    });
    let result: AgentResponse<K>;
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (!response.body) throw new Error("Missing response body.");
      const reader = response.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 8_000_000) throw new Error("Response exceeds 8 MB.");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      result = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as AgentResponse<K>;
      validateAgentSchema(result, agentResponseSchema(operation));
      if (result.ok && ["verify_backlinks", "remeasure_backlinks"].includes(operation)) {
        for (const row of (result.data as AgentOutputs["verify_backlinks"]).results)
          validateObservationConsistency(row);
      }
      if (result.ok && operation === "get_evidence")
        validateObservationConsistency((result.data as AgentOutputs["get_evidence"]).observation);
    } catch {
      throw new RankProofApiError(
        response.ok ? "invalid_response" : `http_${response.status}`,
        "Expected RankProof agent schema v1.",
      );
    }
    if (!result.ok) throw new RankProofApiError(result.error.code, result.error.message);
    if (!response.ok || result.operation !== operation || !Object.hasOwn(result, "data"))
      throw new RankProofApiError("invalid_response", "HTTP status or operation mismatch.");
    return result.data;
  }
  capabilities() {
    return this.call("capabilities", {});
  }
  verifyBacklinks(items: AgentInputs["verify_backlinks"]["items"]) {
    return this.call("verify_backlinks", { items });
  }
  remeasureBacklinks(items: AgentInputs["verify_backlinks"]["items"]) {
    return this.call("remeasure_backlinks", { items });
  }
  serpStatus(input: AgentInputs["serp_status"]) {
    return this.call("serp_status", input);
  }
  diff(input: AgentInputs["diff"]) {
    return this.call("diff", input);
  }
  getEvidence(observation_id: string) {
    return this.call("get_evidence", { observation_id });
  }
  listFindings(report_id: string) {
    return this.call("list_findings", { report_id });
  }
  verifyEvidence(ledger: AgentInputs["verify_evidence"]["ledger"]) {
    return this.call("verify_evidence", { ledger });
  }
  importDataset(input: AgentInputs["import_dataset"]) {
    return this.call("import_dataset", input);
  }
}
