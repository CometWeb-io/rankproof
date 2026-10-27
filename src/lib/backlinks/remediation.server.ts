import { assertTenantScope, requirePlatformId, type TenantScope } from "./tenant-scope.ts";
import type { ScanQueue } from "./scan-queue.server.ts";
import { createHash } from "node:crypto";
import type { BacklinkObservation } from "./verify-api.server.ts";

type MeasuredEvidence = { artifactId: string; digest: string; observation: BacklinkObservation };

export type RemediationRecord = {
  schema: "remediation.v1";
  id: string;
  version: number;
  tenantId: string;
  projectId: string;
  status:
    | "detected"
    | "task_created"
    | "approved"
    | "deployed"
    | "verified"
    | "still_present"
    | "inconclusive";
  findingId: string;
  baseline: MeasuredEvidence;
  task?: { title: string; reference: string; patchDigest: string };
  grant?: { operator: string; expiresAt: number; patchDigest: string; grantedAt: number };
  deployment?: { reference: string; patchDigest: string; deployedAt: number };
  remeasurement?: MeasuredEvidence;
  previousDigest: string | null;
  recordedBy: string;
  recordedAt: number;
};

function digest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Expected SHA-256 digest.");
}

function reference(value: string): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 2000 ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32)
  ) {
    throw new Error("Expected a bounded task/deployment reference.");
  }
}

/** Append-only local workflow. This records operator actions; it never edits a site or opens a PR. */
export class RemediationStore {
  private readonly queue: ScanQueue;
  private readonly now: () => number;

  constructor(queue: ScanQueue, now: () => number = Date.now) {
    this.queue = queue;
    this.now = now;
  }

  private prefix(id: string): string {
    requirePlatformId(id);
    if (id.length > 64) throw new Error("Remediation id exceeds 64 characters.");
    return `remediation.${createHash("sha256").update(id).digest("hex")}.v.`;
  }

  private observation(scope: TenantScope, artifactId: string) {
    const artifact = this.queue.getArtifact(scope, artifactId);
    if (!artifact || artifact.origin !== "queue-worker.v1")
      throw new Error("Remediation requires trusted worker evidence.");
    const envelope = artifact.value as {
      schema?: string;
      observation?: BacklinkObservation;
      jobId?: string;
      attempt?: number;
      grantDigest?: string;
    };
    const observation = envelope.observation;
    const measuredJob = envelope.jobId ? this.queue.getJob(scope, envelope.jobId) : null;
    const result = measuredJob?.result as { artifactId?: string; grantDigest?: string } | null;
    if (
      envelope.schema !== "queue-verification.v1" ||
      measuredJob?.status !== "done" ||
      measuredJob.attempt !== envelope.attempt ||
      result?.artifactId !== artifactId ||
      result.grantDigest !== envelope.grantDigest ||
      !observation ||
      !["confirmed", "not_found", "error"].includes(observation.status) ||
      !Number.isFinite(Date.parse(observation.checked_at)) ||
      Date.parse(observation.checked_at) > this.now()
    ) {
      throw new Error("Invalid remediation observation.");
    }
    return { artifactId, digest: artifact.digest, observation };
  }

  get(scope: TenantScope, id: string): RemediationRecord | null {
    const artifact = this.queue.latestArtifact(scope, this.prefix(id));
    if (!artifact) return null;
    if (artifact.origin !== "remediation-store.v1")
      throw new Error("Invalid remediation record origin.");
    const record = artifact.value as RemediationRecord;
    this.validateRecord(scope, record);
    if (record.id !== id) throw new Error("Invalid remediation record identity.");
    return record;
  }

