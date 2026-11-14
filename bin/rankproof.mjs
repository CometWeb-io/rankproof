#!/usr/bin/env node
/**
 * RankProof CLI — a full audit from the terminal, without running the web app.
 *
 * Requires Node 22+ (the --experimental-strip-types flag is added automatically
 * by re-executing the process when it is missing).
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { doctorExitCode, nodeVersionError } from "../scripts/node-version.mjs";

const STRIP = "--experimental-strip-types";

const versionError = nodeVersionError(process.version);
if (versionError) {
  console.error(versionError);
  process.exit(1);
}

/**
 * Where the engine lives.
 *
 * From a clone we run the TypeScript sources directly. An installed package
 * cannot: Node refuses to strip types under `node_modules`
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so the published tarball
 * carries `dist/` compiled to plain JavaScript and we load that instead.
 */
const SRC = new URL("../src/lib/backlinks/", import.meta.url);
const DIST = new URL("../dist/", import.meta.url);
// Sources win when they are present, so a stale `dist/` in a clone can never
// shadow the code you are editing. The published tarball ships only `dist/`.
const COMPILED = !existsSync(new URL("cli.ts", SRC));
const engine = (name) =>
  COMPILED ? new URL(`${name}.js`, DIST).href : new URL(`${name}.ts`, SRC).href;

