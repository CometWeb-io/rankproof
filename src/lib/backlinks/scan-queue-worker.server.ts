import { performance } from "node:perf_hooks";
import { ScanQueue } from "./scan-queue.server.ts";
import { assertTenantScope, requirePlatformId, type TenantScope } from "./tenant-scope.ts";
import { PlatformTelemetry, type PlatformSample } from "./telemetry.server.ts";
import { withScanQueueRequests } from "./scan-queue-transport.server.ts";
import { verifyPairsFromBody, type BacklinkObservation } from "./verify-api.server.ts";

export const SCAN_QUEUE_TRANSPORT_CONTRACT = "queue-request.v1";
export type VerificationExecutor = {
  transportContract: typeof SCAN_QUEUE_TRANSPORT_CONTRACT;
  verifyBacklinks: (
    body: unknown,
    options?: { includeRelationshipContext?: boolean },
  ) => Promise<{ ok: true; schema_version: "1"; results: BacklinkObservation[] }>;
};

export function grantQueuedVerification(
  queue: ScanQueue,
  scope: TenantScope,
  input: {
    id: string;
    runId: string;
    sourceUrl: string;
    targetUrl: string;
    expiresAt: number;
    retainRelationshipContext?: boolean;
  },
): string {
  assertTenantScope(scope, "manage");
  requirePlatformId(input.id);
  queue.usage(scope, input.runId);
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now())
    throw new Error("Invalid scan grant expiry.");
  if (
    input.retainRelationshipContext !== undefined &&
    typeof input.retainRelationshipContext !== "boolean"
  )
    throw new Error("Invalid relationship-context retention policy.");
  const pairs = verifyPairsFromBody({
    items: [{ source_url: input.sourceUrl, target_url: input.targetUrl }],
  });
  const artifactId = `scan-grant.${input.id}`;
  queue.putArtifact(scope, artifactId, {
    kind: "scan-verification-grant.v1",
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    operator: scope.subject,
    runId: input.runId,
    expiresAt: input.expiresAt,
    pair: pairs[0],
    ...(input.retainRelationshipContext ? { retainRelationshipContext: true } : {}),
  });
  return artifactId;
}

async function defaultExecutor(): Promise<VerificationExecutor> {
  const net = await import("./net.server.ts");
  if (
    (net as unknown as Record<string, unknown>).SCAN_QUEUE_TRANSPORT_CONTRACT !==
    SCAN_QUEUE_TRANSPORT_CONTRACT
  ) {
    throw new Error(
      "Platform worker refuses unmetered transport: bind queue-request.v1 in net.server.ts first.",
    );
  }
  const { verifyBacklinks } = await import("./verify-api.server.ts");
  return {
    transportContract: SCAN_QUEUE_TRANSPORT_CONTRACT,
    verifyBacklinks,
  };
}

