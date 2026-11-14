/**
 * Link contracts and change detection for verified source → target pairs.
 *
 * Pure functions only (no I/O), shared by the HTTP API, the CLI and the web UI.
 * Three things are kept strictly apart:
 *
 *   1. what the user expected   (expected anchor / rel — the "contract"),
 *   2. what was observed         (a BacklinkObservation from fetched HTML),
 *   3. what that means           (a deviation from the contract — never an SEO verdict).
 *
 * An `error` observation is never turned into a missing link, and a link absent
 * from one fetched representation is never reported as removed from the web.
 */

export type ExpectedRel = "follow" | "nofollow" | "sponsored" | "ugc";
export const EXPECTED_RELS: ExpectedRel[] = ["follow", "nofollow", "sponsored", "ugc"];

export type ExpectedPlacement = "content" | "navigation" | "footer" | "sidebar" | "comment";
export const EXPECTED_PLACEMENTS: ExpectedPlacement[] = [
  "content",
  "navigation",
  "footer",
  "sidebar",
  "comment",
];

/** Comparison rules for anchors, rel tokens and placement. Bump when they change. */
export const CONTRACT_POLICY = "link-contract-v2" as const;

export type ContractMark = "match" | "mismatch" | "unspecified" | "unobserved";
export type TargetMark = "exact" | "near" | "none" | "unresolved";
export type ContractVerdict = "meets" | "deviates" | "missing" | "unverified";

export type LinkContract = {
  policy: typeof CONTRACT_POLICY;
  verdict: ContractVerdict;
  target: TargetMark;
  anchor: ContractMark;
  rel: ContractMark;
  /** `unobserved` also when the page has no landmarks to tell regions apart. */
  placement: ContractMark;
  /** The target host or agreed anchor appears as plain text without a link. */
  mentioned: boolean;
  /**
   * Only with rendering: `match` when a matching anchor is visible to visitors,
   * `mismatch` when every one is hidden (display, opacity, size, off-screen).
   */
  visibility: ContractMark;
  /** Which observation the verdict rests on. */
  basis: "fetched_html" | "rendered_dom";
  notes: string[];
};

/** The subset of an API observation the contract needs (keeps this module UI-safe). */
export type ObservationLike = {
  source_url: string;
  target_url: string;
  status: "confirmed" | "not_found" | "error";
  checked_at: string;
  anchor: string | null;
  rel: string | null;
  reason: string | null;
  absence_scope?: "fetched_html" | "http_resource" | "rendered_dom" | null;
  resolved_href?: string | null;
  response_hash?: string | null;
  matching_anchors?: {
    raw_href: string;
    resolved_href: string;
    anchor: string;
    rel: string;
    placement?: string;
    context?: string;
  }[];
  placement?: string | null;
  context?: string | null;
  mentions?: { term: string; snippet: string }[];
  /** Optional second observation from headless Chromium (see render.server.ts). */
  rendered?: RenderedLike | null;
  near_matches?: { resolved_href: string; anchor: string; rel: string; difference: string }[];
};

export type RenderedLike = {
  status: "confirmed" | "not_found" | "error";
  reason?: string | null;
  visible?: boolean | null;
  final_url?: string | null;
  dom_hash?: string | null;
  blocked_script_requests?: number;
  matching_anchors?: {
    resolved_href: string;
    anchor: string;
    rel: string;
    visible: boolean;
    placement?: string;
  }[];
};

/**
 * The observation a verdict should rest on. Fetched HTML wins whenever it
 * confirmed the link; the rendered DOM decides only when the HTML could not
 * (no anchor, or an application shell). A failed render never overrides HTML.
 */
