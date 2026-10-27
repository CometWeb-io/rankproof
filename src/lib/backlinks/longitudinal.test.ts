import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildRunManifest, measurementComparability } from "./measurement.server.ts";
import { diffReport, toHistoryItem } from "./history.ts";
import { buildEvidenceLedger, verifyEvidenceLedger } from "./evidence-ledger.server.ts";
import { compareRelationship } from "./relationships.ts";
import type { Backlink, ScanReport, SerpQuery } from "./types.ts";

const query = {
  keyword: "example",
  engine: "bing",
  market: "pl",
  device: "desktop",
  depth: 20,
  status: "ok",
  targetPosition: 5,
} as SerpQuery;
function link(id: string): Backlink {
  return {
    id,
    sourceUrl: `https://publisher.example/${id}`,
    sourceDomain: "publisher.example",
    targetUrl: "https://target.example/",
    anchor: "Original",
    rel: "dofollow",
    placement: "content",
    state: "live",
    verified: true,
    discoveredVia: "bing",
    evidence: {
      kind: "html_anchor",
      method: "fetched_html",
      observedAt: "2026-10-26T00:00:00Z",
      sourceRevision: "one",
      extractionVersion: "html-anchor-v4",
      identityPolicy: "exact",
      requestedSourceUrl: `https://publisher.example/${id}`,
      resolvedSourceUrl: `https://publisher.example/${id}`,
      rawHref: "https://target.example/",
      resolvedHref: "https://target.example/",
      responseHash: "a".repeat(64),
      absenceScope: null,
    },
  } as Backlink;
}
function report(
  at: string,
  links: Backlink[],
  overrides: Partial<Parameters<typeof buildRunManifest>[0]> = {},
): ScanReport {
  return {
    queriedAt: at,
    target: { host: "target.example" },
    backlinks: links,
    stats: { backlinks: links.length, referringDomains: 1, domainRating: 10, serpVisibility: 50 },
    analytics: { referringDomains: [{ domain: "publisher.example" }], health: { total: 80 } },
    measurement: buildRunManifest({
      startedAt: at,
      mode: "full",
      budgetMs: 10000,
      maxVerify: 20,
      maxBacklinks: 20,
      sources: [{ id: "bing", status: "ok" }],
      coverage: {},
      edges: [],
      observed: links,
      displayed: links,
      queries: [query],
      ...overrides,
    }),
  } as ScanReport;
}

test("stable method versions permit visibility comparison across code revisions", () => {
  const before = report("2026-10-26T00:00:00Z", [link("one")]).measurement!;
  const after = report("2026-10-27T00:00:00Z", [link("two")]).measurement!;
  before.sourceRevision = "old-commit";
  after.sourceRevision = "new-commit";
  assert.equal(measurementComparability(before, after).visibility, true);
  assert.equal(measurementComparability(before, after).scores, false);
});

test("measured browser history reports observation changes without inventing link loss", () => {
  const previous = report("2026-10-26T00:00:00Z", [link("one"), link("two")]);
  const current = report("2026-10-27T00:00:00Z", [link("two"), link("three")]);
  const diff = diffReport(current, toHistoryItem(previous, "target.example"));
  assert.ok(diff);
  assert.equal(diff.newLinks, 1);
  assert.equal(diff.lostLinks, 0);
  assert.equal(diff.unobservedLinks, 1);
  assert.equal(diff.commonLinks, 1);
  assert.equal(diff.healthDelta, null);
});

test("changed scan budgets or requested visibility cohorts block history comparison", () => {
  const previous = report("2026-10-26T00:00:00Z", [link("one")]);
  const current = report("2026-10-27T00:00:00Z", [], { budgetMs: 1 });
  assert.equal(diffReport(current, toHistoryItem(previous, "target.example")), null);
});

test("exported ledger roundtrips and rejects altered observations and manifest", () => {
  const scan = report("2026-10-26T00:00:00Z", [link("one")]);
  const ledger = buildEvidenceLedger(scan);
  assert.equal(verifyEvidenceLedger(ledger), true);
  const changed = structuredClone(ledger);
  changed.observations[0]!.payload.anchor = "Tampered";
  assert.equal(verifyEvidenceLedger(changed), false);
  const alteredManifest = structuredClone(ledger);
  alteredManifest.manifest!.policy.budgetMs = 1;
  assert.equal(verifyEvidenceLedger(alteredManifest), false);
  assert.equal(scan.backlinks[0]!.anchor, "Original");
});

