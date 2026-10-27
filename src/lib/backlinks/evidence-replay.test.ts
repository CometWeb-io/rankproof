import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { captureBacklinks, captureHash } from "./evidence-capture.server.ts";
import { replayEvidenceCapture } from "./evidence-replay.ts";
import { verifyBacklinks } from "./verify-api.server.ts";
import { clearNetCache, setHostResolverForTests } from "./net.server.ts";
import { clearRobotsCache } from "./robots.server.ts";
import { responseHash } from "./measurement.server.ts";

const originalFetch = globalThis.fetch;
setHostResolverForTests(async () => ["93.184.216.34"]);
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearNetCache();
  clearRobotsCache();
});
const pair = {
  source_url: "https://publisher.example/article",
  target_url: "https://target.example/Offer?sku=A&ref=keep",
};
const html =
  '<!doctype html><html><head><title>Żółć 日本語</title></head><body><a href="https://target.example/Offer?sku=A&amp;ref=keep#details" rel="nofollow">Oferta 日本語</a></body></html>';
function serve(text = html, headers: Record<string, string> = {}) {
  globalThis.fetch = async (input) =>
    String(input).endsWith("/robots.txt")
      ? new Response("", { status: 404 })
      : new Response(text, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}
function reseal<T extends { root_hash: string }>(value: T): T {
  const { root_hash: _old, ...content } = value;
  value.root_hash = captureHash(content);
  return value;
}

test("explicit capture retains bounded decoded HTML and replays identical evidence without network", async () => {
  serve();
  const { verification, capture } = await captureBacklinks({ items: [pair] });
  assert.equal(verification.results[0]!.status, "confirmed");
  assert.equal(capture.entries.length, 1);
  assert.equal(capture.entries[0]!.response.decoded_utf8_bytes, Buffer.byteLength(html, "utf8"));
  assert.equal(capture.entries[0]!.response.body_sha256, responseHash(html));
  globalThis.fetch = async () => {
    throw new Error("Replay must not use network");
  };
  const replay = replayEvidenceCapture(JSON.parse(JSON.stringify(capture)));
  assert.deepEqual(replay.results, verification.results);
  assert.equal(Object.isFrozen(capture.entries[0]!.response), true);
  assert.ok(capture.total_bytes <= capture.limits.max_total_bytes);
  assert.equal(capture.total_bytes, Buffer.byteLength(JSON.stringify(capture), "utf8"));
});

test("default verifier retains v1 response contract without capture bodies", async () => {
  serve();
  const result = await verifyBacklinks({ items: [pair] });
  assert.equal("capture" in result, false);
  assert.equal(JSON.stringify(result).includes("<!doctype"), false);
});

test("body mutation, rehashed changed extraction, and unknown method versions fail closed", async () => {
  serve();
  const { capture } = await captureBacklinks({ items: [pair] });
  const altered = structuredClone(capture);
  altered.entries[0]!.response.text = html.replace("Oferta", "Change");
  assert.throws(() => replayEvidenceCapture(altered), /integrity|hash/i);
  altered.entries[0]!.response.body_sha256 = responseHash(altered.entries[0]!.response.text);
  altered.entries[0]!.response.decoded_utf8_bytes = Buffer.byteLength(
    altered.entries[0]!.response.text,
    "utf8",
  );
  altered.entries[0]!.observation.response_hash = altered.entries[0]!.response.body_sha256;
  altered.entries[0]!.id = captureHash({
    index: altered.entries[0]!.index,
    request: altered.entries[0]!.request,
    response: altered.entries[0]!.response,
    observation: altered.entries[0]!.observation,
  });
  reseal(altered);
  assert.throws(() => replayEvidenceCapture(altered), /reproduce|observation/i);
  const wrong = structuredClone(capture);
  wrong.extraction_version = "unknown-future-extractor";
  reseal(wrong);
  assert.throws(() => replayEvidenceCapture(wrong), /method|version/i);
});

test("sensitive responses and token URLs are omitted without leaking headers or credentials", async () => {
  const sensitiveHeaders: Record<string, string>[] = [
    { "set-cookie": "session=do-not-export" },
    { "cache-control": "private" },
    { vary: "Cookie" },
  ];
  for (const headers of sensitiveHeaders) {
    serve(html, headers);
    const { capture } = await captureBacklinks({ items: [pair] });
    assert.equal(capture.entries.length, 0);
    assert.equal(capture.omitted[0]!.reason, "sensitive_response");
    assert.equal(JSON.stringify(capture).includes("do-not-export"), false);
  }
  serve();
  const { capture } = await captureBacklinks({
    items: [{ ...pair, source_url: pair.source_url + "?token=do-not-export" }],
  });
  assert.equal(capture.entries.length, 0);
  assert.equal(JSON.stringify(capture).includes("do-not-export"), false);
});

test("capture cap omits whole bodies; incomplete and challenge evidence never replay as confirmed", async () => {
  serve(html + "<!--" + "padding".repeat(4000) + "-->");
  const limited = await captureBacklinks({ items: [pair] }, { maxTotalBytes: 16384 });
  assert.equal(limited.capture.entries.length, 0);
  assert.equal(limited.capture.omitted[0]!.reason, "total_limit");
  assert.ok(Buffer.byteLength(JSON.stringify(limited.capture), "utf8") <= 16_384);
  assert.deepEqual(replayEvidenceCapture(limited.capture).coverage, {
    captured: 0,
    omitted: 1,
    requested: 1,
    complete: false,
  });
  serve("<html><head><title>Just a moment</title></head><body>" + html + "</body></html>");
  const challenge = await captureBacklinks({ items: [pair] });
  assert.equal(challenge.verification.results[0]!.status, "error");
  assert.equal(challenge.capture.entries.length, 0);
  serve();
  const { capture } = await captureBacklinks({ items: [pair] });
  const incomplete = structuredClone(capture);
  incomplete.entries[0]!.response.complete = false;
  reseal(incomplete);
  assert.throws(() => replayEvidenceCapture(incomplete), /complete|integrity/i);
});

test("followed redirect chain is retained and inconsistent endpoints are refused", async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    if (url === pair.source_url)
      return new Response(null, { status: 302, headers: { location: "/final" } });
    return new Response(html, { headers: { "content-type": "text/html" } });
  };
  const { capture } = await captureBacklinks({ items: [pair] });
  assert.deepEqual(capture.entries[0]!.response.redirects, [
    { from: pair.source_url, to: "https://publisher.example/final", status: 302 },
  ]);
  globalThis.fetch = async () => {
    throw new Error("No network");
  };
  assert.equal(replayEvidenceCapture(capture).results[0]!.status, "confirmed");
  const wrong = structuredClone(capture);
  wrong.entries[0]!.response.final_url = pair.source_url;
  reseal(wrong);
  assert.throws(() => replayEvidenceCapture(wrong), /redirect|integrity/i);
});

