import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { verifyBacklinks } from "./verify-api.server.ts";
import { clearNetCache, setHostResolverForTests } from "./net.server.ts";
import { clearRobotsCache } from "./robots.server.ts";

const originalFetch = globalThis.fetch;
setHostResolverForTests(async () => ["93.184.216.34"]);
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearNetCache();
  clearRobotsCache();
});
const source_url = "https://source.example/post";
const target_url = "https://target.example/offer?utm_source=x&a=1";
const body = (source = source_url, target = target_url) => ({
  items: [{ source_url: source, target_url: target }],
});
function page(html: string, status = 200, type = "text/html") {
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    return new Response(html, { status, headers: { "content-type": type } });
  };
  return calls;
}

test("validates the complete batch before any network requests", async () => {
  const calls = page("<html></html>");
  for (const input of [
    null,
    [],
    {},
    { items: [] },
    { items: Array(51).fill(body().items[0]) },
    { items: [body().items[0], { source_url: "file:///etc/passwd", target_url }] },
    body("http://127.0.0.1/"),
    body(source_url, "https://user:pass@target.example/"),
    body(source_url, "https://target.example/\nfoo"),
  ]) {
    await assert.rejects(() => verifyBacklinks(input));
  }
  assert.deepEqual(calls, []);
});

test("confirms exact URL including query, ignores fragment, and returns bounded evidence", async () => {
  page(
    `<html><body><a rel='nofollow ugc' href='${target_url.replace("&", "&amp;")}#details'>Our offer</a></body></html>`,
  );
  const result = await verifyBacklinks(body());
  assert.equal(result.schema_version, "1");
  const observation = result.results[0]!;
  assert.equal(observation.evidence_kind, "html_anchor");
  assert.equal(observation.observation_method, "fetched_html");
  assert.equal(observation.absence_scope, null);
  assert.match(observation.response_hash!, /^[a-f0-9]{64}$/);
  assert.equal(observation.resolved_href, `${target_url}#details`);
  assert.equal(observation.matching_anchors.length, 1);
  const {
    evidence_kind,
    observation_method,
    absence_scope,
    extraction_version,
    identity_policy,
    source_revision,
    response_hash,
    raw_href,
    resolved_href,
    matching_anchors,
    near_matches,
    contract,
    placement,
    context,
    mentions,
    rendered,
    ...legacy
  } = observation;
  void [
    near_matches,
    contract,
    placement,
    context,
    mentions,
    rendered,
    evidence_kind,
    observation_method,
    absence_scope,
    extraction_version,
    identity_policy,
    source_revision,
    response_hash,
    raw_href,
    resolved_href,
    matching_anchors,
  ];
  assert.deepEqual(legacy, {
    source_url,
    target_url,
    status: "confirmed",
    checked_at: result.results[0]!.checked_at,
    final_url: source_url,
    http_status: 200,
    anchor: "Our offer",
    rel: "nofollow ugc",
    reason: null,
  });
  assert.ok(Number.isFinite(Date.parse(result.results[0]!.checked_at)));
});

test("same host, alternate path/query/protocol/www and redirect wrapper are not exact matches", async () => {
  for (const href of [
    "https://target.example/",
    "https://target.example/offer?a=1",
    "http://target.example/offer?utm_source=x&a=1",
    "https://www.target.example/offer?utm_source=x&a=1",
    `https://other.example/redirect?url=${encodeURIComponent(target_url)}`,
  ]) {
    page(`<html><body><a href='${href}'>link</a></body></html>`);
    assert.equal((await verifyBacklinks(body())).results[0]!.status, "not_found", href);
  }
});

