#!/usr/bin/env node
import { createServer } from "node:http";
import { loadDotEnv } from "./load-dotenv.mjs";
import { loadAgentModule, configuredObservationStore } from "./agent-runtime.mjs";
import {
  createConcurrencyGate,
  createRateLimiter,
  isExternallyBound,
  validBearer,
} from "./api-guards.mjs";

loadDotEnv();
const host = process.env.RANKPROOF_AGENT_HOST || "127.0.0.1";
const port = Number(process.env.RANKPROOF_AGENT_PORT || "8788");
const token = process.env.RANKPROOF_API_TOKEN?.trim();
if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
  throw new Error("Invalid RANKPROOF_AGENT_PORT.");
if (isExternallyBound(host)) {
  if (!token) throw new Error("External agent API requires RANKPROOF_API_TOKEN.");
  if (process.env.RANKPROOF_PIN_DNS === "0")
    throw new Error("External agent API requires DNS pinning.");
  process.env.RANKPROOF_PIN_DNS = "1";
}
const { createAgentApi, AGENT_INPUT_SCHEMAS } = await loadAgentModule("agent-api");
const store = await configuredObservationStore();
const callAgent = createAgentApi(store);
const { agentSchemaDocument, agentOpenApiDocument } = await loadAgentModule("agent-api-schemas");
const acquire = createConcurrencyGate(2);
const allow = createRateLimiter(30, 60_000);
const server = createServer(async (req, res) => {
  const send = (status, data) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(data));
  };
  // This service interface has no browser callers. Reject cross-origin requests.
  if (req.headers.origin) {
    send(403, { error: "Browser origins are not accepted." });
    return;
  }
  if (!validBearer(req.headers.authorization, token)) {
    send(401, { error: "Missing or invalid API token." });
    return;
  }
  if (!allow(req.socket.remoteAddress ?? "unknown")) {
    send(429, { error: "Rate limit exceeded." });
    return;
  }
  const path = (req.url ?? "").split("?")[0];
  if (req.method === "GET" && path === "/v1/agent/openapi.json") {
    send(200, agentOpenApiDocument());
    return;
  }
  if (req.method === "GET" && path === "/v1/agent/schema.json") {
    send(200, agentSchemaDocument());
    return;
  }
  const operation = path?.startsWith("/v1/agent/") ? path.slice("/v1/agent/".length) : "";
  if (!Object.hasOwn(AGENT_INPUT_SCHEMAS, operation)) {
    send(404, { error: "Unknown operation." });
    return;
  }
  if (req.method !== "POST") {
    send(405, { error: "Expected POST." });
    return;
  }
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers["content-type"] ?? "")) {
    send(415, { error: "Expected application/json." });
    return;
  }
  const release = acquire();
  if (!release) {
    send(503, { error: "Collection capacity exhausted." });
    return;
  }
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2_000_000) {
        send(413, { error: "Request exceeds 2 MB." });
        return;
      }
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const output = await callAgent(operation, input);
    send(
      output.ok
        ? 200
        : output.error.code === "unsupported"
          ? 501
          : output.error.code === "invalid_input"
            ? 400
            : 422,
      output,
    );
  } catch {
    send(400, {
      ok: false,
      schema_version: "1",
      error: { code: "invalid_input", message: "Malformed or incomplete JSON body." },
    });
  } finally {
    release();
  }
});
server.on("close", () => store?.close());
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(port, host, () =>
  process.stdout.write(`RankProof Agent API: http://${host}:${server.address().port}\n`),
);