  /** Revalidate persisted state; hashes alone do not establish a valid workflow or measurement. */
  validateRecord(scope: TenantScope, record: RemediationRecord): void {
    assertTenantScope(scope);
    try {
      if (
        !record ||
        record.schema !== "remediation.v1" ||
        record.tenantId !== scope.tenantId ||
        record.projectId !== scope.projectId ||
        !Number.isSafeInteger(record.version) ||
        record.version < 0 ||
        record.version > 99_999_999 ||
        !Number.isSafeInteger(record.recordedAt) ||
        record.recordedAt < 0 ||
        record.recordedAt > this.now()
      )
        throw new Error("Invalid identity or version.");
      this.prefix(record.id);
      requirePlatformId(record.findingId);
      requirePlatformId(record.recordedBy);
      const states = [
        "detected",
        "task_created",
        "approved",
        "deployed",
        "verified",
        "still_present",
        "inconclusive",
      ];
      const stage = states.indexOf(record.status);
      if (stage < 0 || record.version < Math.min(stage, 4)) throw new Error("Invalid state.");
      if (record.version === 0) {
        if (record.previousDigest !== null || record.status !== "detected")
          throw new Error("Invalid initial state.");
      } else digest(record.previousDigest!);
      const baseline = this.observation(scope, record.baseline.artifactId);
      if (
        baseline.digest !== record.baseline.digest ||
        JSON.stringify(baseline.observation) !== JSON.stringify(record.baseline.observation) ||
        baseline.observation.status !== "confirmed" ||
        baseline.observation.evidence_kind !== "html_anchor" ||
        !this.completeHtml(baseline.observation) ||
        Date.parse(baseline.observation.checked_at) > record.recordedAt
      ) {
        throw new Error("Invalid baseline.");
      }
      if (stage === 0) {
        if (record.task || record.grant || record.deployment || record.remeasurement)
          throw new Error("Unexpected later state.");
        return;
      }
      if (!record.task) throw new Error("Task missing.");
      reference(record.task.title);
      reference(record.task.reference);
      digest(record.task.patchDigest);
      if (stage === 1) {
        if (record.grant || record.deployment || record.remeasurement)
          throw new Error("Unexpected approval.");
        return;
      }
      const grant = record.grant;
      if (
        !grant ||
        grant.patchDigest !== record.task.patchDigest ||
        !Number.isSafeInteger(grant.grantedAt) ||
        !Number.isSafeInteger(grant.expiresAt) ||
        grant.grantedAt < 0 ||
        grant.expiresAt <= grant.grantedAt ||
        grant.grantedAt > record.recordedAt
      )
        throw new Error("Invalid approval.");
      requirePlatformId(grant.operator);
      if (stage === 2) {
        if (record.deployment || record.remeasurement) throw new Error("Unexpected deployment.");
        return;
      }
      const deployment = record.deployment;
      if (
        !deployment ||
        deployment.patchDigest !== grant.patchDigest ||
        !Number.isSafeInteger(deployment.deployedAt) ||
        deployment.deployedAt < grant.grantedAt ||
        deployment.deployedAt >= grant.expiresAt ||
        deployment.deployedAt > record.recordedAt
      )
        throw new Error("Invalid deployment.");
      reference(deployment.reference);
      if (stage === 3) {
        if (record.remeasurement) throw new Error("Unexpected remeasurement.");
        return;
      }
      if (!record.remeasurement) throw new Error("Remeasurement missing.");
      const measured = this.observation(scope, record.remeasurement.artifactId);
      const after = measured.observation;
      const before = baseline.observation;
      const at = Date.parse(after.checked_at);
      if (
        measured.digest !== record.remeasurement.digest ||
        JSON.stringify(after) !== JSON.stringify(record.remeasurement.observation) ||
        at < deployment.deployedAt ||
        at <= Date.parse(before.checked_at) ||
        at >= grant.expiresAt ||
        at > record.recordedAt ||
        after.source_url !== before.source_url ||
        after.target_url !== before.target_url ||
        after.observation_method !== before.observation_method ||
        after.extraction_version !== before.extraction_version ||
        after.identity_policy !== before.identity_policy ||
        after.source_revision !== before.source_revision
      ) {
        throw new Error("Invalid comparable evidence.");
      }
      const comparableHtml = this.completeHtml(after) && after.final_url === before.final_url;
      const measuredStatus =
        after.status === "not_found" &&
        comparableHtml &&
        after.absence_scope === "fetched_html" &&
        after.response_hash !== before.response_hash
          ? "verified"
          : after.status === "confirmed" && comparableHtml && after.evidence_kind === "html_anchor"
            ? "still_present"
            : "inconclusive";
      if (record.status !== measuredStatus)
        throw new Error("State disagrees with measured evidence.");
    } catch (cause) {
      throw new Error("Invalid remediation record.", { cause });
    }
  }

  create(
    scope: TenantScope,
    id: string,
    findingId: string,
    baselineArtifactId: string,
  ): RemediationRecord {
    assertTenantScope(scope, "manage");
    requirePlatformId(findingId);
    if (this.get(scope, id)) throw new Error("Remediation already exists.");
    const baseline = this.observation(scope, baselineArtifactId);
    if (
      baseline.observation.status !== "confirmed" ||
      baseline.observation.evidence_kind !== "html_anchor" ||
      !this.completeHtml(baseline.observation)
    )
      throw new Error("Baseline does not confirm a measured HTML link.");
    const record: RemediationRecord = {
      schema: "remediation.v1",
      id,
      version: 0,
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      status: "detected",
      findingId,
      baseline,
      previousDigest: null,
      recordedBy: scope.subject,
      recordedAt: this.now(),
    };
    this.queue.recordRemediation(scope, record);
    return record;
  }

