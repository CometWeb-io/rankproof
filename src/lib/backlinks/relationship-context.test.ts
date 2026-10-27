import assert from "node:assert/strict";
import { test } from "node:test";
import { observeBacklinkResponse } from "./evidence-response.ts";
import {
  compareRelationship,
  relationshipObservation,
  relationshipComparable,
} from "./relationships.ts";

const pair = {
  source_url: "https://publisher.example/article",
  target_url: "https://brand.example/offer",
};
const response = (text: string) => ({
  status: 200,
  text,
  finalUrl: pair.source_url,
  contentType: "text/html",
  truncated: false,
});
const context = { checkedAt: "2026-10-27T00:00:00.000Z", sourceRevision: "context-test" };
const inspect = (html: string, at = context.checkedAt) =>
  observeBacklinkResponse(
    pair,
    response(html),
    { ...context, checkedAt: at },
    { relationshipContext: true },
  );

test("relationship excerpts are opt-in, bounded parser text tied to the first matching anchor", () => {
  const html =
    '<html><head><script>secret script text</script></head><body><p>Offer appears here first but is not the link.</p><main>Actual editorial context <a href="https://brand.example/offer">Offer</a> after this link.</main><footer><a href="https://brand.example/offer">Other</a></footer></body></html>';
  assert.equal(
    observeBacklinkResponse(pair, response(html), context).relationship_context,
    undefined,
  );
  const observed = inspect(html);
  assert.equal(observed.status, "confirmed");
  const detail = observed.relationship_context!;
  assert.equal(detail.version, "html-relationship-context-v1");
  assert.equal(detail.primary_match, "first_matching_html_anchor");
  assert.equal(detail.matching_anchor_count, 2);
  assert.equal(detail.placement, "content");
  assert.equal(detail.placement_is_heuristic, true);
  assert.equal(detail.link_kind, "text");
  assert.ok(typeof detail.excerpt === "string");
  assert.ok(typeof detail.excerpt_hash === "string");
  assert.match(detail.excerpt, /Actual editorial context Offer after this link/);
  assert.doesNotMatch(detail.excerpt, /secret script|<a|<main/);
  assert.ok(detail.excerpt.length <= 400);
  assert.match(detail.excerpt_hash, /^[a-f0-9]{64}$/);
  assert.equal(inspect("<html><body>Missing</body></html>").relationship_context, undefined);
  assert.equal(
    inspect("<html><title>Access denied</title></html>").relationship_context,
    undefined,
  );
});

test("relationship context compares only matching extraction versions and never fabricates missing metadata", () => {
  const first = relationshipObservation(
    inspect(
      '<html><body><main>Original context <a href="https://brand.example/offer">Offer</a></main></body></html>',
    ),
  );
  const next = relationshipObservation(
    inspect(
      '<html><body><footer>Changed context <a href="https://brand.example/offer">Offer</a></footer></body></html>',
      "2026-10-27T01:00:00.000Z",
    ),
  );
  const changed = compareRelationship([first, next]);
  assert.equal(changed.change, "attributes_changed");
  assert.equal(changed.previousEvidence?.placement, "content");
  assert.equal(changed.currentEvidence?.placement, "footer");
  assert.notEqual(changed.previousEvidence?.contextHash, changed.currentEvidence?.contextHash);
  assert.equal(
    compareRelationship([
      {
        ...first,
        attributeExtractionVersion: undefined,
        placement: undefined,
        contextHash: undefined,
      },
      next,
    ]).change,
    null,
  );
  assert.equal(
    compareRelationship([first, { ...next, attributeExtractionVersion: "future-version" }]).change,
    null,
  );
  assert.equal(compareRelationship([first, { ...next, status: "UNKNOWN" }]).change, null);
  for (const version of [undefined, "", "unknown-method"]) {
    assert.equal(
      compareRelationship([
        { ...first, attributeExtractionVersion: version },
        { ...next, attributeExtractionVersion: version },
      ]).change,
      null,
    );
  }
});

test("long context and image anchors remain bounded and separate from indexability", () => {
  const observed = inspect(
    `<html><body><main>${"Before ".repeat(200)}<a href="https://brand.example/offer"><img alt="Offer" src="/offer.png"></a>${"After ".repeat(200)}</main></body></html>`,
  );
  assert.equal(observed.relationship_context?.link_kind, "image");
  assert.ok((observed.relationship_context?.excerpt?.length ?? Infinity) <= 400);
  assert.equal("indexable" in observed.relationship_context!, false);
});

test("resource comparability needs a known later matching method and final resource", () => {
  const html = '<html><body><a href="https://brand.example/offer">Offer</a></body></html>';
  const before = relationshipObservation(inspect(html));
  const after = { ...before, observedAt: "2026-10-27T01:00:00.000Z" };
  assert.equal(relationshipComparable(before, after), true);
  for (const changed of [
    { ...after, observedAt: before.observedAt },
    { ...after, resolvedSourceUrl: null },
    { ...after, resolvedSourceUrl: "https://publisher.example/different" },
    { ...after, extractionVersion: "different" },
    { ...after, identityPolicy: "different" },
    { ...after, representation: "rendered_dom" as const },
  ])
    assert.equal(relationshipComparable(before, changed), false);
  assert.equal(
    relationshipComparable(
      { ...before, resolvedSourceUrl: null },
      { ...after, resolvedSourceUrl: null },
    ),
    false,
  );
  assert.equal(
    relationshipComparable(
      { ...before, extractionVersion: "" },
      { ...after, extractionVersion: "" },
    ),
    false,
  );
  assert.equal(
    relationshipComparable({ ...before, identityPolicy: " " }, { ...after, identityPolicy: " " }),
    false,
  );
});