test("uses source redirect and HTML base to resolve real anchor attributes", async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    if (url === source_url)
      return new Response("", { status: 302, headers: { location: "/moved" } });
    return new Response(
      `<html><head><base href="https://target.example/"></head><body><a href="offer?utm_source=x&amp;a=1">link</a></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  };
  const [result] = (await verifyBacklinks(body())).results;
  assert.equal(result!.status, "confirmed");
  assert.equal(result!.final_url, "https://source.example/moved");
});

test("comments/scripts/templates and data-href never count as an observed anchor", async () => {
  page(
    `<html><body><!-- <a href='${target_url}'>fake</a> --><script>var x="<a href='${target_url}'>fake</a>";</script><template><a href='${target_url}'>fake</a></template><p>Real article text</p><a data-href='${target_url}'>fake</a></body></html>`,
  );
  assert.equal((await verifyBacklinks(body())).results[0]!.status, "not_found");
});

test("fetches fresh source HTML on repeated verification", async () => {
  const calls = page(`<html><a href='${target_url}'>link</a></html>`);
  assert.equal((await verifyBacklinks(body())).results[0]!.status, "confirmed");
  page("<html><body>Link removed</body></html>");
  assert.equal((await verifyBacklinks(body())).results[0]!.status, "not_found");
  assert.ok(calls.includes(source_url));
});

test("blocked/challenged/non-HTML/empty/script-only/oversized pages are errors, not missing links", async () => {
  for (const [html, status, type] of [
    ["<html><body>denied</body></html>", 403, "text/html"],
    [
      "<html><title>Just a moment...</title><script src='/cdn-cgi/challenge-platform/a'></script></html>",
      200,
      "text/html",
    ],
    ["<html>Enable JavaScript and cookies to continue</html>", 200, "text/html"],
    ["%PDF content", 200, "application/pdf"],
    ["", 200, "text/html"],
    [
      "<html><body><div id='root'></div><script src='/app.js'></script></body></html>",
      200,
      "text/html",
    ],
    [`<html><body>${"x".repeat(2_100_000)}</body></html>`, 200, "text/html"],
    ["<html>failure</html>", 503, "text/html"],
  ] as const) {
    page(html, status, type);
    const result = (await verifyBacklinks(body())).results[0]!;
    assert.equal(result.status, "error", `${status} ${type} ${html.slice(0, 60)}`);
    assert.ok(result.reason);
  }
});

test("404 and 410 are missing, even if the error template includes the target", async () => {
  for (const status of [404, 410]) {
    page(`<html><a href='${target_url}'>template</a></html>`, status);
    assert.equal((await verifyBacklinks(body())).results[0]!.status, "not_found");
  }
});

test("robots refusal and redirects to private addresses stay errors without fetching forbidden pages", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /blocked");
    return new Response("", { status: 302, headers: { location: "http://127.0.0.1/secret" } });
  };
  const blocked = (await verifyBacklinks(body("https://source.example/blocked"))).results[0]!;
  assert.equal(blocked.status, "error");
  assert.match(blocked.reason!, /robots/i);
  assert.equal((await verifyBacklinks(body())).results[0]!.status, "error");
  assert.ok(!calls.some((u) => u.includes("127.0.0.1") || u.endsWith("/blocked")));
});

test("redirects respect robots at the destination too", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://other.example/robots.txt")
      return new Response("User-agent: *\nDisallow: /");
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    return new Response("", {
      status: 302,
      headers: { location: "https://other.example/blocked" },
    });
  };
  assert.equal((await verifyBacklinks(body())).results[0]!.status, "error");
  assert.ok(!calls.includes("https://other.example/blocked"));
});

test("network and DNS failures produce individual errors while preserving batch ordering", async () => {
  globalThis.fetch = async () => {
    throw new Error("network unavailable");
  };
  const result = await verifyBacklinks({
    items: [body().items[0], body("https://other.example/p").items[0]],
  });
  assert.deepEqual(
    result.results.map((r) => r.source_url),
    [source_url, "https://other.example/p"],
  );
  assert.ok(result.results.every((r) => r.status === "error" && r.http_status === null));
});

test("nested inert markup and raw-text elements never manufacture anchor evidence", async () => {
  for (const html of [
    `<html><body><template><template>inner</template><a href='${target_url}'>fake</a></template><p>Article</p></body></html>`,
    `<html><head><title><a href='${target_url}'>fake</a></title></head><body>Article</body></html>`,
    `<html><body><textarea><a href='${target_url}'>fake</a></textarea><p>Article</p></body></html>`,
  ]) {
    page(html);
    assert.equal((await verifyBacklinks(body())).results[0]!.status, "not_found");
  }
});

test("exact comparison does not decode HTML entities a second time", async () => {
  page(`<html><body><a href='https://target.example/offer?ref=&amp;amp;'>link</a></body></html>`);
  assert.equal(
    (await verifyBacklinks(body(source_url, "https://target.example/offer?ref=&"))).results[0]!
      .status,
    "not_found",
  );
});

test("quoted tag-looking text and custom a-* tags never fabricate anchors", async () => {
  for (const html of [
    `<div data-preview="<a href='${target_url}'>fake</a>">Article</div>`,
    `<a-card href='${target_url}'>Card</a-card><p>Article</p>`,
  ]) {
    page(html);
    assert.equal((await verifyBacklinks(body())).results[0]!.status, "not_found");
  }
});

test("empty and fragment-only href resolve against the document base", async () => {
  for (const href of ["", "#details"]) {
    page(
      `<head><base href='${target_url.replace("&", "&amp;")}'></head><a href='${href}'>Details</a>`,
    );
    assert.equal((await verifyBacklinks(body())).results[0]!.status, "confirmed");
  }
});

test("first base with href wins after a target-only base", async () => {
  page(
    `<head><base target='_blank'><base href='https://target.example/'></head><a href='offer?utm_source=x&amp;a=1'>Offer</a>`,
  );
  assert.equal((await verifyBacklinks(body())).results[0]!.status, "confirmed");
});

test("unterminated adversarial markup returns error without blocking the event loop", async () => {
  page(`<p>Article</p>${"<a ".repeat(30000)}`);
  const start = performance.now();
  assert.equal((await verifyBacklinks(body())).results[0]!.status, "error");
  assert.ok(
    performance.now() - start < 1000,
    "90KB malformed HTML must have bounded linear parsing cost",
  );
});

test("same registrable-domain pairs produce individual errors before any fetch", async () => {
  const calls = page("<html><body>Internal</body></html>");
  for (const [source, target] of [
    ["https://blog.target.example/post", "https://www.target.example/offer"],
    ["https://publisher.co.uk/post", "https://shop.publisher.co.uk/offer"],
    ["https://target.example/a", "http://target.example/b"],
  ]) {
    const observation = (await verifyBacklinks(body(source, target))).results[0]!;
    assert.equal(observation.status, "error");
    assert.match(observation.reason!, /Source belongs to target site/);
    assert.equal(observation.http_status, null);
  }
  assert.deepEqual(calls, []);
});

test("source redirect onto the target site cannot confirm an internal link", async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    if (url === source_url)
      return new Response("", {
        status: 302,
        headers: { location: "https://blog.target.example/post" },
      });
    return new Response(`<html><a href='${target_url}'>Internal</a></html>`, {
      headers: { "content-type": "text/html" },
    });
  };
  const observation = (await verifyBacklinks(body())).results[0]!;
  assert.equal(observation.status, "error");
  assert.match(observation.reason!, /internal link/);
  assert.equal(observation.anchor, null);
});

test("Unicode case expansion before visible and raw-text tags preserves anchor offsets", async () => {
  for (const prefix of [
    "<p>İstanbul</p>",
    "<script>const city = 'İstanbul';</script>",
    "<title>İstanbul guide</title><p>İ</p><script>let x='İ'</script>",
  ]) {
    page(`${prefix}<a href='${target_url}'>Offer</a>`);
    assert.equal((await verifyBacklinks(body())).results[0]!.status, "confirmed");
  }
});

test("ordinary challenge phrases in article text, attributes, comments and script examples do not block a backlink", async () => {
  for (const prefix of [
    "<p>How to fix Access Denied errors</p>",
    "<p>Just a moment of attention required to read this guide.</p>",
    "<div data-example='Access Denied'>Article</div><!-- Just a moment --><script>const example='Attention Required'</script>",
  ]) {
    page(`${prefix}<a href='${target_url}'>Offer</a>`);
    assert.equal((await verifyBacklinks(body())).results[0]!.status, "confirmed");
  }
});

test("generic challenge titles still produce errors", async () => {
  for (const title of ["Access Denied", "Just a moment...", "Attention Required!"]) {
    page(`<head><title>${title}</title></head><body>Challenge</body>`);
    assert.equal((await verifyBacklinks(body())).results[0]!.status, "error");
  }
});

test("internal semantic refusal does not poison valid items in the same batch", async () => {
  const calls = page(`<html><a href='${target_url}'>Offer</a></html>`);
  const internal = { source_url: "https://blog.target.example/post", target_url };
  const result = await verifyBacklinks({ items: [body().items[0], internal] });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.results.map((item) => item.status),
    ["confirmed", "error"],
  );
  assert.equal(result.results[1]!.source_url, internal.source_url);
  assert.match(result.results[1]!.reason!, /Source belongs to target site/);
  assert.ok(calls.includes(source_url));
  assert.ok(!calls.some((url) => url.includes("blog.target.example")));
});

/* ------------------------- link contract & evidence ------------------------ */

test("evaluates the expected anchor and rel against the confirmed anchors", async () => {
  page(
    `<html><body><p>Read <a rel="sponsored" href="${target_url.replace("&", "&amp;")}">our   OFFER</a></p></body></html>`,
  );
  const [ok] = (
    await verifyBacklinks({
      items: [{ source_url, target_url, expected_anchor: "Our offer", expected_rel: "sponsored" }],
    })
  ).results;
  assert.equal(ok!.contract.verdict, "meets");
  assert.equal(ok!.contract.anchor, "match", "case and whitespace are folded");
  assert.equal(ok!.expected_rel, "sponsored");

  const [bad] = (
    await verifyBacklinks({ items: [{ source_url, target_url, expected_rel: "follow" }] })
  ).results;
  assert.equal(bad!.contract.verdict, "deviates");
  assert.equal(bad!.contract.rel, "mismatch");
  assert.equal(bad!.contract.anchor, "unspecified");
});

test("rejects malformed expectations before any I/O", async () => {
  const calls = page("<html></html>");
  await assert.rejects(() =>
    verifyBacklinks({ items: [{ source_url, target_url, expected_rel: "dofollowish" }] }),
  );
  await assert.rejects(() =>
    verifyBacklinks({ items: [{ source_url, target_url, expected_anchor: "x".repeat(501) }] }),
  );
  assert.deepEqual(calls, []);
});

test("reports same-site links to a different URL as near matches, not confirmations", async () => {
  page(
    `<html><body><a href="http://target.example/offer?utm_source=x&amp;a=1">offer</a><a href="https://target.example/">home</a></body></html>`,
  );
  const [result] = (await verifyBacklinks(body())).results;
  assert.equal(result!.status, "not_found");
  assert.equal(result!.near_matches.length, 2);
  assert.match(result!.near_matches[0]!.difference, /protocol http/);
  assert.equal(result!.contract.target, "near");
  assert.equal(result!.contract.verdict, "missing");
});

test("an error stays unverified and never becomes a missing link", async () => {
  page("busy", 503);
  const [result] = (await verifyBacklinks(body())).results;
  assert.equal(result!.status, "error");
  assert.equal(result!.contract.verdict, "unverified");
  assert.equal(result!.near_matches.length, 0);
});

test("captured HTML replays offline to the same observation", async () => {
  const { observeRepresentation } = await import("./verify-api.server.ts");
  page(`<html><body><a href="${target_url.replace("&", "&amp;")}">Our offer</a></body></html>`);
  const captured: {
    body: string;
    final_url: string;
    http_status: number;
    content_type: string;
    response_hash: string;
  }[] = [];
  const [live] = (await verifyBacklinks(body(), { capture: (item) => captured.push(item) }))
    .results;
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.response_hash, live!.response_hash);
  const replayed = observeRepresentation(
    { source_url, target_url },
    {
      text: captured[0]!.body,
      finalUrl: captured[0]!.final_url,
      status: captured[0]!.http_status,
      contentType: captured[0]!.content_type,
      checkedAt: live!.checked_at,
    },
  );
  assert.equal(replayed.status, live!.status);
  assert.equal(replayed.anchor, live!.anchor);
  assert.equal(replayed.response_hash, live!.response_hash);
});

test("records placement and surrounding text; checks expected placement", async () => {
  const href = target_url.replace("&", "&amp;");
  page(
    `<html><body><nav><a href="/">Home</a></nav><article><p>We tested five stoves. The one from <a href="${href}">Our offer</a> boiled water fastest in wind.</p></article><footer><a href="${href}">partner</a></footer></body></html>`,
  );
  const [content] = (
    await verifyBacklinks({
      items: [
        { source_url, target_url, expected_anchor: "Our offer", expected_placement: "content" },
      ],
    })
  ).results;
  assert.equal(content!.placement, "content");
  assert.match(content!.context!, /The one from Our offer boiled water fastest/);
  assert.ok(!content!.context!.includes("<"), "context never contains markup");
  assert.equal(content!.contract.placement, "match");
  assert.deepEqual(
    content!.matching_anchors.map((a) => a.placement),
    ["content", "footer"],
  );

  // The agreed anchor sits only in the footer: placement deviates.
  const [footer] = (
    await verifyBacklinks({
      items: [
        { source_url, target_url, expected_anchor: "partner", expected_placement: "content" },
      ],
    })
  ).results;
  assert.equal(footer!.contract.verdict, "deviates");
  assert.equal(footer!.contract.placement, "mismatch");
  await assert.rejects(() =>
    verifyBacklinks({ items: [{ source_url, target_url, expected_placement: "header-ish" }] }),
  );
});

test("a missing link that is mentioned as plain text is flagged", async () => {
  page(`<html><body><p>We liked the stoves at target.example a lot.</p></body></html>`);
  const [result] = (await verifyBacklinks(body())).results;
  assert.equal(result!.status, "not_found");
  assert.equal(result!.mentions[0]!.term, "target.example");
  assert.match(result!.mentions[0]!.snippet, /stoves at target\.example/);
  assert.equal(result!.contract.mentioned, true);
});

test("text inside another link is not a plain mention", async () => {
  page(
    `<html><body><p>Visit <a href="https://target.example/">target.example</a></p></body></html>`,
  );
  const [result] = (await verifyBacklinks(body())).results;
  assert.equal(result!.status, "not_found");
  assert.deepEqual(result!.mentions, []);
  assert.equal(result!.contract.mentioned, false);
  assert.equal(result!.contract.target, "near");
});

test("hostile markup cannot make mention extraction quadratic", async () => {
  // Many unclosed <a> openers and a long run of bare `<` without `>`: the old
  // regex pipeline backtracked over the whole tail for every opener.
  const html = `<html><body><p>We liked target.example.</p>${"<a x>".repeat(60_000)}${"<".repeat(1_500_000)}</body></html>`;
  page(html);
  const started = performance.now();
  const [result] = (await verifyBacklinks(body())).results;
  const elapsed = performance.now() - started;
  assert.equal(result!.status, "not_found");
  assert.equal(result!.mentions[0]!.term, "target.example");
  assert.ok(elapsed < 1000, `mention extraction took ${Math.round(elapsed)} ms`);
});
