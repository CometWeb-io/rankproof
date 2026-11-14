/**
 * Scores the extractor against the labelled corpus in
 * fixtures/verify-benchmark.ts. Offline and deterministic.
 *
 *   npm run benchmark            human-readable report
 *   npm run benchmark -- --json  machine-readable (for CI or publishing)
 */
import { BENCHMARK_CASES, type BenchmarkCase } from "./fixtures/verify-benchmark.ts";
import { EXTRACTION_VERSION } from "./measurement.server.ts";
import { observeRepresentation } from "./verify-api.server.ts";

export type CaseResult = {
  id: string;
  category: BenchmarkCase["category"];
  limitation: boolean;
  expected: BenchmarkCase["expected"];
  actual: { status: string; anchor: string | null; rel: string | null; placement: string | null };
  pass: boolean;
  mismatches: string[];
};

export type BenchmarkReport = {
  kind: "rankproof.benchmark";
  extraction_version: string;
  cases: number;
  scored: number;
  passed: number;
  accuracy: number;
  /** Of every "confirmed" verdict, how many were right (scored cases). */
  confirmed_precision: number | null;
  /** Of every truly linked case, how many were confirmed (scored cases). */
  confirmed_recall: number | null;
  /** Errors returned — honest abstentions, but they answer nothing. */
  unresolved_share: number;
  /** "not_found" given where the link exists or the page was unreadable — the costliest error. */
  false_absence: number;
  by_category: Record<string, { cases: number; passed: number }>;
  limitations: { id: string; description: string; rankproof: string; browser: string }[];
  results: CaseResult[];
};

export function runBenchmark(cases: BenchmarkCase[] = BENCHMARK_CASES): BenchmarkReport {
  const results = cases.map((item): CaseResult => {
    const observation = observeRepresentation(
      {
        source_url: item.source_url ?? "https://publisher.example/post",
        target_url: item.target_url,
      },
      {
        text: item.html,
        finalUrl: item.final_url ?? item.source_url ?? "https://publisher.example/post",
        status: item.status ?? 200,
        contentType: item.content_type ?? "text/html; charset=utf-8",
        checkedAt: "2026-01-01T00:00:00.000Z",
      },
    );
    const actual = {
      status: observation.status,
      anchor: observation.anchor,
      rel: observation.rel,
      placement: observation.placement,
    };
    const mismatches: string[] = [];
    if (actual.status !== item.expected.status) {
      mismatches.push(`status ${actual.status} ≠ ${item.expected.status}`);
    }
    if (item.expected.anchor !== undefined && actual.anchor !== item.expected.anchor) {
      mismatches.push(`anchor "${actual.anchor}" ≠ "${item.expected.anchor}"`);
    }
    if (item.expected.rel !== undefined && actual.rel !== item.expected.rel) {
      mismatches.push(`rel "${actual.rel}" ≠ "${item.expected.rel}"`);
    }
    if (item.expected.placement !== undefined && actual.placement !== item.expected.placement) {
      mismatches.push(`placement ${actual.placement} ≠ ${item.expected.placement}`);
    }
    return {
      id: item.id,
      category: item.category,
      limitation: Boolean(item.limitation),
      expected: item.expected,
      actual,
      pass: mismatches.length === 0,
      mismatches,
    };
  });

  const scored = results.filter((r) => !r.limitation);
  const passed = scored.filter((r) => r.pass).length;
  const saidConfirmed = scored.filter((r) => r.actual.status === "confirmed");
  const reallyLinked = scored.filter((r) => r.expected.status === "confirmed");
  const byCategory: BenchmarkReport["by_category"] = {};
  for (const r of results) {
    const entry = (byCategory[r.category] ??= { cases: 0, passed: 0 });
    entry.cases += 1;
    if (r.pass) entry.passed += 1;
  }
  const ratio = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 1000) / 1000);
  return {
    kind: "rankproof.benchmark",
    extraction_version: EXTRACTION_VERSION,
    cases: results.length,
    scored: scored.length,
    passed,
    accuracy: ratio(passed, scored.length) ?? 0,
    confirmed_precision: ratio(
      saidConfirmed.filter((r) => r.expected.status === "confirmed").length,
      saidConfirmed.length,
    ),
    confirmed_recall: ratio(
      reallyLinked.filter((r) => r.actual.status === "confirmed").length,
      reallyLinked.length,
    ),
    unresolved_share:
      ratio(scored.filter((r) => r.actual.status === "error").length, scored.length) ?? 0,
    false_absence: scored.filter(
      (r) => r.actual.status === "not_found" && r.expected.status !== "not_found",
    ).length,
    by_category: byCategory,
    limitations: cases
      .filter((c) => c.limitation)
      .map((c) => ({
        id: c.id,
        description: c.description,
        rankproof: results.find((r) => r.id === c.id)!.actual.status,
        browser: c.browser_truth ?? c.expected.status,
      })),
    results,
  };
}

