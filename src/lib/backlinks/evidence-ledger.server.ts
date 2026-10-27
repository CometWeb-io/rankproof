import { createHash } from "node:crypto";
import type { Backlink, ScanReport } from "./types.ts";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

function observationStatus(row: Backlink) {
  return row.evidence?.kind === "html_anchor" && row.verified && row.state === "live"
    ? "CONFIRMED"
    : row.evidence?.kind === "provider_report"
      ? "REPORTED"
      : "UNKNOWN";
}

/** Exported hashes establish internal integrity, not independent proof of a server's honesty. */
export function buildEvidenceLedger(report: ScanReport) {
  const observations = [...report.backlinks, ...(report.providerReports ?? [])].map((row) => {
    const payload = structuredClone(row);
    return {
      id: hash([report.target.host, report.queriedAt, payload]),
      pairId: row.id,
      observedAt: row.evidence?.observedAt ?? report.queriedAt,
      status: observationStatus(row),
      payloadHash: hash(payload),
      payload,
    };
  });
  const content = {
    version: "evidence-ledger-v2" as const,
    host: report.target.host,
    runAt: report.queriedAt,
    manifest: structuredClone(report.measurement ?? null),
    observations,
    interpretations: {
      scores: "inferred_uncalibrated",
      missingLinks: "unknown_without_explicit_recheck",
    },
  };
  return { ...content, rootHash: hash(content) };
}
export type EvidenceLedger = ReturnType<typeof buildEvidenceLedger>;

export function verifyEvidenceLedger(value: unknown): value is EvidenceLedger {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const ledger = value as EvidenceLedger;
    if (
      typeof ledger.host !== "string" ||
      !ledger.host ||
      typeof ledger.runAt !== "string" ||
      !Number.isFinite(Date.parse(ledger.runAt)) ||
      !(
        ledger.manifest === null ||
        (typeof ledger.manifest === "object" && !Array.isArray(ledger.manifest))
      ) ||
      !Array.isArray(ledger.observations) ||
      ledger.interpretations?.scores !== "inferred_uncalibrated" ||
      ledger.interpretations?.missingLinks !== "unknown_without_explicit_recheck"
    )
      return false;
    const { rootHash, ...content } = ledger;
    return (
      ledger.version === "evidence-ledger-v2" &&
      rootHash === hash(content) &&
      ledger.observations.every(
        (row) =>
          typeof row.pairId === "string" &&
          !!row.pairId &&
          typeof row.payload?.sourceUrl === "string" &&
          typeof row.payload.targetUrl === "string" &&
          typeof row.observedAt === "string" &&
          Number.isFinite(Date.parse(row.observedAt)) &&
          row.observedAt === (row.payload.evidence?.observedAt ?? ledger.runAt) &&
          row.status === observationStatus(row.payload) &&
          row.payloadHash === hash(row.payload) &&
          row.pairId === row.payload.id &&
          row.id === hash([ledger.host, ledger.runAt, row.payload]),
      )
    );
  } catch {
    return false;
  }
}

export type LedgerPayload = Backlink;
