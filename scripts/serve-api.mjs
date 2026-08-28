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

/** A simple limiter: N requests per time window, counted per client address. */
function createLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now > entry.reset) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    if (entry.count >= max) return false;
    entry.count += 1;
    return true;
  };
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
  const allow = createLimiter(
    Number(process.env.RANKPROOF_RATE_LIMIT ?? 20),
    Number(process.env.RANKPROOF_RATE_WINDOW_MS ?? 60_000),
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
    if (req.method === "GET" && url.pathname === "/doctor") {
      // /doctor probes five engines sequentially, so it is rate-limited like
      // the POST endpoints. /health above stays free: it is a liveness probe.
      if (!allow(req.socket.remoteAddress ?? "unknown")) {
        send(429, { ok: false, error: "Too many requests. Try again shortly." });
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
      }
      return;
    }
    if (req.method !== "POST") {
      send(405, { ok: false, error: "Only POST requests are supported (except /health and /doctor)." });
      return;
    }
    if (!allow(req.socket.remoteAddress ?? "unknown")) {
      send(429, { ok: false, error: "Too many requests. Try again shortly." });
      return;
    }

    try {
      const body = await readJson(req);
      const result = await route(url.pathname, body);
      send(result.ok ? 200 : 400, result);
    } catch (error) {
      send(400, { ok: false, error: error instanceof Error ? error.message : "Request error." });
    }
  });

  server.listen(port, host, () => {
    console.log(`RankProof API: http://${host}:${port}`);
    console.log("Endpoints: GET /health /doctor · POST /scan /serp /ideas /gap");
    if (host !== "127.0.0.1" && host !== "localhost") {
      console.log(
        "WARNING: the server is listening beyond localhost. Put a reverse proxy with authentication in front of it.",
      );
    }
  });
}

async function route(pathname, body) {
  switch (pathname) {
    case "/scan": {
      const { runScan } = await import(engine("engine.server"));
      return runScan(String(body.url ?? ""), {
        market: body.market,
        device: body.device,
        engines: body.engines,
        skipSiteAudit: body.skipSiteAudit,
      });
    }
    case "/serp": {
      const { runKeywordSerp } = await import(engine("serp.server"));
      return runKeywordSerp(String(body.url ?? ""), body.keywords ?? [], {
        engines: body.engines,
        depth: body.depth,
        market: body.market,
        device: body.device,
      });
    }
    case "/ideas": {
      const { suggestKeywords } = await import(engine("suggest.server"));
      return suggestKeywords(body.keywords ?? [], { limit: body.limit ?? 60 });
    }
    case "/gap": {
      const { runLinkGap } = await import(engine("gap.server"));
      return runLinkGap(String(body.url ?? ""), body.competitors ?? []);
    }
    default:
      return { ok: false, error: `Unknown endpoint: ${pathname}` };
  }
}
