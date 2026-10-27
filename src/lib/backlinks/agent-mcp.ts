import {
  AGENT_INPUT_SCHEMAS,
  agentCapabilities,
  createAgentApi,
  type AgentOperation,
} from "./agent-api.ts";
import type { ObservationStore } from "./agent-api-store.ts";
import { agentResponseSchema } from "./agent-api-schemas.ts";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const descriptions: Record<AgentOperation, string> = {
  capabilities:
    "Read supported operations and configured providers. Configuration does not establish availability.",
  verify_backlinks:
    "Fetch public source pages and independently verify exact target URLs in HTML. Errors do not prove absence or loss.",
  remeasure_backlinks:
    "Make fresh uncached observations of specified source/target pairs. Does not itself establish historical loss.",
  serp_status:
    "Measure keyword SERPs with per-query status. Blocked/unconfigured sources are not zero rankings.",
  import_dataset:
    "Import BYO CSV/JSON as unverified candidates with original records and dataset hash. Does not fetch or confirm links.",
  verify_evidence:
    "Check caller-supplied evidence ledger hashes. Internal integrity does not prove authenticity; persistence belongs to the caller.",
  get_evidence:
    "Read a stored verifier observation. Inspect capabilities persistence; memory sessions expire while configured history survives restart.",
  diff: "Compare caller-supplied observations of one exact source/target pair. Reject incomplete evidence, preserve unknown status for failed rechecks. Caller evidence is not independently authenticated.",
  list_findings:
    "List findings with observation IDs from this verifier service history or session.",
};
type RpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
export function createAgentMcpSession(store?: ObservationStore) {
  let initialized = false,
    ready = false;
  const callAgent = createAgentApi(store);
  return async (message: unknown): Promise<object | null> => {
    const rpc = message as RpcMessage;
    const validObject = rpc && typeof rpc === "object" && !Array.isArray(rpc);
    const hasId = Boolean(validObject && Object.hasOwn(rpc, "id"));
    const id =
      hasId &&
      (typeof rpc.id === "string" || (typeof rpc.id === "number" && Number.isFinite(rpc.id)))
        ? rpc.id
        : null;
    const error = (code: number, text: string) => ({
      jsonrpc: "2.0",
      id,
      error: { code, message: text },
    });
    const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
    if (
      !validObject ||
      rpc.jsonrpc !== "2.0" ||
      typeof rpc.method !== "string" ||
      (hasId && id === null)
    )
      return error(-32600, "Invalid Request");
    if (!hasId) {
      if (rpc.method === "notifications/initialized" && initialized) ready = true;
      return null;
    }
    if (rpc.method === "ping") return result({});
    if (rpc.method === "initialize") {
      if (initialized) return error(-32600, "Session already initialized");
      const params = rpc.params as
        { protocolVersion?: unknown; capabilities?: unknown; clientInfo?: unknown } | undefined;
      if (
        !params ||
        typeof params.protocolVersion !== "string" ||
        !params.capabilities ||
        typeof params.capabilities !== "object" ||
        Array.isArray(params.capabilities) ||
        !params.clientInfo ||
        typeof params.clientInfo !== "object" ||
        Array.isArray(params.clientInfo) ||
        typeof (params.clientInfo as Record<string, unknown>).name !== "string" ||
        typeof (params.clientInfo as Record<string, unknown>).version !== "string"
      )
        return error(-32602, "Invalid initialize params");
      initialized = true;
      return result({
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion)
          ? params.protocolVersion
          : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "rankproof", version: "1.0.0" },
        instructions:
          "Imported/provider records are unverified. Inspect per-query source status; failures do not prove absent rankings or lost links.",
      });
    }
    if (!ready) return error(-32002, "Initialize the session first");
    if (rpc.method === "tools/list") {
      const tools = agentCapabilities()
        .operations.filter((operation) => operation.supported)
        .map(({ name }) => ({
          name,
          description: descriptions[name as AgentOperation],
          inputSchema: AGENT_INPUT_SCHEMAS[name as AgentOperation],
          outputSchema: { type: "object", ...agentResponseSchema(name as AgentOperation) },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: name === "capabilities" || name === "import_dataset",
            openWorldHint: ["verify_backlinks", "remeasure_backlinks", "serp_status"].includes(
              name,
            ),
          },
        }));
      return result({ tools });
    }
    if (rpc.method === "tools/call") {
      const params = rpc.params as { name?: unknown; arguments?: unknown } | undefined;
      if (
        !params ||
        typeof params.name !== "string" ||
        !agentCapabilities().operations.some(
          (operation) => operation.name === params.name && operation.supported,
        )
      )
        return error(-32602, "Unknown tool");
      const output = await callAgent(params.name as AgentOperation, params.arguments ?? {});
      return result({
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
        isError: !output.ok,
      });
    }
    return error(-32601, "Method not found");
  };
}