export function effectiveObservation(
  observation: ObservationLike,
): ObservationLike & { basis: "fetched_html" | "rendered_dom"; visible: boolean | null } {
  const rendered = observation.rendered;
  const visibleFromRender =
    rendered && rendered.status === "confirmed" ? (rendered.visible ?? null) : null;
  if (!rendered || rendered.status === "error" || observation.status === "confirmed") {
    return { ...observation, basis: "fetched_html", visible: visibleFromRender };
  }
  if (observation.absence_scope === "http_resource") {
    return { ...observation, basis: "fetched_html", visible: null };
  }
  if (rendered.status === "confirmed") {
    const anchors = rendered.matching_anchors ?? [];
    const first = anchors.find((a) => a.visible) ?? anchors[0];
    return {
      ...observation,
      status: "confirmed",
      anchor: first?.anchor ?? null,
      rel: first?.rel ?? null,
      resolved_href: first?.resolved_href ?? null,
      placement: first?.placement ?? "unknown",
      absence_scope: null,
      reason: null,
      matching_anchors: anchors.map((a) => ({
        raw_href: a.resolved_href,
        resolved_href: a.resolved_href,
        anchor: a.anchor,
        rel: a.rel,
        placement: a.placement ?? "unknown",
      })),
      basis: "rendered_dom",
      visible: rendered.visible ?? null,
    };
  }
  // Rendered and still absent: a stronger absence claim than fetched HTML alone.
  return {
    ...observation,
    status: "not_found",
    absence_scope: "rendered_dom",
    reason: rendered.reason ?? "No anchor to the exact target URL in the rendered DOM.",
    basis: "rendered_dom",
    visible: null,
  };
}

export type Expectation = {
  expected_anchor?: string | null;
  expected_rel?: ExpectedRel | null;
  expected_placement?: ExpectedPlacement | null;
};

export function normalizeExpectedPlacement(value: unknown): ExpectedPlacement | null {
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase();
  const alias: Record<string, ExpectedPlacement> = {
    content: "content",
    "in-content": "content",
    in_content: "content",
    body: "content",
    article: "content",
    navigation: "navigation",
    nav: "navigation",
    menu: "navigation",
    footer: "footer",
    sidebar: "sidebar",
    aside: "sidebar",
    comment: "comment",
    comments: "comment",
  };
  return alias[token] ?? null;
}

export function pairKey(sourceUrl: string, targetUrl: string): string {
  return `${stripHash(sourceUrl)}\u0000${stripHash(targetUrl)}`;
}

export function stripHash(raw: string): string {
  try {
    const url = new URL(raw.trim());
    url.hash = "";
    return url.href;
  } catch {
    return raw.trim();
  }
}

/** Case- and whitespace-insensitive anchor comparison (NFKC, collapsed spaces). */
export function anchorsEqual(left: string, right: string): boolean {
  return foldAnchor(left) === foldAnchor(right);
}