/** One job per call; scheduler may invoke repeatedly. A trusted custom executor must meter every hop. */
export async function runNextQueuedVerification(
  queue: ScanQueue,
  scope: TenantScope,
  runId: string,
  workerId: string,
  options: { executor?: VerificationExecutor; costUsd?: number | null } = {},
) {
  assertTenantScope(scope, "work");
  const executor = options.executor ?? (await defaultExecutor());
  if (executor.transportContract !== SCAN_QUEUE_TRANSPORT_CONTRACT)
    throw new Error("Unmetered platform executor.");
  if (
    options.costUsd !== undefined &&
    options.costUsd !== null &&
    (!Number.isFinite(options.costUsd) || options.costUsd < 0)
  )
    throw new Error("Invalid source cost.");
  const lease = queue.claim(scope, runId, workerId);
  if (!lease) return null;
  const telemetry = new PlatformTelemetry(queue);
  const started = performance.now();
  const cpu = process.cpuUsage();
  let heartbeatError: unknown;
  const timer = setInterval(
    () => {
      try {
        queue.heartbeat(scope, lease);
      } catch (error) {
        heartbeatError = error;
      }
    },
    Math.max(1, Math.floor((lease.leaseUntil - Date.now()) / 3)),
  );
  timer.unref();
  try {
    const payload = lease.payload as { kind?: string; grantArtifactId?: string } | null;
    if (
      payload?.kind !== "verify_backlinks.v1" ||
      typeof payload.grantArtifactId !== "string" ||
      !payload.grantArtifactId.startsWith("scan-grant.")
    )
      throw new Error("Invalid queued verification payload.");
    const artifact = queue.getArtifact(scope, payload.grantArtifactId);
    const grant = artifact?.value as
      | {
          kind?: string;
          tenantId?: string;
          projectId?: string;
          runId?: string;
          expiresAt?: number;
          retainRelationshipContext?: boolean;
          pair?: { source_url: string; target_url: string };
        }
      | undefined;
    if (
      !grant ||
      grant.kind !== "scan-verification-grant.v1" ||
      grant.tenantId !== scope.tenantId ||
      grant.projectId !== scope.projectId ||
      grant.runId !== runId ||
      !Number.isSafeInteger(grant.expiresAt) ||
      grant.expiresAt! <= Date.now() ||
      !grant.pair ||
      new URL(grant.pair.source_url).href !== lease.url
    ) {
      throw new Error("Queued scan requires a matching, unexpired operator grant.");
    }
    const before = queue.usage(scope, runId).requests;
    const measured = await withScanQueueRequests(
      queue,
      scope,
      lease,
      () =>
        executor.verifyBacklinks(
          { items: [grant.pair] },
          { includeRelationshipContext: grant.retainRelationshipContext === true },
        ),
      grant.expiresAt,
    );
    if (heartbeatError) throw heartbeatError;
    if (measured.result.results.length !== 1)
      throw new Error("Unexpected verification result cardinality.");
    const observation = measured.result.results[0]!;
    const blocked =
      observation.status === "error" &&
      (observation.http_status === 403 ||
        observation.http_status === 429 ||
        /block|robots|challenge|cooldown|budget|grant expired/i.test(observation.reason ?? ""));
    const usedCpu = process.cpuUsage(cpu);
    const sample: PlatformSample = {
      measurementId: lease.id,
      observedAt: Date.now(),
      source: "backlink-verification",
      durationMs: performance.now() - started,
      bytes: measured.bytes,
      requests: measured.requests,
      outcome: blocked ? "blocked" : observation.status === "error" ? "error" : "success",
      measurement: blocked ? "blocked" : observation.status === "error" ? "unknown" : "complete",
      costUsd: options.costUsd ?? null,
      cpuUserMs: usedCpu.user / 1000,
      cpuSystemMs: usedCpu.system / 1000,
      rssBytes: process.memoryUsage().rss,
    };
    const resultId = queue.recordVerification(scope, lease, observation);
    const telemetryId = telemetry.record(scope, runId, sample);
    queue.complete(scope, lease, {
      artifactId: resultId,
      telemetryId,
      requestsBefore: before,
      requestsThisAttempt: measured.requests,
      grantDigest: artifact!.digest,
    });
    return { jobId: lease.id, artifactId: resultId, telemetryId, observation };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A stale lease cannot write a job result, retry, or evidence claiming successful completion.
    queue.fail(
      scope,
      lease,
      message.slice(0, 2000),
      !/grant|payload|cardinality|executor/i.test(message),
    );
    const usedCpu = process.cpuUsage(cpu);
    telemetry.record(scope, runId, {
      measurementId: lease.id,
      observedAt: Date.now(),
      source: "backlink-verification",
      durationMs: performance.now() - started,
      bytes: null,
      requests: null,
      outcome: "error",
      measurement: "unknown",
      costUsd: options.costUsd ?? null,
      cpuUserMs: usedCpu.user / 1000,
      cpuSystemMs: usedCpu.system / 1000,
      rssBytes: process.memoryUsage().rss,
    });
    throw error;
  } finally {
    clearInterval(timer);
  }
}
