/** Repository SDK entry point. npm builds expose dist/agent-api-client.js + declarations. */
export { RankProofClient, RankProofApiError } from "../../src/lib/backlinks/agent-api-client.ts";
export type {
  AgentInputs,
  AgentOutputs,
  AgentObservation,
  AgentOperation,
  AgentResponse,
} from "../../src/lib/backlinks/agent-api-client.ts";
