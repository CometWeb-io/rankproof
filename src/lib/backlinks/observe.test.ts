import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareObservations,
  evaluateContract,
  parsePairTable,
  relSatisfies,
  summarize,
  verifiedRowsCsv,
  verifiedRowsHtml,
  verifiedRowsMarkdown,
  type ObservationLike,
  type VerifiedRow,
} from "./observe.ts";

const base: ObservationLike = {
  source_url: "https://pub.example/a",
  target_url: "https://brand.example/guide",
  status: "confirmed",
  checked_at: "2026-11-01T10:00:00.000Z",
  anchor: "Brand guide",
  rel: "",
  reason: null,
  resolved_href: "https://brand.example/guide",
};

test("rel semantics: follow means no qualifying token", () => {
  assert.equal(relSatisfies("follow", ""), true);
  assert.equal(relSatisfies("follow", "noopener noreferrer"), true);
  assert.equal(relSatisfies("follow", "nofollow"), false);
  assert.equal(relSatisfies("follow", "UGC"), false);
  assert.equal(relSatisfies("sponsored", "nofollow sponsored"), true);
  assert.equal(relSatisfies("nofollow", "sponsored"), false);
});

test("contract: anchor scoped rel, multiple anchors, unspecified expectations", () => {
  const observation: ObservationLike = {
    ...base,
    matching_anchors: [
      { raw_href: "", resolved_href: "", anchor: "logo", rel: "nofollow" },
      { raw_href: "", resolved_href: "", anchor: "Brand guide", rel: "" },
    ],
  };
  const meets = evaluateContract(observation, {
    expected_anchor: "brand GUIDE",
    expected_rel: "follow",
  });
  assert.equal(meets.verdict, "meets");
  // The rel clause is judged on the anchor named in the contract, not on the logo.
  const deviates = evaluateContract(observation, {
    expected_anchor: "logo",
    expected_rel: "follow",
  });
  assert.equal(deviates.verdict, "deviates");
  assert.equal(deviates.anchor, "match");
  assert.equal(deviates.rel, "mismatch");
  const open = evaluateContract(observation);
  assert.equal(open.verdict, "meets");
  assert.equal(open.anchor, "unspecified");
  assert.ok(open.notes.some((note) => note.includes("2 anchors")));
});

test("change detection never turns a failed run into a lost link", () => {
  const notFound: ObservationLike = {
    ...base,
    status: "not_found",
    anchor: null,
    absence_scope: "fetched_html",
  };
  const error: ObservationLike = { ...base, status: "error", anchor: null, reason: "timeout" };
  assert.equal(compareObservations(null, base).kind, "first");
  assert.equal(compareObservations(base, base).kind, "unchanged");
  assert.equal(compareObservations(base, error).kind, "became_unverified");
  assert.equal(compareObservations(error, error).kind, "still_unverified");
  assert.equal(compareObservations(error, base).kind, "verified_again");
  assert.equal(compareObservations(base, notFound).kind, "missing_in_representation");
  assert.equal(
    compareObservations(base, { ...notFound, absence_scope: "http_resource" }).kind,
    "source_gone",
  );
  assert.equal(compareObservations(notFound, base).kind, "appeared");
  // A page that already lacked the link and now 404s is gone, not unchanged.
  const gone = compareObservations(notFound, { ...notFound, absence_scope: "http_resource" });
  assert.equal(gone.kind, "source_gone");
  assert.match(gone.detail, /already missing/);
  assert.equal(
    compareObservations(
      { ...notFound, absence_scope: "http_resource" },
      { ...notFound, absence_scope: "http_resource" },
    ).kind,
    "unchanged",
  );
  const changed = compareObservations(base, { ...base, rel: "sponsored" });
  assert.equal(changed.kind, "changed_detail");
  assert.match(changed.detail, /rel gained sponsored/);
  // rel token order is not a change.
  assert.equal(
    compareObservations({ ...base, rel: "nofollow ugc" }, { ...base, rel: "ugc nofollow" }).kind,
    "unchanged",
  );
});

