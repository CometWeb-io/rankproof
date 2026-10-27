/** Finite local backlink monitoring over the existing durable queue and trusted verifier worker. */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ScanQueue, type ScanQueuePolicy } from "./scan-queue.server.ts";
import { grantQueuedVerification, runNextQueuedVerification } from "./scan-queue-worker.server.ts";
import { assertTenantScope, requirePlatformId, type TenantScope } from "./tenant-scope.ts";
import {
  verifyPairsFromBody,
  type VerifyPair,
  type BacklinkObservation,
} from "./verify-api.server.ts";
import {
  relationshipObservation,
  relationshipComparable,
  compareRelationship,
} from "./relationships.ts";
import { backlinkId } from "./score.ts";
import { hostFromUrl, isTargetHost } from "./parse.ts";
import {
  AGENT_OBSERVATION_SCHEMA,
  validateAgentSchema,
  validateObservationConsistency,
} from "./agent-api-contract.ts";

const hour = 3_600_000;
export const MONITOR_LIMITS = Object.freeze({
  pairs: 10,
  occurrences: 30,
  minIntervalMs: hour,
  maxIntervalMs: 30 * 24 * hour,
  maxHorizonMs: 31 * 24 * hour,
  minWindowMs: 60_000,
  maxWindowMs: hour,
  requestsPerCycle: 100,
});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const prefix = (id: string) => {
  requirePlatformId(id);
  if (id.length > 64) throw new Error("Monitor id exceeds 64 characters.");
  return hash(id);
};
const planId = (id: string) => `monitor.plan.${prefix(id)}`;
const receiptId = (id: string, index: number) =>
  `monitor.receipt.${prefix(id)}.${String(index).padStart(4, "0")}`;
const runId = (id: string, index: number) =>
  `monitor.${prefix(id).slice(0, 32)}.${String(index).padStart(4, "0")}`;
const grantId = (id: string, index: number, pair: number) =>
  `monitor.${prefix(id).slice(0, 32)}.${index}.${pair}`;
function integer(value: unknown, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new Error("Monitor policy exceeds bounded schedule limits.");
}

