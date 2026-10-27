#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadAgentModule } from "./agent-runtime.mjs";

const { agentSchemaDocument, agentOpenApiDocument } = await loadAgentModule("agent-api-schemas");
for (const [path, document] of [
  ["schemas/agent-api-v1.schema.json", agentSchemaDocument()],
  ["python/rankproof_client/schema.json", agentSchemaDocument()],
  ["openapi-v1.json", agentOpenApiDocument()],
]) {
  const file = new URL(`../sdk/${path}`, import.meta.url);
  const content = `${JSON.stringify(document, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if ((await readFile(file, "utf8")) !== content) throw new Error(`Stale contract: ${path}`);
  } else {
    await mkdir(new URL(".", file), { recursive: true });
    await writeFile(file, content);
  }
}
