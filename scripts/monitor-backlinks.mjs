#!/usr/bin/env node
/** Local finite monitor driver; never installs a daemon or sends notifications. */
import {
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { pathToFileURL } from "node:url";

export async function monitorBacklinks(args = process.argv.slice(2)) {
  const [action, database, tenantId, projectId, subject, selection, out] = args;
  if (args.length !== 7 || !["create", "tick", "export"].includes(action))
    throw new Error(
      "Usage: monitor-backlinks <create|tick|export> <private-sqlite> <tenant> <project> <local-operator> <private-plan-json|monitor-id> <new-private-output-json>",
    );
  const source = existsSync(
    new URL("../src/lib/backlinks/backlink-monitor.server.ts", import.meta.url),
  );
  const moduleUrl = (name) =>
    new URL(source ? `../src/lib/backlinks/${name}.ts` : `../dist/${name}.js`, import.meta.url);
  const { BacklinkMonitor, assertPrivateMonitoringPath } = await import(
    moduleUrl("backlink-monitor.server")
  );
  const { createTenantScope } = await import(moduleUrl("tenant-scope"));
  assertPrivateMonitoringPath(out);
  const descriptor = openSync(out, "wx", 0o600);
  let monitor,
    complete = false;
  try {
    if (action !== "create") assertPrivateMonitoringPath(database, true);
    const scope = createTenantScope(
      { subject, tenantId, projectIds: [projectId], role: "operator" },
      projectId,
    );
    monitor = new BacklinkMonitor(database, scope);
    let result;
    if (action === "create") {
      assertPrivateMonitoringPath(selection, true);
      if (lstatSync(selection).size > 65536) throw new Error("Monitor plan exceeds 64 KiB.");
      result = {
        schema: "backlink-monitor.command.v1",
        action,
        plan: monitor.create(JSON.parse(readFileSync(selection, "utf8"))),
      };
    } else if (action === "tick")
      result = {
        schema: "backlink-monitor.command.v1",
        action,
        monitorId: selection,
        ...(await monitor.tick(selection, subject)),
      };
    else result = monitor.export(selection);
    const encoded = JSON.stringify(result) + "\n";
    if (Buffer.byteLength(encoded) > 8_000_000)
      throw new Error("Monitoring export exceeds 8 MB; use the retained database directly.");
    writeFileSync(descriptor, encoded);
    complete = true;
    return { action, out };
  } finally {
    monitor?.close();
    closeSync(descriptor);
    if (!complete) unlinkSync(out);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  monitorBacklinks().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