// Node only runs .ts with this flag; a compiled build does not need it.
if (!COMPILED && !process.execArgv.includes(STRIP) && !process.env.RANKPROOF_CLI_CHILD) {
  const child = spawn(
    process.execPath,
    [STRIP, "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, RANKPROOF_CLI_CHILD: "1" } },
  );
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  await main();
}

async function main() {
  const { loadDotEnv } = await import("../scripts/load-dotenv.mjs");
  loadDotEnv();
  const { parseArgs, HELP } = await import(engine("cli"));
  const options = parseArgs(process.argv.slice(2));

  if (options.command === "help") {
    console.log(HELP);
    return;
  }
  if (options.command === "version") {
    const pkg = await import("../package.json", { with: { type: "json" } });
    console.log(`rankproof ${pkg.default.version ?? "0.0.0"}`);
    return;
  }
  if (options.error) {
    console.error(`Error: ${options.error}\n`);
    console.error("Run `rankproof help` to see the available options.");
    process.exitCode = 2;
    return;
  }

  const log = (message) => {
    if (!options.quiet) console.error(message);
  };

  if (options.command === "mcp") {
    // stdout belongs to the protocol: nothing else may be printed there.
    const { runMcpStdio } = await import(engine("mcp.server"));
    const pkg = await import("../package.json", { with: { type: "json" } });
    await runMcpStdio({ name: "rankproof", version: pkg.default.version ?? "0.0.0" });
    return;
  }

  try {
    const output = await run(options, log);
    if (options.out) {
      await writeFile(options.out, output, "utf8");
      log(`Saved: ${options.out}`);
    } else {
      process.stdout.write(`${output}\n`);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function run(options, log) {
  switch (options.command) {
    case "scan":
      return runScanCommand(options, log);
    case "serp":
      return runSerpCommand(options, log);
    case "ideas":
      return runIdeasCommand(options, log);
    case "gap":
      return runGapCommand(options, log);
    case "verify":
      return runVerifyCommand(options, log);
    case "replay":
      return runReplayCommand(options, log);
    case "keygen": {
      const { generateSigningKey } = await import(engine("seal.server"));
      const paths = [`${options.out}.pem`, `${options.out}.pub.pem`];
      if (!options.force) {
        // Overwriting a signing key silently orphans every seal made with it.
        const existing = paths.filter((path) => existsSync(path));
        if (existing.length > 0) {
          throw new Error(
            `${existing.join(" and ")} already exist${existing.length === 1 ? "s" : ""}; refusing to overwrite a signing key (use --force to replace it).`,
          );
        }
      }
      const { privatePem, publicPem } = generateSigningKey();
      const flag = options.force ? "w" : "wx";
      await writeFile(paths[0], privatePem, { mode: 0o600, flag });
      await writeFile(paths[1], publicPem, { flag });
      const out = options.out;
      options.out = null;
      return `Wrote ${out}.pem (private, keep it secret) and ${out}.pub.pem (share it).`;
    }
    case "seal": {
      const { sealFile } = await import(engine("seal.server"));
      const { seal, tokenPath } = await sealFile(options.target, {
        keyPem: options.key ? await readFile(options.key, "utf8") : null,
        tsaUrl: options.tsa,
        wayback: options.wayback,
        log,
      });
      const sealPath = options.out ?? `${options.target}.seal.json`;
      await writeFile(sealPath, `${JSON.stringify(seal, null, 2)}\n`);
      options.out = null;
      return `Sealed ${options.target} → ${sealPath}${tokenPath ? ` (+ ${tokenPath})` : ""}.`;
    }
    case "check-seal": {
      const { checkSeal, sealCheckText } = await import(engine("seal.server"));
      const sealPath = options.seal ?? `${options.target}.seal.json`;
      const result = await checkSeal(options.target, JSON.parse(await readFile(sealPath, "utf8")), {
        publicKeyPem: options.publicKey ? await readFile(options.publicKey, "utf8") : null,
      });
      // Exit 3 only for a failed check; an unverified claim is reported, not failed.
      if (result.status === "failed") process.exitCode = 3;
      return options.format === "json" ? JSON.stringify(result, null, 2) : sealCheckText(result);
    }
    case "report": {
      const verify = await import(engine("verify-run.server"));
      const run = JSON.parse(await readFile(options.target, "utf8"));
      if (run?.kind !== "rankproof.verify-run") {
        throw new Error("report expects a JSON run from `rankproof verify --format json`.");
      }
      if (options.strict) process.exitCode = verify.strictExitCode(run);
      return verify.formatVerifyRun(run, options.format);
    }
    case "corpus": {
      const { buildCorpus } = await import(engine("corpus.server"));
      const corpus = await buildCorpus(
        JSON.parse(await readFile(options.target, "utf8")),
        options.captureDir,
      );
      log(
        `${corpus.cases.length} case(s) to review. Set "reviewed": true after checking each one.`,
      );
      return JSON.stringify(corpus, null, 2);
    }
    case "export-warc": {
      const { exportWarc } = await import(engine("warc.server"));
      const pkg = await import("../package.json", { with: { type: "json" } });
      const result = await exportWarc(
        JSON.parse(await readFile(options.target, "utf8")),
        options.captureDir,
        {
          software: `RankProof ${pkg.default.version ?? ""}`.trim(),
          filename: options.out.split(/[\\/]/).pop(),
        },
      );
      const warcPath = options.out;
      await writeFile(warcPath, result.bytes);
      for (const item of result.skipped) log(`Skipped ${item.source_url}: ${item.reason}`);
      // Written directly (binary); the summary goes to stdout instead of the file.
      options.out = null;
      return `Wrote ${result.records} WARC records (${result.included} observation(s)) to ${warcPath}.`;
    }
    case "history": {
      const history = await import(engine("verify-history.server"));
      const report = await history.buildHistory(options.target);
      if (options.format === "json") return JSON.stringify(report, null, 2);
      if (options.format === "csv") return history.historyCsv(report);
      return history.historyText(report);
    }
    case "doctor":
      return runDoctorCommand(options, log);
    default:
      throw new Error(`Unsupported command: ${options.command}`);
  }
}

async function readInput(path) {
  if (path === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  }
  return readFile(path, "utf8");
}

async function runVerifyCommand(options, log) {
  const verify = await import(engine("verify-run.server"));
  const history = options.history ? await import(engine("verify-history.server")) : null;
  let previous = options.previous
    ? verify.previousObservations(JSON.parse(await readFile(options.previous, "utf8")))
    : undefined;
  if (!previous && history) {
    const latest = await history.loadLatestRun(options.history);
    if (latest) {
      previous = latest.results;
      log(`Comparing with ${latest.file}.`);
    } else {
      log("First run in this history directory.");
    }
  }
  const captureDir =
    options.captureDir ?? (history ? history.historyPaths(options.history).evidence : null);
  if (options.render !== "off") {
    const { renderAvailability } = await import(engine("render.server"));
    const available = await renderAvailability();
    if (!available.ok) throw new Error(available.reason);
    log(`Rendering with ${available.engine} (${options.render}).`);
  }
  const run = await verify.runVerifyFile({
    table: await readInput(options.target),
    previous,
    captureDir,
    log,
    render: options.render,
    checkpoint: options.checkpoint,
  });
  if (options.checkpoint) {
    // The run is complete: a stale checkpoint must not silently skip next week's checks.
    const { unlink } = await import("node:fs/promises");
    await unlink(options.checkpoint).catch(() => {});
    log(`Run complete; removed checkpoint ${options.checkpoint}.`);
  }
  if (history) {
    const saved = await history.saveRun(options.history, run, options.keep);
    log(`Stored ${saved}`);
  }
  if (options.webhook) {
    const { webhookPayload, sendWebhook } = await import(engine("verify-history.server"));
    const payload = webhookPayload(run);
    if (!payload) {
      log("No changes; webhook not called.");
    } else {
      try {
        await sendWebhook(options.webhook, payload);
        log(`Webhook notified about ${payload.changes.length} change(s).`);
      } catch (error) {
        // The run itself succeeded and is stored; a failed notification must be visible.
        console.error(`Webhook failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 4;
      }
    }
  }
  const s = run.summary;
  log(
    `Done: ${s.meets} meet · ${s.deviates} deviate · ${s.missing} not in HTML · ${s.unverified} unverified.`,
  );
  if (options.strict) {
    process.exitCode = verify.combineStrictExitCode(Number(process.exitCode ?? 0) || 0, run);
  }
  return verify.formatVerifyRun(run, options.format);
}

async function runReplayCommand(options, log) {
  const verify = await import(engine("verify-run.server"));
  const run = await verify.replayRun(
    JSON.parse(await readFile(options.target, "utf8")),
    options.captureDir,
    { render: options.render !== "off" },
  );
  log(`Replayed ${run.results.length} observation(s) offline.`);
  if (run.summary.differs > 0 || run.summary.integrity_failed > 0) process.exitCode = 3;
  return options.format === "json" ? JSON.stringify(run, null, 2) : verify.replayText(run);
}

async function runScanCommand(options, log) {
  const { runScan } = await import(engine("engine.server"));
  log(`Scanning ${options.target} (${options.market}/${options.device})…`);
  const result = await runScan(options.target, {
    market: options.market,
    device: options.device,
    engines: options.engines.length > 0 ? options.engines : undefined,
    depth: options.depth,
    skipSiteAudit: options.skipAudit,
    // The CLI runs with the operator's own credentials, for the operator.
    ownerData: "operator",
  });
  if (!result.ok) throw new Error(result.error);
  const report = result.report;
  log(`Done in ${Math.round(report.stats.durationMs / 1000)} s.`);

  const exports = await import(engine("export"));
  if (options.format === "json") return exports.reportJson(report);
  if (options.format === "csv") return exports.backlinksCsv(report);
  if (options.format === "html") return exports.reportHtml(report);
  if (options.format === "disavow") return exports.disavowFile(report);
  return renderScanText(report);
}

async function runSerpCommand(options, log) {
  const { runKeywordSerp } = await import(engine("serp.server"));
  const n = options.keywords.length;
  log(`Checking ${n} ${n === 1 ? "keyword" : "keywords"}…`);
  const result = await runKeywordSerp(options.target, options.keywords, {
    engines: options.engines.length > 0 ? options.engines : undefined,
    depth: options.depth,
    market: options.market,
    device: options.device,
  });
  if (!result.ok) throw new Error(result.error);
  if (options.format === "json") return JSON.stringify(result, null, 2);
  if (options.format === "csv") {
    const header = "keyword,engine,position,difficulty";
    const rows = result.snapshot.queries.map(
      (query) =>
        `"${query.keyword}","${query.engine}",${query.targetPosition ?? ""},${query.difficulty}`,
    );
    return [header, ...rows].join("\n");
  }
  return renderSerpText(result.snapshot, result.keywords);
}

async function runIdeasCommand(options, log) {
  const { suggestKeywords } = await import(engine("suggest.server"));
  log("Collecting search-engine suggestions…");
  const result = await suggestKeywords(options.keywords, { limit: 100 });
  if (!result.ok) throw new Error(result.error);
  if (options.format === "json") return JSON.stringify(result, null, 2);
  const { keywordIdeasCsv } = await import(engine("export"));
  if (options.format === "csv") return keywordIdeasCsv(result.ideas);
  return result.ideas
    .map((idea) => `${String(idea.score).padStart(3)}  ${idea.intent.padEnd(14)} ${idea.keyword}`)
    .join("\n");
}

async function runGapCommand(options, log) {
  const { runLinkGap } = await import(engine("gap.server"));
  log(`Comparing against ${options.competitors.length} competitors — this takes a few minutes…`);
  const result = await runLinkGap(options.target, options.competitors);
  if (!result.ok) throw new Error(result.error);
  if (options.format === "json") return JSON.stringify(result.report, null, 2);
  const { gapCsv } = await import(engine("export"));
  if (options.format === "csv") return gapCsv(result.report);
  return result.report.gap
    .slice(0, 50)
    .map(
      (row) =>
        `${String(row.priority).padStart(3)}  ${row.domain.padEnd(34)} DS ${String(row.domainScore).padStart(3)}  ${row.competitors.join(", ")}`,
    )
    .join("\n");
}

async function runDoctorCommand(options, log) {
  const { runDoctor } = await import(engine("doctor.server"));
  log("Probing engines…");
  const diagnosis = await runDoctor();
  // Non-zero when no engine works — same contract as HTTP GET /doctor → 503
  // and docs/production-ops.md (cron canary). Set before any return path.
  process.exitCode = doctorExitCode(diagnosis.healthy);
  if (options.format === "json") return JSON.stringify(diagnosis, null, 2);

  const lines = ["RankProof doctor", ""];
  lines.push("ENGINES");
  for (const engine of diagnosis.engines) {
    const mark =
      engine.status === "ok" ? "ok  " : engine.status === "not-configured" ? "skip" : "FAIL";
    lines.push(
      `  ${mark} ${engine.engine.padEnd(12)} ${String(engine.hits).padStart(2)} results  ${String(engine.ms).padStart(5)} ms  ${engine.status}`,
    );
    if (engine.status !== "ok") lines.push(`       ${engine.hint}`);
  }
  lines.push("");
  lines.push("ENVIRONMENT");
  for (const item of diagnosis.environment) {
    lines.push(`  ${item.ok ? "ok  " : "warn"} ${item.key.padEnd(18)} ${item.value}`);
    if (!item.ok) lines.push(`       ${item.hint}`);
  }
  lines.push("");
  lines.push(
    diagnosis.healthy
      ? "At least one engine is working — scans will produce results."
      : "No engine returned results. Scans will report zero visibility, which is a measurement failure, not a fact about the site.",
  );
  return lines.join("\n");
}

/* ------------------------------ Text rendering ---------------------------- */

function bar(value, max = 100, width = 24) {
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return `${"█".repeat(filled)}${"·".repeat(width - filled)}`;
}

function renderScanText(report) {
  const { stats, scorecard, serp, toxic, plan } = report;
  const lines = [];
  lines.push(`RankProof — ${report.target.host}`);
  lines.push(`${report.target.title ?? ""}`.trim());
  lines.push("");
  lines.push(
    `VISIBILITY INDEX  ${scorecard.index}/100 (${scorecard.grade})  ${bar(scorecard.index)}`,
  );
  for (const part of scorecard.parts) {
    lines.push(
      `  ${part.label.padEnd(20)} ${String(part.score).padStart(3)}/${String(part.max).padEnd(3)} ${bar(part.score, part.max, 14)}`,
    );
  }
  lines.push("");
  lines.push("LINK PROFILE");
  lines.push(
    `  ${stats.backlinks} links · ${stats.referringDomains} domains · DR ${stats.domainRating} · dofollow ${stats.dofollow}`,
  );
  lines.push(
    `  lost ${stats.lostLinks} · broken ${stats.brokenLinks} · to disavow ${toxic.disavowCount} · footprint ${report.footprint.score}/100 (${report.footprint.verdict})`,
  );
  lines.push(
    report.velocity.verdict === "unknown"
      ? "  velocity: unknown (dated acquisition cohort unavailable)"
      : `  velocity: ${report.velocity.perMonth} new domains/month (${report.velocity.verdict})`,
  );
  lines.push("");
  lines.push("SERP");
  lines.push(
    `  visibility ${stats.serpVisibility}/100 · top3 ${serp.top3} · top10 ${serp.top10} · traffic ~${serp.trafficScore} · avg pos. ${serp.avgPosition || "—"}`,
  );
  lines.push(
    `  ${serp.queries.length} queries (${serp.engines.join(", ") || "none"}) · market ${serp.market}/${serp.device} · competitors ${serp.competitors.length}`,
  );
  if (report.brandSerp) {
    lines.push(
      `  brand SERP "${report.brandSerp.keyword}": control ${report.brandSerp.control}% (${report.brandSerp.owned}/${report.brandSerp.results.length} results)`,
    );
  }
  if (serp.competitors.length > 0) {
    lines.push("");
    lines.push("SERP COMPETITORS");
    for (const row of serp.competitors.slice(0, 5)) {
      lines.push(
        `  ${row.domain.padEnd(32)} SoV ${String(row.shareOfVoice).padStart(5)}%  ${row.keywords} keywords  avg #${row.avgPosition}`,
      );
    }
  }
  if (report.siteAudit) {
    lines.push("");
    lines.push("INTERNAL STRUCTURE");
    lines.push(
      `  score ${report.siteAudit.score}/100 · ${report.siteAudit.crawled} pages · ${report.siteAudit.orphans} orphans · avg depth ${report.siteAudit.avgDepth}`,
    );
  }
  if (report.searchConsole?.connected) {
    const totals = report.searchConsole.providers
      .filter((provider) => provider.connected)
      .map(
        (provider) =>
          `${provider.source}: ${provider.totals.clicks} clicks / ${provider.totals.impressions} impressions`,
      )
      .join(" · ");
    lines.push("");
    lines.push("MEASURED PERFORMANCE");
    lines.push(`  ${totals}`);
    lines.push(
      `  ${report.searchConsole.striking.length} queries near the top three · ${report.searchConsole.ctrAnomalies.length} with weak CTR`,
    );
  }
  const unhealthy = report.serp.engineHealth.filter((item) => item.status !== "ok");
  if (unhealthy.length > 0) {
    lines.push("");
    lines.push("MEASUREMENT WARNINGS");
    for (const item of unhealthy) {
      lines.push(
        `  ${item.engine}: ${item.status} — visibility is based on fewer engines than intended`,
      );
    }
  }
  lines.push("");
  lines.push(`ACTION PLAN (${plan.items.length} tasks, ${plan.quickWins} quick wins)`);
  for (const [index, item] of plan.items.slice(0, 10).entries()) {
    lines.push(
      `  ${index + 1}. [${String(item.priority).padStart(3)}] ${item.title}  (${item.effort})`,
    );
    lines.push(`      ${item.detail}`);
  }
  lines.push("");
  lines.push(
    "These metrics are approximations computed from open sources — they are not equivalents of commercial tool metrics.",
  );
  return lines.join("\n");
}

function renderSerpText(snapshot, keywords) {
  const lines = [];
  lines.push(
    `Visibility ${snapshot.visibility}/100 · top3 ${snapshot.top3} · top10 ${snapshot.top10} · traffic ~${snapshot.trafficScore}`,
  );
  lines.push(
    `Market ${snapshot.market}/${snapshot.device} · engines: ${snapshot.engines.join(", ")}`,
  );
  lines.push("");
  for (const row of keywords) {
    const positions = row.engines
      .map((engine) => `${engine.engine} ${engine.position ? `#${engine.position}` : "—"}`)
      .join("  ");
    lines.push(
      `${row.keyword.padEnd(38)} difficulty ${String(row.difficulty).padStart(3)}  ${positions}`,
    );
  }
  if (snapshot.cannibalization.length > 0) {
    lines.push("");
    lines.push("CANNIBALISATION");
    for (const item of snapshot.cannibalization) {
      lines.push(
        `  "${item.keyword}" (${item.engine}): ${item.urls.map((u) => `#${u.position}`).join(", ")}`,
      );
    }
  }
  return lines.join("\n");
}