test("pair tables: delimiters, quotes, headers, duplicates and line-numbered errors", () => {
  const csv = [
    "\uFEFFtarget,source,anchor,rel",
    'https://brand.example/,https://pub.example/a,"Brand, Inc.",sponsored',
    'https://brand.example/,https://pub.example/a#x,"Brand, Inc.",sponsored',
    "https://brand.example/,not a url,,",
    "https://brand.example/,https://pub.example/b,,dofollow",
    "https://brand.example/,https://pub.example/c,,maybe",
    "https://brand.example/,https://pub.example/a,Other,nofollow",
  ].join("\n");
  const table = parsePairTable(csv);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0]!.source_url, "https://pub.example/a");
  assert.equal(table.rows[0]!.expected_anchor, "Brand, Inc.");
  assert.equal(table.rows[0]!.expected_rel, "sponsored");
  assert.equal(table.rows[1]!.expected_rel, "follow");
  assert.equal(table.duplicates, 1);
  assert.deepEqual(
    table.errors.map((e) => e.line),
    [4, 6, 7],
  );
  assert.match(table.errors[2]!.message, /line 2 with different expectations/);
  const semi = parsePairTable("https://a.example/x;https://b.example/;Anchor;nofollow\n# comment");
  assert.equal(semi.rows[0]!.expected_anchor, "Anchor");
  const tabs = parsePairTable("https://a.example/x\thttps://b.example/");
  assert.equal(tabs.rows.length, 1);
});

test("exports neutralise formulas and escape HTML", () => {
  const row: VerifiedRow = {
    ...base,
    anchor: '=HYPERLINK("http://evil")',
    expected_anchor: "<script>x</script>",
    contract: evaluateContract(base, { expected_anchor: "<script>x</script>" }),
    change: null,
  };
  const csv = verifiedRowsCsv([row]);
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`));
  const html = verifiedRowsHtml([row]);
  assert.ok(!html.includes("<script>x</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.equal(summarize([row]).deviates, 1);
});

test("markdown report puts untrusted values in code spans; HTML links only http(s)", () => {
  const hostile = "javascript:alert(1)";
  const row: VerifiedRow = {
    ...base,
    source_url: hostile,
    target_url: "https://brand.example/[x](https://evil.example) <img src=x> @team `tick` a|b",
    contract: evaluateContract(base),
    change: null,
  };
  const md = verifiedRowsMarkdown([row]);
  const cells = md.split("\n").at(-1)!;
  // Each untrusted cell is a code span: links, images, HTML and mentions are inert.
  assert.ok(cells.includes("` javascript:alert(1) `"));
  assert.ok(
    cells.includes(
      "`` https://brand.example/[x](https://evil.example) <img src=x> @team `tick` a\\|b ``",
    ),
    cells,
  );
  assert.equal(cells.split(/(?<!\\)\|/).length, 6, "pipes inside a value do not split cells");
  const html = verifiedRowsHtml([row]);
  assert.ok(!html.includes('href="javascript:'), "no link for a non-http(s) URL");
  assert.ok(html.includes(">javascript:alert(1)<"));
  const ok = verifiedRowsHtml([{ ...row, source_url: "https://pub.example/a" }]);
  assert.ok(ok.includes('<a href="https://pub.example/a" rel="nofollow noopener">'));
});

test("placement: unknown regions are unobserved, and only comparable runs count as a move", () => {
  const unknown = evaluateContract(
    {
      ...base,
      placement: "unknown",
      matching_anchors: [
        { raw_href: "", resolved_href: "", anchor: "Brand guide", rel: "", placement: "unknown" },
      ],
    },
    { expected_placement: "content" },
  );
  assert.equal(unknown.placement, "unobserved");
  assert.equal(unknown.verdict, "meets", "an unobservable clause is not a deviation");
  // A run saved before placement existed is not a move.
  assert.equal(compareObservations(base, { ...base, placement: "footer" }).kind, "unchanged");
  const moved = compareObservations(
    { ...base, placement: "content" },
    { ...base, placement: "footer" },
  );
  assert.equal(moved.kind, "changed_detail");
  assert.match(moved.detail, /moved from content to footer/);
  const table = parsePairTable(
    "https://a.example/x,https://b.example/,,follow,in-content\nhttps://a.example/y,https://b.example/,,,top",
  );
  assert.equal(table.rows[0]!.expected_placement, "content");
  assert.equal(table.errors[0]!.line, 2);
});
