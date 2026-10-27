import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { closeSync, openSync } from "node:fs";
import { assertTenantScope, requirePlatformId, type TenantScope } from "./tenant-scope.ts";
import { assertScanQueueRuntime } from "./scan-queue-runtime.ts";
import type { BacklinkObservation } from "./verify-api.server.ts";
import { RemediationStore, type RemediationRecord } from "./remediation.server.ts";

assertScanQueueRuntime();
const { DatabaseSync } = await import("node:sqlite").catch((cause: unknown) => {
  throw new Error("Optional platform queue requires a Node build with node:sqlite enabled.", {
    cause,
  });
});

export type ScanQueuePolicy = {
  maxRequests: number;
  maxRequestsPerHost: number;
  maxConcurrentPerHost: number;
  minHostIntervalMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  leaseMs: number;
};

export type ScanJob = {
  id: string;
  runId: string;
  url: string;
  payload: unknown;
  status: "queued" | "leased" | "done" | "failed";
  attempt: number;
  availableAt: number;
  leaseUntil: number | null;
  workerId: string | null;
  error: string | null;
  result: unknown;
};

export type ScanLease = ScanJob & { token: string; status: "leased"; leaseUntil: number };
type Row = Record<string, string | number | null>;

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > 1_048_576) {
    throw new Error("Platform payload must be JSON and at most 1 MiB.");
  }
  return encoded;
}

function positive(value: number, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error("Expected a bounded non-negative integer.");
  }
}

function target(raw: string): URL {
  const url = new URL(raw);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Job URL must be HTTP(S) without credentials.");
  }
  return url;
}

function job(row: Row): ScanJob {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    url: String(row.url),
    payload: JSON.parse(String(row.payload)),
    status: row.status as ScanJob["status"],
    attempt: Number(row.attempt),
    availableAt: Number(row.available_at),
    leaseUntil: row.lease_until === null ? null : Number(row.lease_until),
    workerId: row.worker_id as string | null,
    error: row.error as string | null,
    result: row.result === null ? null : JSON.parse(String(row.result)),
  };
}