test("relationship loss needs a later comparable complete HTML absence, never a blocked scan", () => {
  const before = {
    pairId: "one",
    sourceUrl: "https://publisher.example/one",
    targetUrl: "https://target.example/",
    observedAt: "2026-10-26T00:00:00Z",
    status: "CONFIRMED" as const,
    extractionVersion: "html-anchor-v4",
    identityPolicy: "exact",
    representation: "fetched_html" as const,
    resolvedSourceUrl: "https://publisher.example/one",
    responseHash: "a".repeat(64),
    completeHtml: true,
    anchor: "Original",
    rel: "dofollow",
    placement: "content",
  };
  const after = { ...before, observedAt: "2026-10-27T00:00:00Z", status: "BLOCKED" as const };
  assert.equal(compareRelationship([before, after]).status, "UNKNOWN");
  assert.equal(
    compareRelationship([before, { ...after, status: "NOT_FOUND_IN_HTML", responseHash: null }])
      .status,
    "UNKNOWN",
  );
  assert.equal(
    compareRelationship([before, { ...after, status: "NOT_FOUND_IN_HTML" }]).status,
    "CONFIRMED_CHANGE",
  );
  assert.equal(
    compareRelationship([
      before,
      {
        ...after,
        status: "NOT_FOUND_IN_HTML",
        resolvedSourceUrl: "https://publisher.example/login",
      },
    ]).status,
    "UNKNOWN",
  );
  const recovered = compareRelationship([
    before,
    after,
    { ...before, observedAt: "2026-10-28T00:00:00Z", anchor: "Updated" },
  ]);
  assert.equal(recovered.change, "attributes_changed");
  assert.equal(recovered.firstObserved, before.observedAt);
  assert.equal(recovered.lastConfirmed, "2026-10-28T00:00:00Z");
  assert.equal(recovered.lastAttempted, "2026-10-28T00:00:00Z");
});

test("append-only evidence migration preserves legacy history and rejects rewrites", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { readFile, readdir } = await import("node:fs/promises");
  const { pendingMigrations } = await import("../../../scripts/migration-plan.mjs");
  const database = new PGlite();
  try {
    const directory = new URL("../../../migrations/", import.meta.url);
    for (const { name } of pendingMigrations(await readdir(directory), [])) {
      await database.exec(await readFile(new URL(name, directory), "utf8"));
      if (name === "0002_scan_history.sql")
        await database.exec("insert into scan_history(host) values ('legacy.example')");
    }
    const ledger = buildEvidenceLedger(report("2026-10-26T00:00:00Z", [link("one")]));
    await database.query(
      "insert into evidence_runs(root_hash, host, queried_at, ledger) values ($1, $2, $3, $4)",
      [ledger.rootHash, ledger.host, ledger.runAt, ledger],
    );
    const stored = await database.query<{ ledger: typeof ledger }>(
      "select ledger from evidence_runs",
    );
    assert.equal(verifyEvidenceLedger(stored.rows[0]!.ledger), true);
    await assert.rejects(
      database.exec("update evidence_runs set host = 'changed.example'"),
      /append-only/,
    );
    await assert.rejects(database.exec("delete from evidence_runs"), /append-only/);
    const legacy = await database.query<{ measurement: null }>(
      "select measurement from scan_history where host = 'legacy.example'",
    );
    assert.equal(legacy.rows[0]!.measurement, null);
  } finally {
    await database.close();
  }
});

test("a hash-consistent fragment is not a complete ledger export", () => {
  const fragment = { observations: [], version: "evidence-ledger-v2" };
  const rootHash = createHash("sha256").update(JSON.stringify(fragment)).digest("hex");
  assert.equal(
    verifyEvidenceLedger({ ...fragment, rootHash } as unknown as Parameters<
      typeof verifyEvidenceLedger
    >[0]),
    false,
  );
});