function foldAnchor(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function relTokens(rel: string | null | undefined): string[] {
  return (rel ?? "")
    .toLowerCase()
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

/** `follow` means: none of the qualifying tokens; anything else must be present. */
export function relSatisfies(expected: ExpectedRel, rel: string | null | undefined): boolean {
  const tokens = relTokens(rel);
  if (expected === "follow") {
    return !tokens.some(
      (token) => token === "nofollow" || token === "sponsored" || token === "ugc",
    );
  }
  return tokens.includes(expected);
}

export function normalizeExpectedRel(value: unknown): ExpectedRel | null {
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase();
  if (!token) return null;
  if (token === "follow" || token === "dofollow") return "follow";
  return (EXPECTED_RELS as string[]).includes(token) ? (token as ExpectedRel) : null;
}

export function evaluateContract(
  observation: ObservationLike,
  expectation: Expectation = {},
): LinkContract {
  const view = effectiveObservation(observation);
  observation = view;
  const rendering = {
    basis: view.basis,
    visibility: (view.visible === null
      ? "unspecified"
      : view.visible
        ? "match"
        : "mismatch") as ContractMark,
  };
  const expectedAnchor = blankToNull(expectation.expected_anchor);
  const expectedRel = expectation.expected_rel ?? null;
  const expectedPlacement = expectation.expected_placement ?? null;
  const notes: string[] = [];
  const base = { policy: CONTRACT_POLICY } as const;
  const placementOpen: ContractMark = expectedPlacement ? "unobserved" : "unspecified";

  if (observation.status === "error") {
    notes.push(
      "The source could not be observed. An error is a measurement gap, not evidence that the link is missing.",
    );
    return {
      ...base,
      verdict: "unverified",
      target: "unresolved",
      anchor: expectedAnchor ? "unobserved" : "unspecified",
      rel: expectedRel ? "unobserved" : "unspecified",
      placement: placementOpen,
      mentioned: false,
      ...rendering,
      notes,
    };
  }

  if (observation.status === "not_found") {
    const mentions = observation.mentions ?? [];
    const near = observation.near_matches ?? [];
    if (observation.absence_scope === "http_resource") {
      notes.push("The source page itself is gone (HTTP 404/410).");
    } else if (observation.absence_scope === "rendered_dom") {
      notes.push(
        "No anchor to the exact target URL in the fetched HTML, nor in the page after JavaScript ran in a headless browser.",
      );
      const blocked = observation.rendered?.blocked_script_requests ?? 0;
      if (blocked > 0) {
        notes.push(
          `${blocked} script or data request(s) were refused by the URL policy or could not be resolved; anything they would have added is unknown.`,
        );
      }
    } else {
      notes.push(
        "No anchor to the exact target URL in the fetched HTML. JavaScript-inserted links are not rendered, so presence in a browser is unknown.",
      );
    }
    if (near.length > 0) {
      notes.push(
        `The page links to the target site, but to a different URL (${near[0]!.difference}). That is a target deviation, not a missing page.`,
      );
    }
    if (mentions.length > 0) {
      notes.push(
        `"${mentions[0]!.term}" appears on the page as plain text without a link — a candidate for asking the publisher to add the link.`,
      );
    }
    return {
      ...base,
      verdict: "missing",
      target: near.length > 0 ? "near" : "none",
      anchor: expectedAnchor ? "unobserved" : "unspecified",
      rel: expectedRel ? "unobserved" : "unspecified",
      placement: placementOpen,
      mentioned: mentions.length > 0,
      ...rendering,
      notes,
    };
  }

  const anchors =
    observation.matching_anchors && observation.matching_anchors.length > 0
      ? observation.matching_anchors.map((item) => ({
          anchor: item.anchor,
          rel: item.rel,
          placement: item.placement ?? "unknown",
        }))
      : [
          {
            anchor: observation.anchor ?? "",
            rel: observation.rel ?? "",
            placement: observation.placement ?? "unknown",
          },
        ];

  const scoped = expectedAnchor
    ? anchors.filter((item) => anchorsEqual(item.anchor, expectedAnchor))
    : anchors;

  const anchor: ContractMark = !expectedAnchor
    ? "unspecified"
    : scoped.length > 0
      ? "match"
      : "mismatch";
  if (anchor === "mismatch") {
    const seen = [...new Set(anchors.map((item) => item.anchor || "(empty)"))].slice(0, 3);
    notes.push(
      `Expected anchor "${expectedAnchor}", observed ${seen.map((a) => `"${a}"`).join(", ")}.`,
    );
  }

  // rel is judged on the anchors that satisfy the anchor clause; when the anchor
  // itself deviates, it is judged on every link to the target.
  const relPool = scoped.length > 0 ? scoped : anchors;
  const rel: ContractMark = !expectedRel
    ? "unspecified"
    : relPool.some((item) => relSatisfies(expectedRel, item.rel))
      ? "match"
      : "mismatch";
  if (rel === "mismatch") {
    const seen = [...new Set(relPool.map((item) => item.rel || "(none)"))].slice(0, 3);
    notes.push(
      `Expected rel "${expectedRel}", observed rel ${seen.map((r) => `"${r}"`).join(", ")}. That is a deviation from the agreed terms, not an SEO judgement.`,
    );
  }
  // Placement is judged on the anchors that satisfy the anchor and rel clauses.
  const placementPool = expectedRel
    ? relPool.filter((item) => relSatisfies(expectedRel, item.rel))
    : relPool;
  const judged = placementPool.length > 0 ? placementPool : relPool;
  const known = judged.filter((item) => item.placement !== "unknown");
  const placement: ContractMark = !expectedPlacement
    ? "unspecified"
    : judged.some((item) => item.placement === expectedPlacement)
      ? "match"
      : known.length === 0
        ? "unobserved"
        : "mismatch";
  if (placement === "mismatch") {
    const seen = [...new Set(known.map((item) => item.placement))].join(", ");
    notes.push(`Expected the link in ${expectedPlacement}, observed it in ${seen}.`);
  } else if (placement === "unobserved") {
    notes.push(
      "The page has no landmarks or class names that tell content from navigation, footer or sidebar, so placement could not be checked.",
    );
  }
  if (view.basis === "rendered_dom") {
    notes.push(
      "Linked only after JavaScript runs: the fetched HTML has no such anchor. Crawlers that do not render may never see it.",
    );
  }
  if (rendering.visibility === "mismatch") {
    notes.push(
      "The link is in the page but hidden from visitors (display, visibility, opacity, zero size or off-screen).",
    );
  }
  if (anchors.length > 1) {
    notes.push(`${anchors.length} anchors on the page point at the exact target URL.`);
  }

  return {
    ...base,
    verdict:
      anchor === "mismatch" ||
      rel === "mismatch" ||
      placement === "mismatch" ||
      rendering.visibility === "mismatch"
        ? "deviates"
        : "meets",
    target: "exact",
    anchor,
    rel,
    placement,
    mentioned: false,
    ...rendering,
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* Change detection between two runs of the same pair                  */
/* ------------------------------------------------------------------ */

export type ChangeKind =
  | "first"
  | "unchanged"
  | "appeared"
  | "missing_in_representation"
  | "source_gone"
  | "still_unverified"
  | "became_unverified"
  | "verified_again"
  | "changed_detail";

export type Change = { kind: ChangeKind; detail: string; since: string | null };

export function compareObservations(
  previous: ObservationLike | null | undefined,
  current: ObservationLike,
): Change {
  const since = previous?.checked_at ?? null;
  if (!previous) return { kind: "first", detail: "First observation of this pair.", since };
  const before = effectiveObservation(previous);
  const after = effectiveObservation(current);
  previous = before;
  current = after;
  if (before.status === "confirmed" && after.status === "confirmed") {
    if (before.visible === true && after.visible === false) {
      return {
        kind: "changed_detail",
        detail: "Still in the page, but now hidden from visitors.",
        since,
      };
    }
    if (before.visible === false && after.visible === true) {
      return { kind: "changed_detail", detail: "The link is visible to visitors again.", since };
    }
  }
  if (previous.status === "error" && current.status === "error") {
    return {
      kind: "still_unverified",
      detail: "Still not observable. This is not a lost link.",
      since,
    };
  }
  if (current.status === "error") {
    return {
      kind: "became_unverified",
      detail: `This run failed (${current.reason ?? "error"}). The previous ${previous.status} observation stands; nothing is reported as lost.`,
      since,
    };
  }
  if (previous.status === "error") {
    return {
      kind: "verified_again",
      detail: `Observable again after a failed run: ${current.status === "confirmed" ? "link confirmed" : "link not found"}.`,
      since,
    };
  }
  if (previous.status === "confirmed" && current.status === "not_found") {
    if (current.absence_scope === "http_resource") {
      return {
        kind: "source_gone",
        detail: "The link was confirmed before; the source page now returns 404/410.",
        since,
      };
    }
    return {
      kind: "missing_in_representation",
      detail:
        current.absence_scope === "rendered_dom"
          ? "The link was there before and is absent from both the fetched HTML and the rendered page now."
          : "The link was in the previously fetched HTML and is absent from this one. That is not proof it was removed for every visitor (e.g. JavaScript, geo or A/B variants).",
      since,
    };
  }
  if (
    previous.status === "not_found" &&
    previous.absence_scope !== "http_resource" &&
    current.status === "not_found" &&
    current.absence_scope === "http_resource"
  ) {
    return {
      kind: "source_gone",
      detail: "The link was already missing; the source page itself now returns 404/410.",
      since,
    };
  }
  if (previous.status === "not_found" && current.status === "confirmed") {
    return {
      kind: "appeared",
      detail: "Now present in the fetched HTML; it was absent before.",
      since,
    };
  }
  if (
    previous.status === "confirmed" &&
    current.status === "confirmed" &&
    detailSignature(previous, current) !== detailSignature(current, previous)
  ) {
    return {
      kind: "changed_detail",
      detail: describeDetailChange(previous, current),
      since,
    };
  }
  return { kind: "unchanged", detail: "Same status, anchor, rel and target URL.", since };
}

/**
 * Placement only counts when both runs recorded it: a run saved before
 * placement existed (or a page without landmarks) is not a "move".
 */
function comparablePlacement(item: ObservationLike, other: ObservationLike): string {
  const a = item.placement ?? "unknown";
  const b = other.placement ?? "unknown";
  return a === "unknown" || b === "unknown" ? "" : a;
}

function detailSignature(item: ObservationLike, other: ObservationLike): string {
  return JSON.stringify([
    item.anchor ?? "",
    relTokens(item.rel).sort(),
    item.resolved_href ?? "",
    comparablePlacement(item, other),
  ]);
}

function describeDetailChange(previous: ObservationLike, current: ObservationLike): string {
  const parts: string[] = [];
  if ((previous.anchor ?? "") !== (current.anchor ?? "")) {
    parts.push(`anchor "${previous.anchor ?? ""}" → "${current.anchor ?? ""}"`);
  }
  // Name only what changed: "rel lost sponsored" reads better than the full
  // before/after token lists ("noopener sponsored → noopener").
  const before = relTokens(previous.rel);
  const after = relTokens(current.rel);
  const lost = before.filter((token) => !after.includes(token)).sort();
  const gained = after.filter((token) => !before.includes(token)).sort();
  const relParts: string[] = [];
  if (lost.length) relParts.push(`lost ${lost.join(" ")}`);
  if (gained.length) relParts.push(`gained ${gained.join(" ")}`);
  if (relParts.length) parts.push(`rel ${relParts.join(" and ")}`);
  if ((previous.resolved_href ?? "") !== (current.resolved_href ?? "")) parts.push("href changed");
  const from = comparablePlacement(previous, current);
  const to = comparablePlacement(current, previous);
  if (from !== to) parts.push(`moved from ${from} to ${to}`);
  return `Still linked, but ${parts.join(", ") || "details changed"}.`;
}

/** Index previous observations by pair so a run can be compared to the last one. */
export function indexByPair<T extends ObservationLike>(items: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(pairKey(item.source_url, item.target_url), item);
  return map;
}

/** Reads a previous run (or a raw `/v1/backlinks/verify` response) for comparison. */
export function previousObservations(json: unknown): ObservationLike[] {
  if (!json || typeof json !== "object") throw new Error("--previous: expected a JSON object.");
  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results)) throw new Error("--previous: no `results` array in the file.");
  return results.filter(
    (item): item is ObservationLike =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as ObservationLike).source_url === "string" &&
      typeof (item as ObservationLike).target_url === "string" &&
      ["confirmed", "not_found", "error"].includes((item as ObservationLike).status),
  );
}

/* ------------------------------------------------------------------ */
/* Pair tables: CSV / TSV / semicolon / pipe                          */
/* ------------------------------------------------------------------ */

export type PairRow = {
  line: number;
  source_url: string;
  target_url: string;
  expected_anchor: string | null;
  expected_rel: ExpectedRel | null;
  expected_placement: ExpectedPlacement | null;
};

export type PairTable = {
  rows: PairRow[];
  errors: { line: number; message: string }[];
  duplicates: number;
};

const HEADER_ALIASES: Record<string, keyof Omit<PairRow, "line">> = {
  source: "source_url",
  source_url: "source_url",
  sourceurl: "source_url",
  url_from: "source_url",
  from: "source_url",
  page: "source_url",
  target: "target_url",
  target_url: "target_url",
  targeturl: "target_url",
  url_to: "target_url",
  to: "target_url",
  anchor: "expected_anchor",
  expected_anchor: "expected_anchor",
  anchor_text: "expected_anchor",
  rel: "expected_rel",
  expected_rel: "expected_rel",
  link_type: "expected_rel",
  placement: "expected_placement",
  expected_placement: "expected_placement",
  position: "expected_placement",
};

/**
 * Parses a pasted or uploaded table of pairs. Columns default to
 * `source, target, anchor, rel`; a header row may reorder them. Quoted CSV
 * fields are supported. Nothing is truncated silently: callers enforce limits.
 */
export function parsePairTable(raw: string): PairTable {
  const rows: PairRow[] = [];
  const errors: PairTable["errors"] = [];
  const seen = new Map<string, PairRow>();
  let duplicates = 0;
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  const delimiter = detectDelimiter(
    lines.find((line) => line.trim() && !line.trim().startsWith("#")) ?? "",
  );
  let columns: (keyof Omit<PairRow, "line">)[] = [
    "source_url",
    "target_url",
    "expected_anchor",
    "expected_rel",
    "expected_placement",
  ];
  let sawData = false;

  lines.forEach((text, index) => {
    const line = index + 1;
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const cells = splitRow(trimmed, delimiter);
    if (
      !sawData &&
      cells.some((cell) => HEADER_ALIASES[cell.toLowerCase().replace(/[\s-]+/g, "_")])
    ) {
      const mapped = cells.map(
        (cell) => HEADER_ALIASES[cell.toLowerCase().replace(/[\s-]+/g, "_")],
      );
      if (mapped.includes("source_url") && mapped.includes("target_url")) {
        columns = mapped as typeof columns;
        return;
      }
    }
    sawData = true;
    const record: Partial<Record<keyof Omit<PairRow, "line">, string>> = {};
    columns.forEach((column, i) => {
      if (column && cells[i] !== undefined) record[column] = cells[i];
    });
    const source = (record.source_url ?? "").trim();
    const target = (record.target_url ?? "").trim();
    if (!source || !target) {
      errors.push({ line, message: "Needs a source URL and a target URL." });
      return;
    }
    if (!isHttpUrl(source) || !isHttpUrl(target)) {
      errors.push({ line, message: "Source and target must be absolute http(s) URLs." });
      return;
    }
    const relRaw = (record.expected_rel ?? "").trim();
    const expectedRel = normalizeExpectedRel(relRaw);
    if (relRaw && !expectedRel) {
      errors.push({
        line,
        message: `Unknown rel "${relRaw}". Use follow, nofollow, sponsored or ugc.`,
      });
      return;
    }
    const placementRaw = (record.expected_placement ?? "").trim();
    const expectedPlacement = normalizeExpectedPlacement(placementRaw);
    if (placementRaw && !expectedPlacement) {
      errors.push({
        line,
        message: `Unknown placement "${placementRaw}". Use content, navigation, footer, sidebar or comment.`,
      });
      return;
    }
    const row: PairRow = {
      line,
      source_url: source,
      target_url: target,
      expected_anchor: blankToNull(record.expected_anchor),
      expected_rel: expectedRel,
      expected_placement: expectedPlacement,
    };
    const key = pairKey(source, target);
    const first = seen.get(key);
    if (first) {
      // A repeated pair with the same expectations is a harmless duplicate.
      // Different expectations would otherwise be dropped without a trace, so
      // the user learns which line is actually checked.
      if (
        first.expected_anchor !== row.expected_anchor ||
        first.expected_rel !== row.expected_rel ||
        first.expected_placement !== row.expected_placement
      ) {
        errors.push({
          line,
          message: `Same pair as line ${first.line} with different expectations; only line ${first.line} is checked.`,
        });
      } else {
        duplicates += 1;
      }
      return;
    }
    seen.set(key, row);
    rows.push(row);
  });
  return { rows, errors, duplicates };
}

function detectDelimiter(sample: string): string {
  const counts = ["\t", ";", "|", ","].map((d) => [d, countOutsideQuotes(sample, d)] as const);
  const best = counts.sort((a, b) => b[1] - a[1])[0]!;
  return best[1] > 0 ? best[0] : ",";
}

function countOutsideQuotes(text: string, delimiter: string): number {
  let inQuotes = false;
  let count = 0;
  for (const char of text) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === delimiter && !inQuotes) count += 1;
  }
  return count;
}