/** Same-machine workers share one SQLite file; no network filesystem/distributed claim. */
export class ScanQueue {
  private readonly db: SqliteDatabase;
  private readonly now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.now = now;
    if (path !== ":memory:") {
      try {
        closeSync(openSync(path, "wx", 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS platform_runs (
        tenant TEXT NOT NULL, project TEXT NOT NULL, id TEXT NOT NULL,
        policy TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant, project, id)
      );
      CREATE TABLE IF NOT EXISTS platform_jobs (
        tenant TEXT NOT NULL, project TEXT NOT NULL, run_id TEXT NOT NULL,
        id TEXT NOT NULL, dedupe_key TEXT NOT NULL, url TEXT NOT NULL, host TEXT NOT NULL,
        payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        attempt INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
        lease_until INTEGER, attempt_started_at INTEGER, worker_id TEXT, token TEXT, error TEXT, result TEXT,
        PRIMARY KEY (tenant, project, id),
        UNIQUE (tenant, project, run_id, dedupe_key),
        FOREIGN KEY (tenant, project, run_id) REFERENCES platform_runs(tenant, project, id)
      );
      CREATE INDEX IF NOT EXISTS platform_jobs_due
        ON platform_jobs(tenant, project, run_id, status, available_at);
      CREATE INDEX IF NOT EXISTS platform_jobs_host ON platform_jobs(host, status, lease_until);
      CREATE TABLE IF NOT EXISTS platform_host_budget (
        tenant TEXT NOT NULL, project TEXT NOT NULL, run_id TEXT NOT NULL,
        host TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant, project, run_id, host)
      );
      CREATE TABLE IF NOT EXISTS platform_host_clock (
        host TEXT PRIMARY KEY, last_request_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS platform_artifacts (
        tenant TEXT NOT NULL, project TEXT NOT NULL, id TEXT NOT NULL,
        body TEXT NOT NULL, digest TEXT NOT NULL, origin TEXT NOT NULL,
        PRIMARY KEY (tenant, project, id)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private clock(): number {
    const at = this.now();
    positive(at, true);
    return at;
  }

  private policy(scope: TenantScope, runId: string): ScanQueuePolicy {
    requirePlatformId(runId);
    const row = this.db
      .prepare("SELECT policy FROM platform_runs WHERE tenant=? AND project=? AND id=?")
      .get(scope.tenantId, scope.projectId, runId);
    if (!row) throw new Error("Run unavailable.");
    return JSON.parse(String(row.policy));
  }

  createRun(scope: TenantScope, runId: string, policy: ScanQueuePolicy): void {
    assertTenantScope(scope, "manage");
    requirePlatformId(runId);
    for (const key of [
      "maxRequests",
      "maxRequestsPerHost",
      "maxConcurrentPerHost",
      "maxAttempts",
      "leaseMs",
    ] as const) {
      positive(policy[key]);
    }
    positive(policy.minHostIntervalMs, true);
    positive(policy.retryBaseMs, true);
    if (
      policy.maxAttempts > 100 ||
      policy.leaseMs > 86_400_000 ||
      policy.retryBaseMs > 86_400_000
    ) {
      throw new Error("Queue policy exceeds limits.");
    }
    this.transaction(() => {
      const previous = this.db
        .prepare("SELECT policy FROM platform_runs WHERE tenant=? AND project=? AND id=?")
        .get(scope.tenantId, scope.projectId, runId);
      const encoded = json(policy);
      if (previous && previous.policy !== encoded) throw new Error("Run policy is immutable.");
      this.db
        .prepare("INSERT OR IGNORE INTO platform_runs(tenant,project,id,policy) VALUES(?,?,?,?)")
        .run(scope.tenantId, scope.projectId, runId, encoded);
    });
  }

  enqueue(
    scope: TenantScope,
    input: {
      runId: string;
      dedupeKey: string;
      url: string;
      payload?: unknown;
      availableAt?: number;
    },
  ): ScanJob {
    assertTenantScope(scope, "manage");
    requirePlatformId(input.dedupeKey);
    const url = target(input.url);
    const availableAt = input.availableAt ?? this.clock();
    positive(availableAt, true);
    const payload = json(input.payload ?? null);
    return this.transaction(() => {
      this.policy(scope, input.runId);
      const existing = this.db
        .prepare(
          `SELECT * FROM platform_jobs
        WHERE tenant=? AND project=? AND run_id=? AND dedupe_key=?`,
        )
        .get(scope.tenantId, scope.projectId, input.runId, input.dedupeKey) as Row | undefined;
      if (existing) {
        if (existing.url !== url.href || existing.payload !== payload)
          throw new Error("Dedupe key conflicts with job.");
        return job(existing);
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO platform_jobs(tenant,project,run_id,id,dedupe_key,url,host,payload,available_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          scope.tenantId,
          scope.projectId,
          input.runId,
          id,
          input.dedupeKey,
          url.href,
          url.hostname,
          payload,
          availableAt,
        );
      return this.getJob(scope, id)!;
    });
  }

  getJob(scope: TenantScope, id: string): ScanJob | null {
    assertTenantScope(scope);
    requirePlatformId(id);
    const row = this.db
      .prepare("SELECT * FROM platform_jobs WHERE tenant=? AND project=? AND id=?")
      .get(scope.tenantId, scope.projectId, id) as Row | undefined;
    return row ? job(row) : null;
  }

  listJobs(scope: TenantScope, runId: string): ScanJob[] {
    assertTenantScope(scope);
    this.policy(scope, runId);
    return (
      this.db
        .prepare(
          `SELECT * FROM platform_jobs WHERE tenant=? AND project=? AND run_id=?
      ORDER BY available_at,id LIMIT 1000`,
        )
        .all(scope.tenantId, scope.projectId, runId) as Row[]
    ).map(job);
  }

  claim(scope: TenantScope, runId: string, workerId: string): ScanLease | null {
    assertTenantScope(scope, "work");
    requirePlatformId(workerId);
    return this.transaction(() => {
      const policy = this.policy(scope, runId);
      const now = this.clock();
      this.db
        .prepare(
          `UPDATE platform_jobs SET status='failed',token=NULL,worker_id=NULL,lease_until=NULL,
        error='Attempts exhausted after lease expiry' WHERE tenant=? AND project=? AND run_id=?
        AND status='leased' AND lease_until<=? AND attempt>=?`,
        )
        .run(scope.tenantId, scope.projectId, runId, now, policy.maxAttempts);
      const row = this.db
        .prepare(
          `SELECT j.* FROM platform_jobs j
        WHERE j.tenant=? AND j.project=? AND j.run_id=? AND j.available_at<=? AND j.attempt<?
        AND (j.status='queued' OR (j.status='leased' AND j.lease_until<=?))
        AND (SELECT COUNT(*) FROM platform_jobs active WHERE active.host=j.host
          AND active.status='leased' AND active.lease_until>?) < ?
        ORDER BY j.available_at,j.id LIMIT 1`,
        )
        .get(
          scope.tenantId,
          scope.projectId,
          runId,
          now,
          policy.maxAttempts,
          now,
          now,
          policy.maxConcurrentPerHost,
        ) as Row | undefined;
      if (!row) return null;
      const token = randomUUID();
      this.db
        .prepare(
          `UPDATE platform_jobs SET status='leased',attempt=attempt+1,token=?,worker_id=?,lease_until=?,attempt_started_at=?
        WHERE tenant=? AND project=? AND id=?`,
        )
        .run(
          token,
          workerId,
          now + policy.leaseMs,
          now,
          scope.tenantId,
          scope.projectId,
          String(row.id),
        );
      return { ...this.getJob(scope, String(row.id))!, token } as ScanLease;
    });
  }

  private activeLease(scope: TenantScope, lease: ScanLease): Row {
    assertTenantScope(scope, "work");
    const row = this.db
      .prepare(
        `SELECT * FROM platform_jobs WHERE tenant=? AND project=? AND id=?
      AND status='leased' AND token=? AND attempt=? AND worker_id=? AND lease_until>?`,
      )
      .get(
        scope.tenantId,
        scope.projectId,
        lease.id,
        lease.token,
        lease.attempt,
        lease.workerId,
        this.clock(),
      ) as Row | undefined;
    if (!row) throw new Error("Lease unavailable or stale.");
    return row;
  }

  heartbeat(scope: TenantScope, lease: ScanLease): ScanLease {
    return this.transaction(() => {
      const row = this.activeLease(scope, lease);
      const until = this.clock() + this.policy(scope, String(row.run_id)).leaseMs;
      this.db
        .prepare("UPDATE platform_jobs SET lease_until=? WHERE tenant=? AND project=? AND id=?")
        .run(until, scope.tenantId, scope.projectId, lease.id);
      return { ...this.getJob(scope, lease.id)!, token: lease.token } as ScanLease;
    });
  }

  /** Reserve before each outbound attempt, including robots/redirects/retries; never refunded. */
  reserveRequest(
    scope: TenantScope,
    lease: ScanLease,
    rawUrl: string,
  ): { requests: number; hostRequests: number } {
    const url = target(rawUrl);
    return this.transaction(() => {
      const row = this.activeLease(scope, lease);
      if (url.hostname !== row.host) throw new Error("Request host differs from leased job.");
      const runId = String(row.run_id);
      const policy = this.policy(scope, runId);
      const run = this.db
        .prepare("SELECT requests FROM platform_runs WHERE tenant=? AND project=? AND id=?")
        .get(scope.tenantId, scope.projectId, runId)!;
      const host = this.db
        .prepare(
          `SELECT requests FROM platform_host_budget
        WHERE tenant=? AND project=? AND run_id=? AND host=?`,
        )
        .get(scope.tenantId, scope.projectId, runId, url.hostname);
      const requests = Number(run.requests);
      const hostRequests = Number(host?.requests ?? 0);
      if (requests >= policy.maxRequests || hostRequests >= policy.maxRequestsPerHost) {
        throw new Error("Request budget exhausted.");
      }
      const now = this.clock();
      const clock = this.db
        .prepare("SELECT last_request_at FROM platform_host_clock WHERE host=?")
        .get(url.hostname);
      if (clock && now - Number(clock.last_request_at) < policy.minHostIntervalMs) {
        throw new Error("Host request cooldown.");
      }
      this.db
        .prepare(
          "UPDATE platform_runs SET requests=requests+1 WHERE tenant=? AND project=? AND id=?",
        )
        .run(scope.tenantId, scope.projectId, runId);
      this.db
        .prepare(
          `INSERT INTO platform_host_budget(tenant,project,run_id,host,requests) VALUES(?,?,?,?,1)
        ON CONFLICT(tenant,project,run_id,host) DO UPDATE SET requests=requests+1`,
        )
        .run(scope.tenantId, scope.projectId, runId, url.hostname);
      this.db
        .prepare(
          `INSERT INTO platform_host_clock(host,last_request_at) VALUES(?,?)
        ON CONFLICT(host) DO UPDATE SET last_request_at=excluded.last_request_at`,
        )
        .run(url.hostname, now);
      return { requests: requests + 1, hostRequests: hostRequests + 1 };
    });
  }

  complete(scope: TenantScope, lease: ScanLease, result: unknown): void {
    const body = json(result);
    this.transaction(() => {
      this.activeLease(scope, lease);
      this.db
        .prepare(
          `UPDATE platform_jobs SET status='done',result=?,error=NULL,token=NULL,worker_id=NULL,lease_until=NULL
        WHERE tenant=? AND project=? AND id=?`,
        )
        .run(body, scope.tenantId, scope.projectId, lease.id);
    });
  }

  fail(scope: TenantScope, lease: ScanLease, error: string, retryable = true): void {
    if (typeof error !== "string" || error.length > 2000) throw new Error("Invalid job error.");
    this.transaction(() => {
      const row = this.activeLease(scope, lease);
      const policy = this.policy(scope, String(row.run_id));
      const retry = retryable && Number(row.attempt) < policy.maxAttempts;
      const delay = Math.min(
        86_400_000,
        policy.retryBaseMs * 2 ** Math.min(30, Number(row.attempt) - 1),
      );
      this.db
        .prepare(
          `UPDATE platform_jobs SET status=?,available_at=?,error=?,token=NULL,worker_id=NULL,lease_until=NULL
        WHERE tenant=? AND project=? AND id=?`,
        )
        .run(
          retry ? "queued" : "failed",
          this.clock() + (retry ? delay : 0),
          error,
          scope.tenantId,
          scope.projectId,
          lease.id,
        );
    });
  }

  usage(scope: TenantScope, runId: string): { requests: number; maxRequests: number } {
    assertTenantScope(scope);
    const policy = this.policy(scope, runId);
    const row = this.db
      .prepare("SELECT requests FROM platform_runs WHERE tenant=? AND project=? AND id=?")
      .get(scope.tenantId, scope.projectId, runId)!;
    return { requests: Number(row.requests), maxRequests: policy.maxRequests };
  }

  putArtifact(scope: TenantScope, id: string, value: unknown): string {
    assertTenantScope(
      scope,
      id.startsWith("remediation.") || id.startsWith("scan-grant.") ? "manage" : "work",
    );
    if (id.startsWith("verification."))
      throw new Error("Verification artifacts require a live verification worker lease.");
    if (id.startsWith("remediation."))
      throw new Error("Remediation namespace requires a validated workflow transition.");
    return this.transaction(() => this.writeArtifact(scope, id, value, "operator_artifact"));
  }

  recordRemediation(scope: TenantScope, record: RemediationRecord): string {
    assertTenantScope(scope, "manage");
    return this.transaction(() => {
      new RemediationStore(this, () => this.clock()).validateRecord(scope, record);
      if (record.recordedBy !== scope.subject)
        throw new Error("Remediation writer differs from authenticated operator.");
      const prefix = `remediation.${createHash("sha256").update(record.id).digest("hex")}.v.`;
      const previous = this.latestArtifact(scope, prefix);
      if (!previous) {
        if (
          record.version !== 0 ||
          record.previousDigest !== null ||
          record.status !== "detected"
        ) {
          throw new Error("Remediation must start with a detected finding.");
        }
      } else {
        if (previous.origin !== "remediation-store.v1")
          throw new Error("Invalid remediation predecessor origin.");
        const before = previous.value as RemediationRecord;
        new RemediationStore(this, () => this.clock()).validateRecord(scope, before);
        const allowed: Record<string, string[]> = {
          detected: ["task_created"],
          task_created: ["approved"],
          approved: ["deployed"],
          deployed: ["verified", "still_present", "inconclusive"],
          still_present: ["verified", "still_present", "inconclusive"],
          inconclusive: ["verified", "still_present", "inconclusive"],
          verified: [],
        };
        if (
          record.version !== before.version + 1 ||
          record.previousDigest !== previous.digest ||
          !allowed[before.status]?.includes(record.status) ||
          record.findingId !== before.findingId ||
          JSON.stringify(record.baseline) !== JSON.stringify(before.baseline) ||
          ["task", "grant", "deployment"].some(
            (key) =>
              before[key as keyof RemediationRecord] !== undefined &&
              JSON.stringify(record[key as keyof RemediationRecord]) !==
                JSON.stringify(before[key as keyof RemediationRecord]),
          )
        ) {
          throw new Error("Invalid or concurrent remediation transition.");
        }
      }
      return this.writeArtifact(
        scope,
        `${prefix}${String(record.version).padStart(8, "0")}`,
        record,
        "remediation-store.v1",
      );
    });
  }

  private writeArtifact(scope: TenantScope, id: string, value: unknown, origin: string): string {
    requirePlatformId(id);
    const body = json(value);
    const digest = createHash("sha256").update(body).digest("hex");
    const previous = this.db
      .prepare("SELECT digest FROM platform_artifacts WHERE tenant=? AND project=? AND id=?")
      .get(scope.tenantId, scope.projectId, id);
    if (previous && previous.digest !== digest) throw new Error("Artifact is immutable.");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO platform_artifacts(tenant,project,id,body,digest,origin) VALUES(?,?,?,?,?,?)",
      )
      .run(scope.tenantId, scope.projectId, id, body, digest, origin);
    return digest;
  }

  /** Trusted worker only: do not expose as a raw write endpoint to remote clients. */
  recordVerification(
    scope: TenantScope,
    lease: ScanLease,
    observation: BacklinkObservation,
  ): string {
    return this.transaction(() => {
      const row = this.activeLease(scope, lease);
      const payload = JSON.parse(String(row.payload)) as {
        kind?: string;
        grantArtifactId?: string;
      };
      if (
        payload.kind !== "verify_backlinks.v1" ||
        !payload.grantArtifactId?.startsWith("scan-grant.")
      ) {
        throw new Error("Job has no verification grant.");
      }
      const artifact = this.getArtifact(scope, payload.grantArtifactId);
      const grant = artifact?.value as
        | {
            kind?: string;
            tenantId?: string;
            projectId?: string;
            runId?: string;
            expiresAt?: number;
            pair?: { source_url: string; target_url: string };
          }
        | undefined;
      const checkedAt = Date.parse(observation.checked_at);
      if (
        !grant ||
        grant.kind !== "scan-verification-grant.v1" ||
        grant.tenantId !== scope.tenantId ||
        grant.projectId !== scope.projectId ||
        grant.runId !== row.run_id ||
        !Number.isSafeInteger(grant.expiresAt) ||
        grant.expiresAt! <= this.clock() ||
        grant.pair?.source_url !== observation.source_url ||
        grant.pair?.target_url !== observation.target_url ||
        !["confirmed", "not_found", "error"].includes(observation.status) ||
        !Number.isFinite(checkedAt) ||
        checkedAt < Number(row.attempt_started_at) ||
        checkedAt > this.clock()
      ) {
        throw new Error("Observation is not fresh and bound to the granted verification.");
      }
      const id = `verification.${lease.id}.${lease.attempt}`;
      this.writeArtifact(
        scope,
        id,
        {
          schema: "queue-verification.v1",
          observation,
          jobId: lease.id,
          attempt: lease.attempt,
          grantDigest: artifact!.digest,
        },
        "queue-worker.v1",
      );
      return id;
    });
  }

  getArtifact(
    scope: TenantScope,
    id: string,
  ): { value: unknown; digest: string; origin: string } | null {
    assertTenantScope(scope);
    requirePlatformId(id);
    const row = this.db
      .prepare(
        "SELECT body,digest,origin FROM platform_artifacts WHERE tenant=? AND project=? AND id=?",
      )
      .get(scope.tenantId, scope.projectId, id);
    if (!row) return null;
    const digest = createHash("sha256").update(String(row.body)).digest("hex");
    if (digest !== row.digest) throw new Error("Artifact integrity failure.");
    return { value: JSON.parse(String(row.body)), digest, origin: String(row.origin) };
  }

  latestArtifact(
    scope: TenantScope,
    prefix: string,
  ): { value: unknown; digest: string; origin: string } | null {
    assertTenantScope(scope);
    requirePlatformId(prefix);
    const row = this.db
      .prepare(
        `SELECT id FROM platform_artifacts WHERE tenant=? AND project=?
      AND substr(id,1,?)=? ORDER BY id DESC LIMIT 1`,
      )
      .get(scope.tenantId, scope.projectId, prefix.length, prefix);
    return row ? this.getArtifact(scope, String(row.id)) : null;
  }

  listArtifacts(
    scope: TenantScope,
    prefix: string,
    limit = 1000,
  ): {
    artifacts: { value: unknown; digest: string }[];
    total: number;
    truncated: boolean;
  } {
    assertTenantScope(scope);
    requirePlatformId(prefix);
    positive(limit);
    if (limit > 5000) throw new Error("Artifact list limit exceeds 5000.");
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id FROM platform_artifacts WHERE tenant=? AND project=?
        AND substr(id,1,?)=? ORDER BY id LIMIT ?`,
        )
        .all(scope.tenantId, scope.projectId, prefix.length, prefix, limit);
      const count = this.db
        .prepare(
          `SELECT COUNT(*) AS total FROM platform_artifacts WHERE tenant=? AND project=?
        AND substr(id,1,?)=?`,
        )
        .get(scope.tenantId, scope.projectId, prefix.length, prefix)!;
      return {
        artifacts: rows.map((row) => this.getArtifact(scope, String(row.id))!),
        total: Number(count.total),
        truncated: Number(count.total) > rows.length,
      };
    });
  }
}
