import { createHash, randomUUID } from "node:crypto";
import { ScanQueue } from "./scan-queue.server.ts";
import { requirePlatformId, type TenantScope } from "./tenant-scope.ts";

export type PlatformSample = {
  measurementId: string;
  observedAt: number;
  source: string;
  durationMs: number;
  bytes: number | null;
  requests: number | null;
  outcome: "success" | "error" | "blocked";
  measurement: "complete" | "partial" | "unknown" | "blocked";
  costUsd: number | null;
  cpuUserMs: number | null;
  cpuSystemMs: number | null;
  rssBytes: number | null;
};

export type PlatformQualityGate = {
  expectedMeasurements: number;
  minCompleteRatio: number;
  maxP95Ms: number;
  maxKnownCostUsd: number;
  requireKnownCosts: boolean;
};

function validateSample(sample: PlatformSample): void {
  requirePlatformId(sample.source);
  requirePlatformId(sample.measurementId);
  if (!Number.isSafeInteger(sample.observedAt) || sample.observedAt < 0)
    throw new Error("Invalid telemetry timestamp.");
  if (
    !["success", "error", "blocked"].includes(sample.outcome) ||
    !["complete", "partial", "unknown", "blocked"].includes(sample.measurement)
  ) {
    throw new Error("Invalid telemetry outcome.");
  }
  for (const field of [
    "durationMs",
    "bytes",
    "requests",
    "costUsd",
    "cpuUserMs",
    "cpuSystemMs",
    "rssBytes",
  ] as const) {
    const value = sample[field];
    if (value === null && field !== "durationMs") continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      throw new Error("Invalid telemetry metric.");
    if (["bytes", "requests", "rssBytes"].includes(field) && !Number.isSafeInteger(value)) {
      throw new Error("Telemetry counts must be safe integers.");
    }
  }
  if (sample.outcome !== "success" && sample.measurement === "complete") {
    throw new Error("Failed execution cannot be a complete measurement.");
  }
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
}

function known(
  samples: PlatformSample[],
  field: "bytes" | "requests" | "costUsd" | "cpuUserMs" | "cpuSystemMs",
) {
  return {
    knownTotal: samples.reduce((sum, sample) => sum + (sample[field] ?? 0), 0),
    unknownSamples: samples.filter((sample) => sample[field] === null).length,
  };
}

/** Nearest-rank percentiles; an unknown cost is never converted into a free source. */
export function summarizePlatformTelemetry(samples: PlatformSample[], gate: PlatformQualityGate) {
  samples.forEach(validateSample);
  if (
    !Number.isSafeInteger(gate.expectedMeasurements) ||
    gate.expectedMeasurements < 1 ||
    !Number.isFinite(gate.minCompleteRatio) ||
    gate.minCompleteRatio < 0 ||
    gate.minCompleteRatio > 1 ||
    !Number.isFinite(gate.maxP95Ms) ||
    gate.maxP95Ms < 0 ||
    !Number.isFinite(gate.maxKnownCostUsd) ||
    gate.maxKnownCostUsd < 0 ||
    typeof gate.requireKnownCosts !== "boolean"
  )
    throw new Error("Invalid telemetry gate.");
  const p50 = percentile(
    samples.map((sample) => sample.durationMs),
    0.5,
  );
  const p95 = percentile(
    samples.map((sample) => sample.durationMs),
    0.95,
  );
  const latest = new Map<string, PlatformSample>();
  for (const sample of samples) {
    const previous = latest.get(sample.measurementId);
    if (!previous || previous.observedAt < sample.observedAt)
      latest.set(sample.measurementId, sample);
    else if (
      previous.observedAt === sample.observedAt &&
      previous.measurement !== sample.measurement
    ) {
      throw new Error("Ambiguous measurement telemetry timestamp.");
    }
  }
  const measurements = [...latest.values()];
  const complete = measurements.filter((sample) => sample.measurement === "complete").length;
  const completeRatio = Math.min(1, complete / gate.expectedMeasurements);
  const cost = known(samples, "costUsd");
  const sourceErrors: Record<string, number> = Object.create(null);
  for (const sample of samples) {
    if (sample.outcome === "error")
      sourceErrors[sample.source] = (sourceErrors[sample.source] ?? 0) + 1;
  }
  const reasons: string[] = [];
  if (measurements.length > gate.expectedMeasurements) reasons.push("unexpected_measurement_units");
  if (completeRatio < gate.minCompleteRatio) reasons.push("insufficient_measurement_coverage");
  if (p95 === null || p95 > gate.maxP95Ms) reasons.push("latency_slo_unmet");
  if (cost.knownTotal > gate.maxKnownCostUsd) reasons.push("known_cost_budget_exceeded");
  if (gate.requireKnownCosts && cost.unknownSamples > 0) reasons.push("unknown_source_cost");
  const rss = samples.flatMap((sample) => (sample.rssBytes === null ? [] : [sample.rssBytes]));
  return {
    schema: "platform-telemetry.v1" as const,
    samples: samples.length,
    latencyMs: { p50, p95, method: "nearest_rank" },
    execution: {
      successful: samples.filter((sample) => sample.outcome === "success").length,
      errors: samples.filter((sample) => sample.outcome === "error").length,
      blocked: samples.filter((sample) => sample.outcome === "blocked").length,
      sourceErrors,
    },
    measurement: {
      complete,
      expected: gate.expectedMeasurements,
      completeRatio,
      partial: measurements.filter((sample) => sample.measurement === "partial").length,
      unknown: measurements.filter((sample) => sample.measurement === "unknown").length,
      blocked: measurements.filter((sample) => sample.measurement === "blocked").length,
    },
    bytes: known(samples, "bytes"),
    requests: known(samples, "requests"),
    costUsd: cost,
    cpuUserMs: known(samples, "cpuUserMs"),
    cpuSystemMs: known(samples, "cpuSystemMs"),
    maxObservedRssBytes: rss.length ? Math.max(...rss) : null,
    rssUnknownSamples: samples.filter((sample) => sample.rssBytes === null).length,
    qualityGate: { pass: reasons.length === 0, reasons },
    budgetAction: reasons.includes("known_cost_budget_exceeded")
      ? "stop_new_work"
      : reasons.includes("unknown_source_cost")
        ? "require_cost_configuration"
        : "within_known_cost_budget",
  };
}

export class PlatformTelemetry {
  private readonly queue: ScanQueue;
  constructor(queue: ScanQueue) {
    this.queue = queue;
  }

  record(scope: TenantScope, runId: string, sample: PlatformSample): string {
    this.queue.usage(scope, runId);
    validateSample(sample);
    const id = `${this.prefix(runId)}${randomUUID()}`;
    this.queue.putArtifact(scope, id, sample);
    return id;
  }

  report(scope: TenantScope, runId: string, gate: PlatformQualityGate) {
    const usage = this.queue.usage(scope, runId);
    const stored = this.queue.listArtifacts(scope, this.prefix(runId), 5000);
    const report = summarizePlatformTelemetry(
      stored.artifacts.map((artifact) => artifact.value as PlatformSample),
      gate,
    );
    if (stored.truncated) {
      report.qualityGate.pass = false;
      report.qualityGate.reasons.push("telemetry_truncated");
    }
    return { ...report, usage, telemetry: { total: stored.total, truncated: stored.truncated } };
  }

  private prefix(runId: string): string {
    requirePlatformId(runId);
    return `telemetry.${createHash("sha256").update(runId).digest("hex")}.`;
  }
}
