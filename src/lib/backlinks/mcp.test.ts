import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { handleMessage, TOOLS } from "./mcp.server.ts";
import { clearNetCache, setHostResolverForTests } from "./net.server.ts";
import { clearRobotsCache } from "./robots.server.ts";

const info = { name: "rankproof", version: "test" };
const originalFetch = globalThis.fetch;
setHostResolverForTests(async () => ["93.184.216.34"]);
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearNetCache();
  clearRobotsCache();
});

test("MCP: initialize negotiates a supported protocol and advertises tools", async () => {
  const init = (await handleMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    info,
  )) as { result: { protocolVersion: string; capabilities: { tools: object } } };
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.ok(init.result.capabilities.tools);
  const unknown = (await handleMessage(
    { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } },
    info,
  )) as { result: { protocolVersion: string } };
  assert.equal(unknown.result.protocolVersion, "2025-06-18");
  assert.equal(
    await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, info),
    null,
  );
  const list = (await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" }, info)) as {
    result: { tools: typeof TOOLS };
  };
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    ["verify_links", "explain_verdicts"],
  );
  const missing = (await handleMessage({ jsonrpc: "2.0", id: 4, method: "nope" }, info)) as {
    error: { code: number };
  };
  assert.equal(missing.error.code, -32601);
});

test("MCP: verify_links returns verdicts, text and structured content; errors are tool errors", async () => {
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/robots.txt")) return new Response("", { status: 404 });
    return new Response(
      `<html><body><a rel="sponsored" href="https://brand.example/">Brand</a></body></html>`,
      {
        status: 200,
        headers: { "content-type": "text/html" },
      },
    );
  };
  const call = (await handleMessage(
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "verify_links",
        arguments: { table: "https://pub.example/a,https://brand.example/,Brand,follow" },
      },
    },
    info,
  )) as {
    result: {
      isError?: boolean;
      content: { text: string }[];
      structuredContent: { results: { verdict: string; response_hash: string }[] };
    };
  };
  assert.equal(call.result.isError, undefined);
  assert.equal(call.result.structuredContent.results[0]!.verdict, "deviates");
  assert.match(call.result.content[0]!.text, /\[deviates\]/);
  assert.match(call.result.structuredContent.results[0]!.response_hash, /^[a-f0-9]{64}$/);

  const refused = (await handleMessage(
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "verify_links",
        arguments: {
          pairs: [{ source_url: "http://127.0.0.1/", target_url: "https://b.example/" }],
        },
      },
    },
    info,
  )) as { result: { isError: boolean; content: { text: string }[] } };
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0]!.text, /publicly routable/);

  const render = (await handleMessage(
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "verify_links",
        arguments: {
          pairs: [{ source_url: "https://a.example/", target_url: "https://b.example/" }],
          render: "always",
        },
      },
    },
    info,
  )) as { result: { isError: boolean; content: { text: string }[] } };
  assert.equal(render.result.isError, true, "rendering needs RANKPROOF_RENDER=1");
});

test("MCP: the CLI speaks newline-delimited JSON-RPC on stdout only", async () => {
  const bin = fileURLToPath(new URL("../../../bin/rankproof.mjs", import.meta.url));
  // The test runner's NODE_TEST_CONTEXT would make the child report to it instead of stdout.
  const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
  const child = spawn(process.execPath, [bin, "mcp"], { stdio: ["pipe", "pipe", "pipe"], env });
  const lines = createInterface({ input: child.stdout! });
  const replies: Record<string, unknown>[] = [];
  const waitFor = (n: number) =>
    new Promise<void>((resolve) => {
      if (replies.length >= n) return resolve();
      lines.on("line", () => replies.length >= n && resolve());
    });
  lines.on("line", (line) => replies.push(JSON.parse(line)));
  const send = (value: unknown) => child.stdin!.write(`${JSON.stringify(value)}\n`);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "explain_verdicts", arguments: {} },
  });
  send("a JSON string is not a request");
  child.stdin!.write("{not json\n");
  await waitFor(4);
  child.stdin!.end();
  await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(replies.length, 4, "a notification gets no reply; everything else does");
  const byId = new Map(replies.map((r) => [(r as { id: unknown }).id, r]));
  assert.ok(byId.has(1), "initialize answered");
  assert.match(JSON.stringify(byId.get(2)), /never report/i);
  assert.deepEqual(
    replies
      .filter((r) => (r as { id: unknown }).id === null)
      .map((r) => (r as { error: { code: number } }).error.code)
      .sort((a, b) => a - b),
    [-32700, -32600],
  );
});
