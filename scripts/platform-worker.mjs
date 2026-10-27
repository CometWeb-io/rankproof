#!/usr/bin/env node
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export async function platformWorker(args = process.argv.slice(2)) {
  const [database, tenantId, projectId, runId, workerId] = args;
  if (!database || !tenantId || !projectId || !runId || !workerId || args.length !== 5) {
    throw new Error(
      "Usage: platform-worker <private-sqlite-file> <tenant> <project> <run> <worker>",
    );
  }
  const source = existsSync(
    new URL("../src/lib/backlinks/scan-queue-worker.server.ts", import.meta.url),
  );
  const moduleUrl = (name) =>
    new URL(source ? `../src/lib/backlinks/${name}.ts` : `../dist/${name}.js`, import.meta.url);
  const { assertScanQueueRuntime } = await import(moduleUrl("scan-queue-runtime"));
  assertScanQueueRuntime();
  const { ScanQueue } = await import(moduleUrl("scan-queue.server"));
  const { createTenantScope } = await import(moduleUrl("tenant-scope"));
  const { runNextQueuedVerification } = await import(moduleUrl("scan-queue-worker.server"));
  // Local OS access is the trust boundary. HTTP adapters must authenticate before issuing this scope.
  const scope = createTenantScope(
    { subject: workerId, tenantId, projectIds: [projectId], role: "worker" },
    projectId,
  );
  const queue = new ScanQueue(database);
  try {
    return await runNextQueuedVerification(queue, scope, runId, workerId);
  } finally {
    queue.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  platformWorker()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
