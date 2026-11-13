import assert from "node:assert/strict";
import { test } from "node:test";
import type { VerifiedRow } from "@/lib/backlinks/observe";
import { isChanged, visibleRows } from "./format.ts";

function row(
  source: string,
  verdict: VerifiedRow["contract"]["verdict"],
  change?: string,
): VerifiedRow {
  return {
    source_url: `https://${source}/`,
    target_url: "https://brand.example/",
    status: verdict === "missing" ? "not_found" : verdict === "unverified" ? "error" : "confirmed",
    checked_at: "2026-11-12T00:00:00Z",
    anchor: verdict === "meets" ? "Brand" : null,
    rel: null,
    reason: null,
    contract: { verdict } as VerifiedRow["contract"],
    change: change ? ({ kind: change, detail: "", since: null } as VerifiedRow["change"]) : null,
  } as VerifiedRow;
}

const rows = [
  row("c.example", "meets"),
  row("a.example", "unverified"),
  row("b.example", "missing", "missing_in_representation"),
  row("d.example", "deviates"),
];

test("problems first: missing, deviates, unverified, meets; changed rows lead within a verdict", () => {
  assert.deepEqual(
    visibleRows(rows, { filter: "all", query: "", sort: "problems" }).map((r) => r.source_url),
    ["https://b.example/", "https://d.example/", "https://a.example/", "https://c.example/"],
  );
  assert.deepEqual(
    visibleRows(rows, { filter: "all", query: "", sort: "source" }).map((r) => r.source_url)[0],
    "https://a.example/",
  );
  assert.equal(visibleRows(rows, { filter: "all", query: "", sort: "input" })[0], rows[0]);
});

test("filters by verdict, by change and by search text", () => {
  assert.equal(visibleRows(rows, { filter: "deviates", query: "", sort: "input" }).length, 1);
  assert.equal(visibleRows(rows, { filter: "changed", query: "", sort: "input" }).length, 1);
  assert.equal(visibleRows(rows, { filter: "all", query: "  BRAND ", sort: "input" }).length, 4);
  assert.equal(visibleRows(rows, { filter: "all", query: "c.exa", sort: "input" }).length, 1);
  assert.equal(isChanged(row("x", "missing", "still_unverified")), false);
});
