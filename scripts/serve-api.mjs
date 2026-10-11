#!/usr/bin/env node
/**
 * RankProof HTTP API — standalone JSON server for self-hosting.
 *
 * Needs neither the web app nor a database; it exposes the same engines the
 * interface uses. It listens on 127.0.0.1 only by default, because these
 * endpoints query other people's servers and exposing them publicly without
 * limits is an invitation to abuse.
 *
 *   node scripts/serve-api.mjs --port 8787
 *
 * Endpoints:
 *   GET  /health
 *   GET  /doctor
 *   POST /scan   { "url": "example.com", "market": "pl", "device": "desktop" }
 *   POST /serp   { "url": "example.com", "keywords": ["a","b"], "depth": 10 }
 *   POST /ideas  { "keywords": ["keyword"] }
 *   POST /gap    { "url": "example.com", "competitors": ["a.pl"] }
 */
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  boundedInteger,
  createRateLimiter,
  createConcurrencyGate,
  validBearer,
  isExternallyBound,
  validateApiBody,
} from "./api-guards.mjs";

// See bin/rankproof.mjs: an installed package loads the compiled engine,
// a clone runs the TypeScript sources.
const SRC = new URL("../src/lib/backlinks/", import.meta.url);
const DIST = new URL("../dist/", import.meta.url);
const COMPILED = !existsSync(new URL("engine.server.ts", SRC));
const engine = (name) =>
  COMPILED ? new URL(`${name}.js`, DIST).href : new URL(`${name}.ts`, SRC).href;

const STRIP = "--experimental-strip-types";
if (!COMPILED && !process.execArgv.includes(STRIP) && !process.env.RANKPROOF_API_CHILD) {
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    [STRIP, "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, RANKPROOF_API_CHILD: "1" } },
  );
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  start();
}

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

async function readJson(req, limitBytes = 64_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("The request is too large.");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function start() {
  const { loadDotEnv } = await import("./load-dotenv.mjs");
  loadDotEnv();
  const port = Number(flag("port", process.env.PORT ?? "8787"));
  const host = flag("host", process.env.HOST ?? "127.0.0.1");
  const exposed = isExternallyBound(host);
  const secret = process.env.RANKPROOF_API_TOKEN?.trim() || null;
  if (exposed && !secret) {
    throw new Error("Binding the HTTP API publicly requires RANKPROOF_API_TOKEN.");
  }
  if (exposed && process.env.RANKPROOF_PIN_DNS === "0") {
    throw new Error("Public HTTP API refuses unsafe RANKPROOF_PIN_DNS=0.");
  }
  if (exposed) process.env.RANKPROOF_PIN_DNS = "1";
  const allow = createRateLimiter(
    boundedInteger(process.env.RANKPROOF_RATE_LIMIT ?? 20, 20, 1, 500),
    boundedInteger(process.env.RANKPROOF_RATE_WINDOW_MS ?? 60_000, 60_000, 1_000, 3_600_000),
  );
  const acquire = createConcurrencyGate(
    boundedInteger(process.env.RANKPROOF_MAX_ACTIVE_SCANS ?? 2, 2, 1, 16),
  );

  const server = createServer(async (req, res) => {
    const send = (status, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    };

    const url = new URL(req.url ?? "/", `http://${host}:${port}`);

    if (req.method === "GET" && url.pathname === "/health") {
      send(200, { ok: true, service: "rankproof", uptime: Math.round(process.uptime()) });
      return;
    }
    if (!validBearer(req.headers.authorization, secret)) {
      send(401, { ok: false, error: "Authorization required." });
      return;
    }

    if (req.method === "GET" && url.pathname === "/doctor") {
      // /doctor probes five engines sequentially, so it is rate-limited like
      // the POST endpoints. /health above stays free: it is a liveness probe.
      if (!allow(req.socket.remoteAddress ?? "unknown")) {
        send(429, { ok: false, error: "Too many requests. Try again shortly." });
        return;
      }
      const release = acquire();
      if (!release) {
        send(503, { ok: false, error: "Scan capacity exhausted." });
        return;
      }
      try {
        const { runDoctor } = await import(engine("doctor.server"));
        const diagnosis = await runDoctor();
        send(diagnosis.healthy ? 200 : 503, { ok: diagnosis.healthy, diagnosis });
      } catch (error) {
        send(500, {
          ok: false,
          error: error instanceof Error ? error.message : "Doctor failed.",
        });
      } finally {
        release();
      }
      return;
    }
    if (req.method !== "POST") {
      send(405, {
        ok: false,
        error: "Only POST requests are supported (except /health and /doctor).",
      });
      return;
    }
    if (!allow(req.socket.remoteAddress ?? "unknown")) {
      send(429, { ok: false, error: "Too many requests. Try again shortly." });
      return;
    }

    if (
      !String(req.headers["content-type"] ?? "")
        .toLowerCase()
        .startsWith("application/json")
    ) {
      send(415, { ok: false, error: "Expected application/json request body." });
      return;
    }
    const release = acquire();
    if (!release) {
      send(503, { ok: false, error: "Scan capacity exhausted." });
      return;
    }
    const clientAbort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) clientAbort.abort();
    };
    res.once("close", onClose);
    try {
      const body = validateApiBody(url.pathname, await readJson(req));
      const result = await route(url.pathname, body, clientAbort.signal);
      send(result.ok ? 200 : 400, result);
    } catch (error) {
      send(400, { ok: false, error: error instanceof Error ? error.message : "Request error." });
    } finally {
      res.off("close", onClose);
      release();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  server.listen(port, host, () => {
    console.log(`RankProof API: http://${host}:${port}`);
    console.log("Endpoints: GET /health /doctor · POST /scan /serp /ideas /gap");
    if (exposed) {
      console.log(
        "Public binding: Bearer authentication enabled. Put TLS and a reverse proxy in front.",
      );
    }
  });
}

async function route(pathname, body, signal) {
  switch (pathname) {
    case "/scan": {
      const { runScan } = await import(engine("engine.server"));
      return runScan(String(body.url ?? ""), {
        market: body.market,
        device: body.device,
        engines: body.engines,
        skipSiteAudit: body.skipSiteAudit,
        signal,
      });
    }
    case "/serp": {
      const { runKeywordSerp } = await import(engine("serp.server"));
      return runKeywordSerp(String(body.url ?? ""), body.keywords ?? [], {
        engines: body.engines,
        depth: body.depth,
        market: body.market,
        device: body.device,
        signal,
      });
    }
    case "/ideas": {
      const { suggestKeywords } = await import(engine("suggest.server"));
      return suggestKeywords(body.keywords ?? [], { limit: body.limit ?? 60, signal });
    }
    case "/gap": {
      const { runLinkGap } = await import(engine("gap.server"));
      return runLinkGap(String(body.url ?? ""), body.competitors ?? [], signal);
    }
    default:
      return { ok: false, error: `Unknown endpoint: ${pathname}` };
  }
}
