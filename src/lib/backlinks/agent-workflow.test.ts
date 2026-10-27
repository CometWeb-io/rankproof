import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RankProofClient } from "./agent-api-client.ts";

// Real HTTP/stdio processes and SDKs, with hermetic source HTML and DNS only.
// This validates transport integration, not external provider availability.
const net = new URL("./net.server.ts", import.meta.url).href;
const preload = `import { setHostResolverForTests } from ${JSON.stringify(net)};
setHostResolverForTests(async () => ["93.184.216.34"]);
const calls = new Map();
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/robots.txt")) return new Response("", {status: 404});
  // Separate controlled source attempts in wall time; equal timestamps cannot prove ordering.
  await new Promise((resolve) => setTimeout(resolve, 2));
  const count = (calls.get(url) || 0) + 1; calls.set(url, count);
  if (count > 2) throw new Error("Fixture source unavailable");
  const text = count === 1 ? '<html><body><a href="https://target.example/path">Useful reference</a></body></html>' : '<html><body>Updated article with readable content; the reference was removed.</body></html>';
  return new Response(text, {headers: {"content-type": "text/html"}});
};`;
const env = {
  ...process.env,
  RANKPROOF_API_TOKEN: "fixture-token",
  RANKPROOF_AGENT_HOST: "127.0.0.1",
  RANKPROOF_AGENT_PORT: "0",
  RANKPROOF_GOOGLE_PROVIDER_URL: "",
  OPENVIS_GOOGLE_PROVIDER_URL: "",
  SERPRADAR_GOOGLE_PROVIDER_URL: "",
};
const args = (script: string) => [
  "--experimental-strip-types",
  "--no-warnings",
  "--import",
  `data:text/javascript,${encodeURIComponent(preload)}`,
  script,
];
const items = [
  { source_url: "https://source.example/article", target_url: "https://target.example/path" },
];

test(
  "HTTP verifier history survives SIGKILL and remains readable through both SDKs",
  { timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "rankproof-http-history-"));
    const historyEnv = { ...env, RANKPROOF_AGENT_HISTORY_DB: join(directory, "history.sqlite") };
    const launch = async () => {
      const child = spawn(process.execPath, args("scripts/agent-api.mjs"), {
        env: historyEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (data) => {
        stderr += String(data);
      });
      const endpoint = await new Promise<string>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => reject(new Error(`History API exited: ${stderr}`)));
        child.stdout.on("data", (data) => {
          const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(data));
          if (match) resolve(match[0]);
        });
      });
      return { child, endpoint, client: new RankProofClient(endpoint, "fixture-token") };
    };
    let running: Awaited<ReturnType<typeof launch>> | undefined;
    const stop = async (signal: NodeJS.Signals = "SIGTERM") => {
      if (!running || running.child.exitCode !== null || running.child.signalCode !== null) return;
      const exited = once(running.child, "exit");
      running.child.kill(signal);
      await exited;
    };
    const timeout = setTimeout(() => running?.child.kill("SIGKILL"), 25_000);
    try {
      running = await launch();
      const before = await running.client.verifyBacklinks(items);
      assert.equal(before.persistence.kind, "bounded_sqlite");
      assert.equal(before.persistence.ttl_seconds, null);
      const id = before.results[0]!.observation_id;
      await stop("SIGKILL");
      running = await launch();
      const retained = await running.client.getEvidence(id);
      assert.deepEqual(retained.observation, before.results[0]);
      const after = await running.client.remeasureBacklinks(items);
      const comparison = await running.client.diff({
        before_id: id,
        after_id: after.results[0]!.observation_id,
      });
      assert.equal(comparison.evidence_origin, "rankproof_history");
      assert.equal(comparison.comparison.status, "CONFIRMED");
      const python =
        'from rankproof_client import RankProofClient\nimport sys\nc=RankProofClient(sys.argv[1],token="fixture-token")\ne=c.get_evidence(sys.argv[2])\nassert e["persistence"]["kind"]=="bounded_sqlite"\nassert e["observation"]["status"]=="confirmed"\nprint("durable-python-ok")';
      const result = await promisify(execFile)("python3", ["-c", python, running.endpoint, id], {
        env: { ...process.env, PYTHONPATH: "sdk/python" },
      });
      assert.match(result.stdout, /durable-python-ok/);
    } finally {
      clearTimeout(timeout);
      await stop();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "HTTP + TypeScript + Python: import→verify→evidence→remeasure→diff→findings, with honest source failure",
  { timeout: 30_000 },
  async () => {
    const child = spawn(process.execPath, args("scripts/agent-api.mjs"), {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 25_000);
    try {
      const endpoint = await new Promise<string>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => reject(new Error(`Agent API exited: ${stderr}`)));
        child.stdout.on("data", (data) => {
          const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(data));
          if (match) resolve(match[0]);
        });
      });
      const client = new RankProofClient(endpoint, "fixture-token");
      const capabilities = await client.capabilities();
      assert.ok(capabilities.operations.every((row) => row.supported));
      assert.equal(capabilities.persistence.kind, "bounded_process_memory");
      assert.equal(
        (await fetch(`${endpoint}/v1/agent/capabilities`, { method: "POST" })).status,
        401,
      );
      const headers = { Authorization: "Bearer fixture-token", "Content-Type": "application/json" };
      assert.equal(
        (
          await fetch(`${endpoint}/v1/agent/capabilities`, {
            method: "POST",
            headers: { ...headers, Origin: "https://attacker.example" },
            body: "{}",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(`${endpoint}/v1/agent/capabilities`, {
            method: "POST",
            headers,
            body: "null",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fetch(`${endpoint}/v1/agent/capabilities`, {
            method: "POST",
            headers,
            body: "{broken",
          })
        ).status,
        400,
      );
      assert.equal((await fetch(`${endpoint}/v1/agent/openapi.json`, { headers })).status, 200);
      const imported = await client.importDataset({
        format: "json",
        dataset_id: "local-fixture",
        data: JSON.stringify(items),
      });
      assert.equal(imported.records[0]!.verification_status, "unverified");
      const before = await client.verifyBacklinks(items);
      assert.equal(before.results[0]!.status, "confirmed");
      assert.equal(
        (await client.getEvidence(before.results[0]!.observation_id)).observation.response_hash,
        before.results[0]!.response_hash,
      );
      const after = await client.remeasureBacklinks(items);
      assert.equal(after.results[0]!.status, "not_found");
      const diff = await client.diff({
        before_id: before.results[0]!.observation_id,
        after_id: after.results[0]!.observation_id,
      });
      assert.equal(diff.evidence_origin, "rankproof_session");
      assert.equal(diff.comparison.change, "absent_in_representation");
      assert.equal(diff.comparison.scope, "fetched_html");
      assert.equal(
        (await client.listFindings(after.report_id)).findings[0]!.kind,
        "absent_in_fetched_html",
      );
      const failed = await client.remeasureBacklinks(items);
      assert.equal(failed.results[0]!.status, "error");
      assert.equal(
        (
          await client.diff({
            before_id: before.results[0]!.observation_id,
            after_id: failed.results[0]!.observation_id,
          })
        ).comparison.status,
        "UNKNOWN",
      );
      assert.equal(
        (await client.listFindings(failed.report_id)).findings[0]!.kind,
        "measurement_unknown",
      );
      const serp = await client.serpStatus({
        url: "target.example",
        keywords: ["test phrase"],
        engines: ["google"],
      });
      assert.equal(serp.queries[0]!.status, "not-configured");
      assert.equal(serp.queries[0]!.target_position, null);
      const python = `from rankproof_client import RankProofClient\nimport sys\nc = RankProofClient(sys.argv[1], token="fixture-token")\nassert c.capabilities()["api_version"] == "1"\npairs = [{"source_url":"https://python.example/article", "target_url":"https://target.example/path"}]\nassert c.import_dataset(format="json", data=__import__("json").dumps(pairs), dataset_id="python")["records"][0]["verification_status"] == "unverified"\nbefore = c.verify_backlinks(pairs)\nassert before["results"][0]["status"] == "confirmed"\nafter = c.remeasure_backlinks(pairs)\nassert c.get_evidence(before["results"][0]["observation_id"])["observation"]["status"] == "confirmed"\nassert c.diff(before["results"][0]["observation_id"], after["results"][0]["observation_id"])["comparison"]["change"] == "absent_in_representation"\nassert c.list_findings(after["report_id"])["findings"][0]["kind"] == "absent_in_fetched_html"\nprint("python-workflow-ok")`;
      const result = await promisify(execFile)("python3", ["-c", python, endpoint], {
        env: { ...process.env, PYTHONPATH: "sdk/python" },
      });
      assert.match(result.stdout, /python-workflow-ok/);
    } finally {
      clearTimeout(timeout);
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null) await exited;
    }
  },
);