export function benchmarkText(report: BenchmarkReport): string {
  const pct = (value: number | null) =>
    value === null ? "n/a" : `${Math.round(value * 1000) / 10}%`;
  const lines = [
    `RankProof verification benchmark · extractor ${report.extraction_version}`,
    `${report.passed}/${report.scored} labelled cases pass (${pct(report.accuracy)}); ${report.cases - report.scored} documented limitation(s) scored separately.`,
    `confirmed precision ${pct(report.confirmed_precision)} · confirmed recall ${pct(report.confirmed_recall)} · unresolved ${pct(report.unresolved_share)} · false absences ${report.false_absence}`,
    "",
    "By category:",
    ...Object.entries(report.by_category).map(
      ([name, value]) => `  ${name.padEnd(12)} ${value.passed}/${value.cases}`,
    ),
  ];
  const failures = report.results.filter((r) => !r.pass && !r.limitation);
  if (failures.length > 0) {
    lines.push("", "Failures:");
    for (const f of failures) lines.push(`  ✗ ${f.id}: ${f.mismatches.join("; ")}`);
  }
  lines.push("", "Known limitations (fetched HTML vs a real browser):");
  for (const l of report.limitations) {
    lines.push(
      `  · ${l.id}: RankProof says ${l.rankproof}, a browser shows ${l.browser}. ${l.description}`,
    );
  }
  return lines.join("\n");
}

export type RenderedBenchmarkReport = {
  kind: "rankproof.benchmark.rendered";
  engine: string | null;
  scored: number;
  passed: number;
  /** Documented fetched-HTML limitations that rendering answers like a browser. */
  limitations_resolved: number;
  limitations: number;
  results: { id: string; limitation: boolean; expected: string; actual: string; pass: boolean }[];
};

/**
 * The same corpus with `render: "always"` semantics, offline: each case's HTML
 * is served to headless Chromium and every other request is blocked. Scores
 * the *effective* verdict (fetched HTML first, rendered DOM where HTML could
 * not decide) and, for documented limitations, what a visitor actually sees.
 */
export async function runRenderedBenchmark(
  cases: BenchmarkCase[] = BENCHMARK_CASES,
): Promise<RenderedBenchmarkReport> {
  const { renderObserve, renderAvailability } = await import("./render.server.ts");
  const { needsRender } = await import("./verify-api.server.ts");
  const { effectiveObservation } = await import("./observe.ts");
  const available = await renderAvailability();
  if (!available.ok) throw new Error(available.reason ?? "Rendering unavailable.");
  const source = (item: BenchmarkCase) => item.source_url ?? "https://publisher.example/post";
  const observations = cases.map((item) =>
    observeRepresentation(
      { source_url: source(item), target_url: item.target_url },
      {
        text: item.html,
        finalUrl: item.final_url ?? source(item),
        status: item.status ?? 200,
        contentType: item.content_type ?? "text/html; charset=utf-8",
      },
    ),
  );
  const todo = observations
    .map((observation, index) => ({ observation, index }))
    .filter(({ observation }) => needsRender(observation, "always"));
  const rendered = await renderObserve(
    todo.map(({ index }) => ({
      source_url: source(cases[index]!),
      target_url: cases[index]!.target_url,
      snapshot: { html: cases[index]!.html, status: cases[index]!.status },
    })),
  );
  todo.forEach(({ observation }, i) => {
    observation.rendered = rendered[i] ?? null;
  });

  const results = cases.map((item, index) => {
    const view = effectiveObservation(observations[index]!);
    if (item.limitation) {
      const seen =
        view.status === "confirmed" && view.visible !== false ? "confirmed" : "not_found";
      const expected = item.browser_truth ?? item.expected.status;
      return { id: item.id, limitation: true, expected, actual: seen, pass: seen === expected };
    }
    return {
      id: item.id,
      limitation: false,
      expected: item.expected.status,
      actual: view.status,
      pass: view.status === item.expected.status,
    };
  });
  const scored = results.filter((r) => !r.limitation);
  const limits = results.filter((r) => r.limitation);
  return {
    kind: "rankproof.benchmark.rendered",
    engine: available.engine,
    scored: scored.length,
    passed: scored.filter((r) => r.pass).length,
    limitations_resolved: limits.filter((r) => r.pass).length,
    limitations: limits.length,
    results,
  };
}

export function renderedBenchmarkText(report: RenderedBenchmarkReport): string {
  const lines = [
    `Rendered mode (${report.engine}, offline, render: always):`,
    `  ${report.passed}/${report.scored} labelled cases keep the right status; ${report.limitations_resolved}/${report.limitations} documented limitations answered like a browser.`,
  ];
  for (const r of report.results.filter((x) => !x.pass)) {
    lines.push(`  ✗ ${r.id}: ${r.actual} ≠ ${r.expected}`);
  }
  return lines.join("\n");
}