/** Local OS ownership is the trust boundary, not a hosted authentication or Team Cloud claim. */
export function assertPrivateMonitoringPath(path: string, mustExist = false): void {
  if (process.platform === "win32" || !isAbsolute(path))
    throw new Error("Monitoring requires an absolute POSIX private path.");
  const check = (name: string, directory: boolean) => {
    const stat = lstatSync(name);
    if (
      stat.isSymbolicLink() ||
      (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error(
        "Monitoring requires an owned private directory/file with owner-only permissions.",
      );
  };
  check(dirname(path), true);
  try {
    check(path, false);
  } catch (error) {
    if (mustExist || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

type Input = {
  id: string;
  pairs: VerifyPair[];
  firstAt: number;
  intervalMs: number;
  occurrences: number;
  windowMs: number;
  maxRequestsPerCycle: number;
};
export type MonitoringPlan = Input & {
  schema: "backlink-monitor.plan.v1";
  retainRelationshipContext: true;
  tenantId: string;
  projectId: string;
  operator: string;
  createdAt: number;
  endsAt: number;
  cohortHash: string;
  policy: ScanQueuePolicy;
  cycles: {
    runId: string;
    dueAt: number;
    expiresAt: number;
    jobs: { id: string; grantArtifactId: string }[];
  }[];
};
type Evidence = { artifactId: string; digest: string; observation: BacklinkObservation };
type Outcome =
  | "present"
  | "html_absent"
  | "absent_without_baseline"
  | "incomparable_absence"
  | "source_unavailable"
  | "unavailable"
  | "unmeasured";
type PairReceipt = VerifyPair & {
  jobId: string;
  observationArtifactId: string | null;
  baselineArtifactId: string | null;
  outcome: Outcome;
  comparison: ReturnType<typeof compareRelationship> | null;
  attempt: {
    status: BacklinkObservation["status"];
    checkedAt: string;
    httpStatus: number | null;
    finalUrl: string | null;
    reason: string | null;
  } | null;
};
type Alert = {
  kind: "html_link_absent" | "link_attributes_changed" | "link_reconfirmed";
  pairIndex: number;
  scope: "fetched_html";
  beforeArtifactId: string;
  beforeDigest: string;
  afterArtifactId: string;
  afterDigest: string;
};
export type MonitoringReceipt = {
  schema: "backlink-monitor.receipt.v1";
  monitorId: string;
  tenantId: string;
  projectId: string;
  cohortHash: string;
  planDigest: string;
  occurrence: number;
  dueAt: number;
  expiresAt: number;
  recordedAt: number;
  previousDigest: string | null;
  missedWindow: boolean;
  execution: "complete" | "partial" | "unmeasured";
  requests: number;
  pairs: PairReceipt[];
  alerts: Alert[];
};
type SealedReceipt = MonitoringReceipt & { digest: string };

function input(value: unknown): Input {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a monitor plan object.");
  const data = value as Record<string, unknown>;
  const allowed = [
    "id",
    "pairs",
    "firstAt",
    "intervalMs",
    "occurrences",
    "windowMs",
    "maxRequestsPerCycle",
  ];
  if (Object.keys(data).some((key) => !allowed.includes(key)))
    throw new Error("Unknown monitor plan field.");
  prefix(data.id as string);
  const pairs = verifyPairsFromBody({ items: data.pairs });
  integer(pairs.length, 1, MONITOR_LIMITS.pairs);
  const ids = pairs.map((pair) =>
    backlinkId({ sourceUrl: pair.source_url, targetUrl: pair.target_url }),
  );
  if (new Set(ids).size !== pairs.length)
    throw new Error("Monitor cohort contains duplicate exact URL pairs.");
  if (
    pairs.some((pair) => isTargetHost(hostFromUrl(pair.source_url), hostFromUrl(pair.target_url)))
  )
    throw new Error("Monitor requires external backlink pairs.");
  integer(data.firstAt, 0, Number.MAX_SAFE_INTEGER);
  integer(data.intervalMs, MONITOR_LIMITS.minIntervalMs, MONITOR_LIMITS.maxIntervalMs);
  integer(data.occurrences, 1, MONITOR_LIMITS.occurrences);
  const windowMs = data.windowMs ?? 15 * 60_000;
  integer(
    windowMs,
    MONITOR_LIMITS.minWindowMs,
    Math.min(MONITOR_LIMITS.maxWindowMs, data.intervalMs),
  );
  const maximum = data.maxRequestsPerCycle ?? pairs.length * 10;
  integer(maximum, 1, MONITOR_LIMITS.requestsPerCycle);
  return {
    id: data.id as string,
    pairs,
    firstAt: data.firstAt,
    intervalMs: data.intervalMs,
    occurrences: data.occurrences,
    windowMs,
    maxRequestsPerCycle: maximum,
  };
}
function policy(maxRequests: number): ScanQueuePolicy {
  return {
    maxRequests,
    maxRequestsPerHost: maxRequests,
    maxConcurrentPerHost: 1,
    minHostIntervalMs: 0,
    maxAttempts: 2,
    retryBaseMs: 1000,
    leaseMs: 120_000,
  };
}
function inputFromPlan(plan: MonitoringPlan): Input {
  return {
    id: plan.id,
    pairs: plan.pairs,
    firstAt: plan.firstAt,
    intervalMs: plan.intervalMs,
    occurrences: plan.occurrences,
    windowMs: plan.windowMs,
    maxRequestsPerCycle: plan.maxRequestsPerCycle,
  };
}

export class BacklinkMonitor {
  private readonly queue: ScanQueue;
  private readonly scope: TenantScope;
  constructor(path: string, scope: TenantScope) {
    assertTenantScope(scope);
    assertPrivateMonitoringPath(path);
    this.scope = scope;
    this.queue = new ScanQueue(path);
  }
  close(): void {
    this.queue.close();
  }

  create(value: unknown): MonitoringPlan {
    assertTenantScope(this.scope, "manage");
    const requested = input(value);
    const existing = this.queue.getArtifact(this.scope, planId(requested.id));
    if (existing) {
      const plan = this.readPlan(requested.id).plan;
      if (hash(inputFromPlan(plan)) !== hash(requested))
        throw new Error("Monitor plan is immutable; renewal requires a new id.");
      return plan;
    }
    const createdAt = Date.now();
    const endsAt =
      requested.firstAt + (requested.occurrences - 1) * requested.intervalMs + requested.windowMs;
    if (
      requested.firstAt < createdAt - 60_000 ||
      requested.firstAt + requested.windowMs <= createdAt ||
      endsAt > createdAt + MONITOR_LIMITS.maxHorizonMs ||
      !Number.isSafeInteger(endsAt)
    )
      throw new Error("Monitor schedule is backdated, expired or exceeds 31 days.");
    const runPolicy = policy(requested.maxRequestsPerCycle);
    const cycles = Array.from({ length: requested.occurrences }, (_, index) => {
      const run = runId(requested.id, index),
        dueAt = requested.firstAt + index * requested.intervalMs,
        expiresAt = dueAt + requested.windowMs;
      this.queue.createRun(this.scope, run, runPolicy);
      const jobs = requested.pairs.map((pair, pairIndex) => {
        const grantArtifactId = grantQueuedVerification(this.queue, this.scope, {
          id: grantId(requested.id, index, pairIndex),
          runId: run,
          sourceUrl: pair.source_url,
          targetUrl: pair.target_url,
          expiresAt,
          retainRelationshipContext: true,
        });
        const job = this.queue.enqueue(this.scope, {
          runId: run,
          dedupeKey: `pair.${pairIndex}`,
          url: pair.source_url,
          payload: { kind: "verify_backlinks.v1", grantArtifactId },
          availableAt: dueAt,
        });
        return { id: job.id, grantArtifactId };
      });
      return { runId: run, dueAt, expiresAt, jobs };
    });
    const plan: MonitoringPlan = {
      schema: "backlink-monitor.plan.v1",
      retainRelationshipContext: true,
      ...requested,
      tenantId: this.scope.tenantId,
      projectId: this.scope.projectId,
      operator: this.scope.subject,
      createdAt,
      endsAt,
      cohortHash: hash(requested.pairs),
      policy: runPolicy,
      cycles,
    };
    this.queue.putArtifact(this.scope, planId(plan.id), plan);
    return plan;
  }

  private readPlan(id: string): { plan: MonitoringPlan; digest: string } {
    const stored = this.queue.getArtifact(this.scope, planId(id));
    if (!stored || stored.origin !== "operator_artifact")
      throw new Error("Monitor plan unavailable.");
    const plan = stored.value as MonitoringPlan;
    if (
      !plan ||
      plan.schema !== "backlink-monitor.plan.v1" ||
      plan.retainRelationshipContext !== true ||
      plan.id !== id ||
      plan.tenantId !== this.scope.tenantId ||
      plan.projectId !== this.scope.projectId
    )
      throw new Error("Invalid monitor plan identity.");
    const parsed = input(inputFromPlan(plan));
    requirePlatformId(plan.operator);
    integer(plan.createdAt, 0, Date.now());
    const end = plan.firstAt + (plan.occurrences - 1) * plan.intervalMs + plan.windowMs;
    if (
      plan.firstAt < plan.createdAt - 60_000 ||
      end !== plan.endsAt ||
      end > plan.createdAt + MONITOR_LIMITS.maxHorizonMs ||
      plan.cohortHash !== hash(parsed.pairs) ||
      !isDeepStrictEqual(plan.policy, policy(parsed.maxRequestsPerCycle)) ||
      !Array.isArray(plan.cycles) ||
      plan.cycles.length !== plan.occurrences
    )
      throw new Error("Invalid monitor schedule/cohort.");
    plan.cycles.forEach((cycle, index) => {
      if (
        cycle.runId !== runId(id, index) ||
        cycle.dueAt !== plan.firstAt + index * plan.intervalMs ||
        cycle.expiresAt !== cycle.dueAt + plan.windowMs ||
        cycle.jobs.length !== plan.pairs.length ||
        this.queue.usage(this.scope, cycle.runId).maxRequests !== plan.maxRequestsPerCycle
      )
        throw new Error("Invalid monitored queue schedule.");
      const scheduled = this.queue.listJobs(this.scope, cycle.runId);
      if (
        scheduled.length !== cycle.jobs.length ||
        scheduled.some((job) => !cycle.jobs.some(({ id }) => id === job.id))
      )
        throw new Error("Monitored run contains jobs outside its exact cohort.");
      cycle.jobs.forEach((reference, pairIndex) => {
        const pair = plan.pairs[pairIndex]!,
          job = this.queue.getJob(this.scope, reference.id),
          grant = this.queue.getArtifact(this.scope, reference.grantArtifactId);
        const expectedGrant = {
          kind: "scan-verification-grant.v1",
          tenantId: plan.tenantId,
          projectId: plan.projectId,
          operator: plan.operator,
          runId: cycle.runId,
          expiresAt: cycle.expiresAt,
          pair,
          retainRelationshipContext: true,
        };
        if (
          reference.grantArtifactId !== `scan-grant.${grantId(id, index, pairIndex)}` ||
          !grant ||
          grant.origin !== "operator_artifact" ||
          !isDeepStrictEqual(grant.value, expectedGrant) ||
          !job ||
          job.runId !== cycle.runId ||
          job.url !== new URL(pair.source_url).href ||
          !isDeepStrictEqual(job.payload, {
            kind: "verify_backlinks.v1",
            grantArtifactId: reference.grantArtifactId,
          })
        )
          throw new Error("Monitor job lacks its original exact-pair authorization.");
      });
    });
    return { plan, digest: stored.digest };
  }

  private evidence(plan: MonitoringPlan, occurrence: number, pairIndex: number): Evidence | null {
    const cycle = plan.cycles[occurrence]!,
      reference = cycle.jobs[pairIndex]!,
      job = this.queue.getJob(this.scope, reference.id)!;
    if (job.status !== "done") return null;
    const result = job.result as { artifactId?: string; grantDigest?: string } | null;
    if (!result?.artifactId)
      throw new Error("Completed monitoring job has no retained verification.");
    const artifact = this.queue.getArtifact(this.scope, result.artifactId),
      grant = this.queue.getArtifact(this.scope, reference.grantArtifactId)!;
    const envelope = artifact?.value as
      | {
          schema?: string;
          observation?: BacklinkObservation;
          jobId?: string;
          attempt?: number;
          grantDigest?: string;
        }
      | undefined;
    const row = envelope?.observation,
      pair = plan.pairs[pairIndex]!;
    if (
      !artifact ||
      artifact.origin !== "queue-worker.v1" ||
      envelope?.schema !== "queue-verification.v1" ||
      envelope.jobId !== job.id ||
      envelope.attempt !== job.attempt ||
      envelope.grantDigest !== grant.digest ||
      result.grantDigest !== grant.digest ||
      !row ||
      row.source_url !== pair.source_url ||
      row.target_url !== pair.target_url ||
      Date.parse(row.checked_at) < cycle.dueAt ||
      Date.parse(row.checked_at) >= cycle.expiresAt ||
      Date.parse(row.checked_at) > Date.now()
    )
      throw new Error("Untrusted or noncomparable monitoring evidence.");
    const projection = Object.fromEntries(
      Object.keys(AGENT_OBSERVATION_SCHEMA.properties).map((key) => [
        key,
        row[key as keyof BacklinkObservation],
      ]),
    );
    validateAgentSchema(projection, AGENT_OBSERVATION_SCHEMA);
    validateObservationConsistency(projection);
    if (
      row.status !== "error" &&
      (!/^[a-f0-9]{64}$/.test(row.response_hash ?? "") || !row.final_url)
    )
      throw new Error("Monitor observation lacks response proof.");
    return { artifactId: result.artifactId, digest: artifact.digest, observation: row };
  }

  private buildReceipt(
    plan: MonitoringPlan,
    planDigest: string,
    index: number,
    recordedAt: number,
    previous: SealedReceipt[],
  ): MonitoringReceipt {
    integer(recordedAt, plan.cycles[index]!.dueAt, Date.now());
    const cycle = plan.cycles[index]!,
      alerts: Alert[] = [];
    const pairs = plan.pairs.map((pair, pairIndex): PairReceipt => {
      const history = previous
        .map((receipt) => this.evidence(plan, receipt.occurrence, pairIndex))
        .filter((value): value is Evidence => value !== null);
      const current = this.evidence(plan, index, pairIndex);
      const baseline =
        history.filter((value) => value.observation.status === "confirmed").at(-1) ?? null;
      if (!current)
        return {
          ...pair,
          jobId: cycle.jobs[pairIndex]!.id,
          observationArtifactId: null,
          baselineArtifactId: baseline?.artifactId ?? null,
          outcome: "unmeasured",
          comparison: null,
          attempt: null,
        };
      if (Date.parse(current.observation.checked_at) > recordedAt)
        throw new Error("Receipt predates retained evidence.");
      const comparison = compareRelationship(
        [...history, current].map((value) => relationshipObservation(value.observation)),
      );
      const row = current.observation;
      const outcome: Outcome =
        row.status === "confirmed"
          ? "present"
          : row.status === "error"
            ? "unavailable"
            : row.absence_scope === "http_resource"
              ? "source_unavailable"
              : comparison.change === "absent_in_representation"
                ? "html_absent"
                : baseline
                  ? "incomparable_absence"
                  : "absent_without_baseline";
      const decisive = previous
        .filter((receipt) => ["present", "html_absent"].includes(receipt.pairs[pairIndex]!.outcome))
        .at(-1);
      const before = decisive ? this.evidence(plan, decisive.occurrence, pairIndex) : null;
      const alert = (kind: Alert["kind"], prior: Evidence) =>
        alerts.push({
          kind,
          pairIndex,
          scope: "fetched_html",
          beforeArtifactId: prior.artifactId,
          beforeDigest: prior.digest,
          afterArtifactId: current.artifactId,
          afterDigest: current.digest,
        });
      if (
        outcome === "html_absent" &&
        decisive?.pairs[pairIndex]!.outcome !== "html_absent" &&
        baseline
      )
        alert("html_link_absent", baseline);
      if (outcome === "present" && comparison.change === "attributes_changed" && baseline)
        alert("link_attributes_changed", baseline);
      if (
        outcome === "present" &&
        decisive?.pairs[pairIndex]!.outcome === "html_absent" &&
        before &&
        relationshipComparable(
          relationshipObservation(before.observation),
          relationshipObservation(row),
        )
      )
        alert("link_reconfirmed", before);
      return {
        ...pair,
        jobId: cycle.jobs[pairIndex]!.id,
        observationArtifactId: current.artifactId,
        baselineArtifactId: baseline?.artifactId ?? null,
        outcome,
        comparison,
        attempt: {
          status: row.status,
          checkedAt: row.checked_at,
          httpStatus: row.http_status,
          finalUrl: row.final_url,
          reason: row.reason,
        },
      };
    });
    const measured = pairs.filter((pair) => pair.observationArtifactId !== null).length;
    return {
      schema: "backlink-monitor.receipt.v1",
      monitorId: plan.id,
      tenantId: plan.tenantId,
      projectId: plan.projectId,
      cohortHash: plan.cohortHash,
      planDigest,
      occurrence: index,
      dueAt: cycle.dueAt,
      expiresAt: cycle.expiresAt,
      recordedAt,
      previousDigest: previous.at(-1)?.digest ?? null,
      missedWindow: recordedAt >= cycle.expiresAt && measured < pairs.length,
      execution: measured === pairs.length ? "complete" : measured ? "partial" : "unmeasured",
      requests: this.queue.usage(this.scope, cycle.runId).requests,
      pairs,
      alerts,
    };
  }

  private receipts(plan: MonitoringPlan, planDigest: string): SealedReceipt[] {
    const receipts: SealedReceipt[] = [];
    let gap = false;
    plan.cycles.forEach((cycle, index) => {
      const artifact = this.queue.getArtifact(this.scope, receiptId(plan.id, index));
      if (!artifact) {
        gap = true;
        return;
      }
      if (gap) throw new Error("Monitoring receipt chain has a gap.");
      const value = artifact.value as MonitoringReceipt;
      if (artifact.origin !== "operator_artifact" || !value || value.occurrence !== index)
        throw new Error("Invalid monitoring receipt origin.");
      if (
        value.recordedAt < cycle.expiresAt &&
        cycle.jobs.some(
          ({ id }) => !["done", "failed"].includes(this.queue.getJob(this.scope, id)!.status),
        )
      )
        throw new Error("Monitoring receipt is premature.");
      const expected = this.buildReceipt(plan, planDigest, index, value.recordedAt, receipts);
      if (!isDeepStrictEqual(JSON.parse(JSON.stringify(expected)), artifact.value))
        throw new Error("Monitoring receipt integrity/provenance mismatch.");
      receipts.push({ ...expected, digest: artifact.digest });
    });
    return receipts;
  }

  async tick(id: string, workerId: string) {
    assertTenantScope(this.scope, "work");
    requirePlatformId(workerId);
    const { plan, digest } = this.readPlan(id);
    const previous = this.receipts(plan, digest);
    let processed = 0,
      last: SealedReceipt | null = null;
    for (let index = previous.length; index < plan.occurrences; index++) {
      const cycle = plan.cycles[index]!;
      if (Date.now() < cycle.dueAt)
        return {
          state: "waiting" as const,
          nextAt: cycle.dueAt,
          jobsProcessed: processed,
          receipt: last,
        };
      if (Date.now() < cycle.expiresAt && processed === 0) {
        const result = await runNextQueuedVerification(
          this.queue,
          this.scope,
          cycle.runId,
          workerId,
        );
        if (result) processed++;
      }
      const jobs = this.queue.listJobs(this.scope, cycle.runId);
      if (
        Date.now() < cycle.expiresAt &&
        jobs.some((job) => !["done", "failed"].includes(job.status))
      )
        return {
          state: "running" as const,
          nextAt: Math.min(
            cycle.expiresAt,
            ...jobs
              .filter((job) => !["done", "failed"].includes(job.status))
              .map((job) => job.leaseUntil ?? Math.max(Date.now(), job.availableAt)),
          ),
          jobsProcessed: processed,
          receipt: last,
        };
      const receipt = this.buildReceipt(plan, digest, index, Date.now(), previous);
      try {
        this.queue.putArtifact(this.scope, receiptId(id, index), receipt);
      } catch (error) {
        if (!this.queue.getArtifact(this.scope, receiptId(id, index))) throw error;
      }
      last = this.receipts(plan, digest)[index]!;
      previous.push(last);
    }
    return { state: "finished" as const, nextAt: null, jobsProcessed: processed, receipt: last };
  }

  export(id: string) {
    const { plan, digest } = this.readPlan(id),
      receipts = this.receipts(plan, digest);
    const content = {
      schema: "backlink-monitor.export.v1" as const,
      plan,
      planDigest: digest,
      receipts,
      alerts: receipts.flatMap((receipt) =>
        receipt.alerts.map((alert) => ({ occurrence: receipt.occurrence, ...alert })),
      ),
      scheduleComplete: receipts.length === plan.occurrences,
      nextDueAt: plan.cycles[receipts.length]?.dueAt ?? null,
      localOnly: true as const,
      currentJobs: plan.cycles.flatMap((cycle) =>
        this.queue.listJobs(this.scope, cycle.runId).map((job) => ({
          id: job.id,
          runId: job.runId,
          status: job.status,
          attempt: job.attempt,
          error: job.error,
          availableAt: job.availableAt,
          leaseUntil: job.leaseUntil,
        })),
      ),
      limitation:
        "Finite local same-machine monitoring; HTML observations and relationship changes do not establish rendered absence, publication dates, indexing or ranking effects.",
    };
    return { ...content, rootDigest: hash(content) };
  }
}