test(
  "MCP stdio performs the same workflow with protocol lifecycle and structured outputs",
  { timeout: 20_000 },
  async () => {
    const child = spawn(process.execPath, args("scripts/agent-mcp.mjs"), {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    const incoming = lines[Symbol.asyncIterator]();
    let id = 0;
    const rpc = async (method: string, params?: unknown) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })}\n`);
      const line = await incoming.next();
      assert.equal(line.done, false);
      return JSON.parse(line.value!);
    };
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      assert.equal((await rpc("tools/list")).error.code, -32002);
      const initialized = await rpc("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" },
      });
      assert.equal(initialized.result.protocolVersion, "2025-11-25");
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      const listed = await rpc("tools/list");
      assert.ok(listed.result.tools.some((tool: { name: string }) => tool.name === "get_evidence"));
      const call = async (name: string, args: unknown) => {
        const response = await rpc("tools/call", { name, arguments: args });
        assert.equal(response.result.isError, false, JSON.stringify(response));
        assert.deepEqual(
          JSON.parse(response.result.content[0].text),
          response.result.structuredContent,
        );
        return response.result.structuredContent.data;
      };
      const imported = await call("import_dataset", {
        format: "json",
        data: JSON.stringify(items),
        dataset_id: "mcp",
      });
      assert.equal(imported.records[0].verification_status, "unverified");
      const before = await call("verify_backlinks", { items });
      const after = await call("remeasure_backlinks", { items });
      assert.equal(
        (await call("get_evidence", { observation_id: before.results[0].observation_id }))
          .observation.status,
        "confirmed",
      );
      assert.equal(
        (
          await call("diff", {
            before_id: before.results[0].observation_id,
            after_id: after.results[0].observation_id,
          })
        ).comparison.change,
        "absent_in_representation",
      );
      assert.equal(
        (await call("list_findings", { report_id: after.report_id })).findings[0].kind,
        "absent_in_fetched_html",
      );
      assert.equal(
        (await rpc("tools/call", { name: "verify_backlinks", arguments: { items: [] } })).result
          .isError,
        true,
      );
      assert.equal((await rpc("tools/call", { name: "foreign" })).error.code, -32602);
      assert.equal((await rpc("unknown/method")).error.code, -32601);
    } finally {
      clearTimeout(timeout);
      lines.close();
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null) await exited;
    }
  },
);
