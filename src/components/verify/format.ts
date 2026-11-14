import type { VerifiedRow } from "@/lib/backlinks/observe";

export function isChanged(row: VerifiedRow): boolean {
  const kind = row.change?.kind;
  return Boolean(kind && kind !== "first" && kind !== "unchanged" && kind !== "still_unverified");
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export type Sort = "input" | "problems" | "source";
const PROBLEM_ORDER = { missing: 0, deviates: 1, unverified: 2, meets: 3 } as const;

/** Filter by result or change, search source/target/anchor, then sort. */
export function visibleRows<T extends VerifiedRow>(
  rows: T[],
  options: { filter: string; query: string; sort: Sort },
): T[] {
  const needle = options.query.trim().toLowerCase();
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) =>
      options.filter === "all"
        ? true
        : options.filter === "changed"
          ? isChanged(row)
          : row.contract.verdict === options.filter,
    )
    .filter(
      ({ row }) =>
        !needle ||
        `${row.source_url} ${row.target_url} ${row.anchor ?? ""} ${row.expected_anchor ?? ""}`
          .toLowerCase()
          .includes(needle),
    )
    .sort((a, b) =>
      options.sort === "problems"
        ? PROBLEM_ORDER[a.row.contract.verdict] - PROBLEM_ORDER[b.row.contract.verdict] ||
          Number(isChanged(b.row)) - Number(isChanged(a.row)) ||
          a.index - b.index
        : options.sort === "source"
          ? a.row.source_url.localeCompare(b.row.source_url)
          : a.index - b.index,
    )
    .map(({ row }) => row);
}
