#!/usr/bin/env node
/**
 * RankProof CLI — a full audit from the terminal, without running the web app.
 *
 * Requires Node 22+ (the --experimental-strip-types flag is added automatically
 * by re-executing the process when it is missing).
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const STRIP = "--experimental-strip-types";

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
    case "doctor":
      return runDoctorCommand(options, log);
    default:
      throw new Error(`Unsupported command: ${options.command}`);
  }
}

async function runScanCommand(options, log) {
  const { runScan } = await import(engine("engine.server"));
  log(`Scanning ${options.target} (${options.market}/${options.device})…`);
  const result = await runScan(options.target, {
    market: options.market,
    device: options.device,
    engines: options.engines.length > 0 ? options.engines : undefined,
    skipSiteAudit: options.skipAudit,
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
  // The non-zero exit is the point of `doctor` in CI, so it has to be set
  // before the JSON path returns — not only on the text path below.
  if (!diagnosis.healthy) process.exitCode = 1;
  if (options.format === "json") return JSON.stringify(diagnosis, null, 2);

  const lines = ["RankProof doctor", ""];
  lines.push("ENGINES");
  for (const engine of diagnosis.engines) {
    const mark =
      engine.status === "ok"
        ? "ok  "
        : engine.status === "not-configured"
          ? "skip"
          : "FAIL";
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
  lines.push(`VISIBILITY INDEX  ${scorecard.index}/100 (${scorecard.grade})  ${bar(scorecard.index)}`);
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
  lines.push(`  velocity: ${report.velocity.perMonth} new domains/month (${report.velocity.verdict})`);
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
      .map((provider) => `${provider.source}: ${provider.totals.clicks} clicks / ${provider.totals.impressions} impressions`)
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
      lines.push(`  ${item.engine}: ${item.status} — visibility is based on fewer engines than intended`);
    }
  }
  lines.push("");
  lines.push(`ACTION PLAN (${plan.items.length} tasks, ${plan.quickWins} quick wins)`);
  for (const [index, item] of plan.items.slice(0, 10).entries()) {
    lines.push(`  ${index + 1}. [${String(item.priority).padStart(3)}] ${item.title}  (${item.effort})`);
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
  lines.push(`Market ${snapshot.market}/${snapshot.device} · engines: ${snapshot.engines.join(", ")}`);
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
      lines.push(`  "${item.keyword}" (${item.engine}): ${item.urls.map((u) => `#${u.position}`).join(", ")}`);
    }
  }
  return lines.join("\n");
}