test("the synthetic local workflow fixture replays offline and does not promote data-href", async () => {
  const { readFile } = await import("node:fs/promises");
  globalThis.fetch = async () => {
    throw new Error("Fixture replay must stay offline");
  };
  const fixture = JSON.parse(
    await readFile(new URL("./fixtures/evidence-replay-v1.json", import.meta.url), "utf8"),
  );
  const replay = replayEvidenceCapture(fixture);
  assert.equal(replay.results[0]!.status, "confirmed");
  assert.equal(replay.results[0]!.matching_anchors.length, 1);
  assert.equal(replay.results[0]!.anchor, "Oferta 日本語");
});

test("oversized or failed live responses leave no claimed complete capture", async () => {
  serve(html + "x".repeat(2_000_001));
  const oversized = await captureBacklinks({ items: [pair] });
  assert.equal(oversized.verification.results[0]!.status, "error");
  assert.equal(oversized.capture.entries.length, 0);
  assert.equal(oversized.capture.omitted[0]!.reason, "unreplayable_response");
  globalThis.fetch = async () => {
    throw new Error("Fixture connection failed");
  };
  const failed = await captureBacklinks({ items: [pair] });
  assert.equal(failed.capture.entries.length, 0);
  assert.equal(failed.capture.omitted[0]!.reason, "no_complete_response");
});

test("artifact trust boundary rejects oversize decoded text and nested observation payloads", async () => {
  serve();
  const { capture } = await captureBacklinks({ items: [pair] });
  const huge = structuredClone(capture);
  huge.entries[0]!.response.text = "x".repeat(2_000_001);
  assert.throws(() => replayEvidenceCapture(huge), /byte limit|integrity/i);
  const invalid = structuredClone(capture);
  Object.assign(invalid.entries[0]!.observation, { unexpected: { nested: "invalid" } });
  assert.throws(() => replayEvidenceCapture(invalid), /fields/i);
  const wrong = structuredClone(capture);
  wrong.identity_policy = "unknown-url-policy";
  assert.throws(() => replayEvidenceCapture(wrong), /method|version/i);
});

test("cancelled non-HTML response bodies never become complete retained evidence", async () => {
  globalThis.fetch = async (input) =>
    String(input).endsWith("/robots.txt")
      ? new Response("", { status: 404 })
      : new Response("unread media body", {
          status: 404,
          headers: { "content-type": "image/png" },
        });
  const { verification, capture } = await captureBacklinks({ items: [pair] });
  assert.equal(verification.results[0]!.status, "not_found");
  assert.equal(verification.results[0]!.absence_scope, "http_resource");
  assert.equal(capture.entries.length, 0);
  assert.equal(capture.omitted[0]!.reason, "unreplayable_response");
});

test("credential-looking source and target fragments never enter captures", async () => {
  for (const fragment of [
    "#access_token=synthetic-do-not-export",
    "#/callback?access_token=synthetic-do-not-export",
    "#details",
  ]) {
    for (const field of ["source_url", "target_url"] as const) {
      serve();
      const input = { ...pair, [field]: pair[field] + fragment };
      const { verification, capture } = await captureBacklinks({ items: [input] });
      assert.equal(verification.results[0]!.status, "confirmed");
      assert.equal(capture.entries.length, 0);
      assert.equal(capture.omitted[0]!.reason, "sensitive_response");
      assert.equal(JSON.stringify(capture).includes("synthetic-do-not-export"), false);
    }
  }
});

test("sensitive final and intermediate redirect fragments are omitted whole", async () => {
  for (const intermediate of [false, true]) {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url === pair.source_url)
        return new Response(null, {
          status: 302,
          headers: { location: "/callback#/callback?access_token=synthetic-do-not-export" },
        });
      if (intermediate && url.includes("/callback#"))
        return new Response(null, { status: 302, headers: { location: "/final" } });
      return new Response(html, { headers: { "content-type": "text/html" } });
    };
    const { verification, capture } = await captureBacklinks({ items: [pair] });
    assert.equal(verification.results[0]!.status, "confirmed");
    assert.equal(capture.entries.length, 0);
    assert.equal(capture.omitted[0]!.reason, "sensitive_response");
    assert.equal(JSON.stringify(capture).includes("synthetic-do-not-export"), false);
  }
});
