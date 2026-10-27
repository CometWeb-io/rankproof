#!/usr/bin/env node
import { loadAgentModule, configuredObservationStore } from "./agent-runtime.mjs";
import { loadDotEnv } from "./load-dotenv.mjs";

loadDotEnv();
import { once } from "node:events";

const { createAgentMcpSession } = await loadAgentModule("agent-mcp");
const store = await configuredObservationStore();
const handle = createAgentMcpSession(store);
const send = async (message) => {
  if (!process.stdout.write(`${JSON.stringify(message)}\n`)) await once(process.stdout, "drain");
};
process.stdin.setEncoding("utf8");
let pending = "";
for await (const chunk of process.stdin) {
  pending += chunk;
  while (pending.includes("\n")) {
    const end = pending.indexOf("\n");
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    if (Buffer.byteLength(line) > 2_000_000) throw new Error("MCP message exceeds 2 MB.");
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      await send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    const response = await handle(message);
    if (response) await send(response);
  }
  if (Buffer.byteLength(pending) > 2_000_000) throw new Error("MCP message exceeds 2 MB.");
}
if (pending.trim())
  process.stderr.write("Incomplete MCP message at EOF; messages require newline delimiters.\n");

store?.close();