function splitRow(text: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"' && current.trim() === "") {
      inQuotes = true;
      current = "";
    } else if (char === delimiter) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

/* ------------------------------------------------------------------ */
/* Summary and exports                                                 */
/* ------------------------------------------------------------------ */

export type VerifiedRow = ObservationLike &
  Expectation & {
    contract: LinkContract;
    change?: Change | null;
  };

export type VerifySummary = Record<ContractVerdict, number> & {
  total: number;
  changed: number;
};

export function summarize(rows: VerifiedRow[]): VerifySummary {
  const summary: VerifySummary = {
    total: rows.length,
    meets: 0,
    deviates: 0,
    missing: 0,
    unverified: 0,
    changed: 0,
  };
  for (const row of rows) {
    summary[row.contract.verdict] += 1;
    if (
      row.change &&
      row.change.kind !== "first" &&
      row.change.kind !== "unchanged" &&
      row.change.kind !== "still_unverified"
    ) {
      summary.changed += 1;
    }
  }
  return summary;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  // Neutralise spreadsheet formula injection from attacker-controlled anchors.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function verifiedRowsCsv(rows: VerifiedRow[]): string {
  const header = [
    "source_url",
    "target_url",
    "verdict",
    "status",
    "expected_anchor",
    "observed_anchor",
    "anchor_check",
    "expected_rel",
    "observed_rel",
    "rel_check",
    "expected_placement",
    "observed_placement",
    "placement_check",
    "target_check",
    "mentioned_without_link",
    "context",
    "change",
    "checked_at",
    "response_hash",
    "reason",
  ];
  const lines = rows.map((row) =>
    [
      row.source_url,
      row.target_url,
      row.contract.verdict,
      row.status,
      row.expected_anchor ?? "",
      row.anchor ?? "",
      row.contract.anchor,
      row.expected_rel ?? "",
      row.rel ?? "",
      row.contract.rel,
      row.expected_placement ?? "",
      row.placement ?? "",
      row.contract.placement,
      row.contract.target,
      row.contract.mentioned ? "yes" : "",
      row.context ?? row.mentions?.[0]?.snippet ?? "",
      row.change?.kind ?? "",
      row.checked_at,
      row.response_hash ?? "",
      row.reason ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}

export const VERDICT_LABELS: Record<ContractVerdict, string> = {
  meets: "Meets contract",
  deviates: "Deviates",
  missing: "Not in HTML",
  unverified: "Unverified",
};

export const CHANGE_LABELS: Record<ChangeKind, string> = {
  first: "First check",
  unchanged: "Unchanged",
  appeared: "Appeared",
  missing_in_representation: "Gone from HTML",
  source_gone: "Source page gone",
  still_unverified: "Still unverified",
  became_unverified: "Run failed",
  verified_again: "Verified again",
  changed_detail: "Details changed",
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A link only for http(s) URLs; anything else (javascript:, data:, …) stays text. */
function httpLink(url: string): string {
  let safe = false;
  try {
    const parsed = new URL(url);
    safe =
      (parsed.protocol === "http:" || parsed.protocol === "https:") && /^https?:\/\//i.test(url);
  } catch {
    safe = false;
  }
  return safe
    ? `<a href="${escapeHtml(url)}" rel="nofollow noopener">${escapeHtml(url)}</a>`
    : escapeHtml(url);
}

/** GitHub-flavoured Markdown, e.g. for a CI job summary or a pull-request comment. */
export function verifiedRowsMarkdown(rows: VerifiedRow[]): string {
  const label: Record<string, string> = {
    meets: "✅ Meets contract",
    deviates: "⚠️ Deviates",
    missing: "❌ Not in HTML",
    unverified: "❔ Unverified",
  };
  // Every value from the input or the page goes into a code span: no links,
  // images, HTML, mentions or emphasis can be injected into a job summary or
  // PR comment. A pipe stays escaped inside the span (GFM tables).
  const cell = (value: string) => {
    const text = value.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!text) return "";
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(longest + 1);
    return `${fence} ${text.replace(/\|/g, "\\|")} ${fence}`;
  };
  const s = summarize(rows);
  const lines = rows.map((row) => {
    const change =
      row.change && row.change.kind !== "first" && row.change.kind !== "unchanged"
        ? ` (${CHANGE_LABELS[row.change.kind]})`
        : "";
    return `| ${label[row.contract.verdict]}${change} | ${cell(row.source_url)} | ${cell(row.target_url)} | ${cell(row.contract.notes[0] ?? row.reason ?? "")} |`;
  });
  return [
    `### RankProof: ${s.meets}/${s.total} links meet their contract`,
    "",
    `${s.deviates} deviate · ${s.missing} not in HTML · ${s.unverified} unverified${rows.some((r) => r.change) ? ` · ${s.changed} changed` : ""}`,
    "",
    "| Result | Source | Target | Note |",
    "| --- | --- | --- | --- |",
    ...lines,
  ].join("\n");
}

/** A standalone, dependency-free evidence report a client or publisher can open. */
export function verifiedRowsHtml(
  rows: VerifiedRow[],
  meta: { generatedAt?: string; title?: string } = {},
): string {
  const summary = summarize(rows);
  const generatedAt = meta.generatedAt ?? new Date().toISOString();
  const tone: Record<ContractVerdict, string> = {
    meets: "#0f7b55",
    deviates: "#a15c00",
    missing: "#b42318",
    unverified: "#5b6170",
  };
  const body = rows
    .map(
      (row) => `<tr>
<td><span class="pill" style="--c:${tone[row.contract.verdict]}">${escapeHtml(VERDICT_LABELS[row.contract.verdict])}</span>${
        row.change && row.change.kind !== "first" && row.change.kind !== "unchanged"
          ? `<div class="sub">${escapeHtml(CHANGE_LABELS[row.change.kind])}</div>`
          : ""
      }</td>
<td>${httpLink(row.source_url)}<div class="sub">→ ${escapeHtml(row.target_url)}</div></td>
<td>${escapeHtml(row.anchor ?? "—")}${row.expected_anchor ? `<div class="sub">expected: ${escapeHtml(row.expected_anchor)} · ${row.contract.anchor}</div>` : ""}${row.placement ? `<div class="sub">in ${escapeHtml(row.placement)}${row.expected_placement ? ` (expected ${escapeHtml(row.expected_placement)} · ${row.contract.placement})` : ""}</div>` : ""}${row.context ? `<div class="ctx">“${escapeHtml(row.context)}”</div>` : ""}</td>
<td>${escapeHtml(row.rel || (row.status === "confirmed" ? "(none)" : "—"))}${row.expected_rel ? `<div class="sub">expected: ${escapeHtml(row.expected_rel)} · ${row.contract.rel}</div>` : ""}</td>
<td class="mono">${escapeHtml(row.checked_at)}<div class="sub">${escapeHtml((row.response_hash ?? "no body").slice(0, 16))}</div></td>
<td>${row.contract.notes.map((note) => `<div>${escapeHtml(note)}</div>`).join("")}${row.change?.detail && row.change.kind !== "first" ? `<div class="sub">${escapeHtml(row.change.detail)}</div>` : ""}</td>
</tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(meta.title ?? "RankProof link verification")}</title>
<style>
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#18181b;margin:32px;background:#fafaf9}
h1{font-size:22px;margin:0 0 4px}.meta{color:#71717a;margin:0 0 20px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}.card{background:#fff;border:1px solid #e4e4e7;border-radius:10px;padding:10px 14px;min-width:120px}
.card b{display:block;font-size:22px}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e4e4e7}
th,td{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid #f0f0f0}th{font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:.04em}
.pill{display:inline-block;border-radius:999px;padding:2px 8px;font-weight:600;font-size:12px;color:var(--c);background:color-mix(in srgb,var(--c) 12%,white)}
.sub{color:#71717a;font-size:12px;margin-top:2px}.ctx{color:#3f3f46;font-size:12px;margin-top:4px;font-style:italic;max-width:46ch}.mono{font-family:ui-monospace,monospace;font-size:12px}a{color:inherit;word-break:break-all}
footer{color:#71717a;font-size:12px;margin-top:16px}
</style></head><body>
<h1>${escapeHtml(meta.title ?? "Link verification report")}</h1>
<p class="meta">Generated ${escapeHtml(generatedAt)} · contract policy ${CONTRACT_POLICY} · ${summary.total} pairs</p>
<div class="cards">
<div class="card"><b>${summary.meets}</b>meet the contract</div>
<div class="card"><b>${summary.deviates}</b>deviate</div>
<div class="card"><b>${summary.missing}</b>not in fetched HTML</div>
<div class="card"><b>${summary.unverified}</b>unverified (errors)</div>
<div class="card"><b>${summary.changed}</b>changed since last run</div>
</div>
<table><thead><tr><th>Result</th><th>Source → target</th><th>Anchor</th><th>rel</th><th>Observed</th><th>Notes</th></tr></thead>
<tbody>${body}</tbody></table>
<footer>"Not in HTML" is scoped to the fetched HTML; JavaScript-inserted links are not rendered. "Unverified" means the page could not be observed and is not evidence of a missing link. Generated by RankProof.</footer>
</body></html>`;
}
