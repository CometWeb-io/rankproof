/** Optional durable verifier history. Call save only with trusted verifier output, never imports. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { assertScanQueueRuntime } from "./scan-queue-runtime.ts";
import { assertTenantScope, type TenantScope } from "./tenant-scope.ts";
import { DURABLE_RETENTION, type ObservationReport } from "./agent-api-store.ts";
import type { AgentObservation } from "./agent-api.ts";
import {
  AGENT_OBSERVATION_SCHEMA,
  validateAgentSchema,
  validateObservationConsistency,
} from "./agent-api-contract.ts";

assertScanQueueRuntime();
const { DatabaseSync } = await import("node:sqlite");
const reportPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function privatePath(path: string, directory = false): void {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error(
      "History requires an owned private directory and file with owner-only permissions.",
    );
}

export function createPersistentObservationStore(path: string, scope: TenantScope) {
  assertTenantScope(scope);
  if (process.platform === "win32" || !isAbsolute(path))
    throw new Error(
      "Durable history requires an absolute path with qualified POSIX private permissions.",
    );
  privatePath(dirname(path), true);
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  privatePath(path);
  const db = new DatabaseSync(path);
  try {
    db.exec(`
    PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS agent_verification_reports (
      tenant TEXT NOT NULL, project TEXT NOT NULL, id TEXT NOT NULL,
      body TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(tenant,project,id)
    );
    CREATE TRIGGER IF NOT EXISTS agent_reports_no_update BEFORE UPDATE ON agent_verification_reports
      BEGIN SELECT RAISE(ABORT,'Verifier history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS agent_reports_no_delete BEFORE DELETE ON agent_verification_reports
      BEGIN SELECT RAISE(ABORT,'Verifier history is append-only'); END;
  `);
  } catch (error) {
    db.close();
    throw error;
  }
  const validateRows = (rows: AgentObservation[]) => {
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 50)
      throw new Error("Verifier report requires 1 to 50 observations.");
    for (const row of rows) {
      validateAgentSchema(row, AGENT_OBSERVATION_SCHEMA);
      validateObservationConsistency(row);
    }
  };
  const report = (id: string): ObservationReport => {
    assertTenantScope(scope);
    if (!reportPattern.test(id)) throw new Error("Invalid history report identifier.");
    const row = db
      .prepare(
        "SELECT body,digest FROM agent_verification_reports WHERE tenant=? AND project=? AND id=?",
      )
      .get(scope.tenantId, scope.projectId, id);
    if (!row) throw new Error("Report unavailable in this tenant/project history.");
    if (hash(String(row.body)) !== row.digest)
      throw new Error("Verifier history integrity failure.");
    const value = JSON.parse(String(row.body)) as ObservationReport;
    if (
      value.report_id !== id ||
      !Number.isFinite(Date.parse(value.created_at)) ||
      !Array.isArray(value.results)
    )
      throw new Error("Invalid verifier history report.");
    validateRows(value.results.map(({ observation_id: _id, ...observation }) => observation));
    if (value.results.some((observation, index) => observation.observation_id !== `${id}:${index}`))
      throw new Error("Invalid history observation identifier.");
    return value;
  };
  return {
    persistence: DURABLE_RETENTION,
    save(observations: AgentObservation[]): ObservationReport {
      assertTenantScope(scope, "work");
      validateRows(observations);
      const id = randomUUID();
      const value: ObservationReport = {
        report_id: id,
        created_at: new Date().toISOString(),
        results: observations.map((observation, index) => ({
          ...observation,
          observation_id: `${id}:${index}`,
        })),
      };
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body) > 1_048_576)
        throw new Error("Durable verifier report exceeds 1 MiB; use a smaller verification batch.");
      db.exec("BEGIN IMMEDIATE");
      try {
        const usage = db
          .prepare(
            "SELECT COUNT(*) AS reports,COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM agent_verification_reports WHERE tenant=? AND project=?",
          )
          .get(scope.tenantId, scope.projectId)!;
        if (
          Number(usage.reports) >= DURABLE_RETENTION.max_reports ||
          Number(usage.bytes) + Buffer.byteLength(body) > DURABLE_RETENTION.max_bytes
        )
          throw new Error(
            "Durable history capacity exhausted; export and rotate the operator-owned database.",
          );
        db.prepare(
          "INSERT INTO agent_verification_reports(tenant,project,id,body,digest) VALUES(?,?,?,?,?)",
        ).run(scope.tenantId, scope.projectId, id, body, hash(body));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return structuredClone(value);
    },
    report,
    observation(id: string) {
      const match = /^(.+):(\d{1,2})$/.exec(id);
      if (!match || !reportPattern.test(match[1]!))
        throw new Error("Invalid history observation identifier.");
      const stored = report(match[1]!);
      const observation = stored.results[Number(match[2])];
      if (!observation || observation.observation_id !== id)
        throw new Error("Observation unavailable in this history report.");
      return { report_id: stored.report_id, observation };
    },
    close() {
      db.close();
    },
  };
}
