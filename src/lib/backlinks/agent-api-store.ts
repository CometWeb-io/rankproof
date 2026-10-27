/** Bounded process memory; IDs are opaque, never caller-selected paths. */
import { randomUUID } from "node:crypto";
import type { AgentObservation } from "./agent-api.ts";

export const SESSION_RETENTION = {
  kind: "bounded_process_memory",
  max_reports: 50,
  max_bytes: 8_000_000,
  ttl_seconds: 3600,
} as const;
export const DURABLE_RETENTION = {
  kind: "bounded_sqlite",
  max_reports: 5000,
  max_bytes: 64_000_000,
  ttl_seconds: null,
} as const;
export type ObservationPersistence = typeof SESSION_RETENTION | typeof DURABLE_RETENTION;
export type StoredObservation = AgentObservation & { observation_id: string };
export type ObservationReport = {
  report_id: string;
  created_at: string;
  results: StoredObservation[];
};
export type ObservationStore = {
  persistence: ObservationPersistence;
  save(observations: AgentObservation[]): ObservationReport;
  report(id: string): ObservationReport;
  observation(id: string): { report_id: string; observation: StoredObservation };
};

export function createObservationStore() {
  const reports = new Map<string, { value: ObservationReport; bytes: number; expires: number }>();
  let total = 0;
  const remove = (id: string) => {
    const entry = reports.get(id);
    if (entry) {
      total -= entry.bytes;
      reports.delete(id);
    }
  };
  const prune = () => {
    for (const [id, entry] of reports) if (entry.expires <= Date.now()) remove(id);
  };
  return {
    persistence: SESSION_RETENTION,
    save(observations: AgentObservation[]): ObservationReport {
      prune();
      const report = {
        report_id: randomUUID(),
        created_at: new Date().toISOString(),
        results: observations.map((row) => ({ ...row, observation_id: randomUUID() })),
      };
      const bytes = Buffer.byteLength(JSON.stringify(report));
      if (bytes > SESSION_RETENTION.max_bytes)
        throw new Error("Observation report exceeds session storage limit.");
      while (
        reports.size >= SESSION_RETENTION.max_reports ||
        total + bytes > SESSION_RETENTION.max_bytes
      )
        remove(reports.keys().next().value!);
      reports.set(report.report_id, {
        value: report,
        bytes,
        expires: Date.now() + SESSION_RETENTION.ttl_seconds * 1000,
      });
      total += bytes;
      return structuredClone(report);
    },
    report(id: string): ObservationReport {
      prune();
      const report = reports.get(id);
      if (!report)
        throw new Error("Report unavailable: unknown, expired, evicted, or process restarted.");
      return structuredClone(report.value);
    },
    observation(id: string): { report_id: string; observation: StoredObservation } {
      prune();
      for (const report of reports.values()) {
        const observation = report.value.results.find((row) => row.observation_id === id);
        if (observation)
          return { report_id: report.value.report_id, observation: structuredClone(observation) };
      }
      throw new Error("Observation unavailable: unknown, expired, evicted, or process restarted.");
    },
  };
}