  private change(
    scope: TenantScope,
    id: string,
    apply: (record: RemediationRecord) => void,
  ): RemediationRecord {
    assertTenantScope(scope, "manage");
    const previous = this.queue.latestArtifact(scope, this.prefix(id));
    if (!previous) throw new Error("Remediation unavailable.");
    if (previous.origin !== "remediation-store.v1")
      throw new Error("Invalid remediation record origin.");
    const record = previous.value as RemediationRecord;
    this.validateRecord(scope, record);
    if (record.id !== id) throw new Error("Invalid remediation record identity.");
    record.previousDigest = previous.digest;
    record.version += 1;
    if (record.version > 99_999_999) throw new Error("Remediation event limit reached.");
    record.recordedAt = this.now();
    record.recordedBy = scope.subject;
    apply(record);
    this.queue.recordRemediation(scope, record);
    return record;
  }

  createTask(
    scope: TenantScope,
    id: string,
    task: NonNullable<RemediationRecord["task"]>,
  ): RemediationRecord {
    reference(task.title);
    reference(task.reference);
    digest(task.patchDigest);
    return this.change(scope, id, (record) => {
      if (record.status !== "detected") throw new Error("Finding already has a task.");
      record.task = { ...task };
      record.status = "task_created";
    });
  }

  approve(
    scope: TenantScope,
    id: string,
    patchDigest: string,
    expiresAt: number,
  ): RemediationRecord {
    digest(patchDigest);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now())
      throw new Error("Grant must expire in the future.");
    return this.change(scope, id, (record) => {
      if (record.status !== "task_created" || record.task?.patchDigest !== patchDigest) {
        throw new Error("Grant must match the proposed patch.");
      }
      record.grant = {
        operator: scope.subject,
        expiresAt,
        patchDigest,
        grantedAt: record.recordedAt,
      };
      record.status = "approved";
    });
  }

  private requireGrant(record: RemediationRecord): void {
    if (
      !record.grant ||
      record.grant.expiresAt <= this.now() ||
      record.grant.patchDigest !== record.task?.patchDigest
    ) {
      throw new Error("Operator grant is unavailable or expired.");
    }
  }

  private completeHtml(observation: BacklinkObservation): boolean {
    return (
      observation.observation_method === "fetched_html" &&
      typeof observation.response_hash === "string" &&
      /^[a-f0-9]{64}$/.test(observation.response_hash) &&
      typeof observation.extraction_version === "string" &&
      observation.extraction_version.length > 0 &&
      typeof observation.identity_policy === "string" &&
      observation.identity_policy.length > 0 &&
      typeof observation.source_revision === "string" &&
      observation.source_revision.length > 0 &&
      typeof observation.final_url === "string" &&
      typeof observation.http_status === "number" &&
      observation.http_status >= 200 &&
      observation.http_status < 300
    );
  }

  recordDeployment(
    scope: TenantScope,
    id: string,
    deploymentReference: string,
    patchDigest: string,
  ): RemediationRecord {
    reference(deploymentReference);
    digest(patchDigest);
    return this.change(scope, id, (record) => {
      this.requireGrant(record);
      if (record.status !== "approved" || record.grant!.patchDigest !== patchDigest) {
        throw new Error("Deployment does not match the approved patch.");
      }
      record.deployment = {
        reference: deploymentReference,
        patchDigest,
        deployedAt: record.recordedAt,
      };
      record.status = "deployed";
    });
  }

  recordRemeasurement(scope: TenantScope, id: string, artifactId: string): RemediationRecord {
    return this.change(scope, id, (record) => {
      this.requireGrant(record);
      if (
        !record.deployment ||
        !["deployed", "still_present", "inconclusive"].includes(record.status)
      ) {
        throw new Error("Remeasurement requires a deployment reference.");
      }
      const remeasurement = this.observation(scope, artifactId);
      const after = remeasurement.observation;
      const before = record.baseline.observation;
      if (
        Date.parse(after.checked_at) < record.deployment.deployedAt ||
        Date.parse(after.checked_at) <= Date.parse(before.checked_at) ||
        after.source_url !== before.source_url ||
        after.target_url !== before.target_url ||
        after.observation_method !== before.observation_method ||
        after.extraction_version !== before.extraction_version ||
        after.identity_policy !== before.identity_policy ||
        after.source_revision !== before.source_revision ||
        remeasurement.digest === record.baseline.digest
      ) {
        throw new Error("Remeasurement is not a comparable observation after deployment.");
      }
      record.remeasurement = remeasurement;
      const comparableHtml = this.completeHtml(after) && after.final_url === before.final_url;
      if (
        after.status === "not_found" &&
        comparableHtml &&
        after.absence_scope === "fetched_html"
      ) {
        if (after.response_hash === before.response_hash)
          throw new Error("Replayed HTML cannot confirm link removal.");
        record.status = "verified";
      } else if (
        after.status === "confirmed" &&
        comparableHtml &&
        after.evidence_kind === "html_anchor"
      ) {
        record.status = "still_present";
      } else record.status = "inconclusive";
    });
  }
}
