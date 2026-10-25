import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_SEED_URLS, isAuthorized, scanOptionsFromBody, seedCandidates } from "./service-api.ts";

test("isAuthorized: no configured token lets every caller through", () => {
  assert.equal(isAuthorized(undefined, undefined), true);
  assert.equal(isAuthorized(undefined, "   "), true);
  assert.equal(isAuthorized("Bearer anything", ""), true);
});

test("isAuthorized: a configured token needs an exact bearer match", () => {
  assert.equal(isAuthorized("Bearer s3cret", "s3cret"), true);
  assert.equal(isAuthorized("bearer   s3cret ", "s3cret"), true);
  assert.equal(isAuthorized(undefined, "s3cret"), false);
  assert.equal(isAuthorized("s3cret", "s3cret"), false);
  assert.equal(isAuthorized("Bearer s3cre", "s3cret"), false);
  assert.equal(isAuthorized("Bearer s3cretX", "s3cret"), false);
  assert.equal(isAuthorized("Basic s3cret", "s3cret"), false);
});

test("seedCandidates: keeps external http(s) pages, normalized and deduplicated", () => {
  const seeds = seedCandidates(
    [
      "https://blog.example.org/post?utm_source=x#top",
      "https://blog.example.org/post",
      "http://other.net/",
      "ftp://files.example.org/list",
      "javascript:alert(1)",
      "not a url",
      42,
      "https://cometweb.io/pricing",
      "https://www.cometweb.io/",
      "https://app.cometweb.io/register",
      "http://127.0.0.1/secret",
      "https://user:pass@external.org/post",
    ],
    "cometweb.io",
  );
  assert.deepEqual(
    seeds.map((s) => s.url),
    [
      "https://blog.example.org/post?utm_source=x",
      "https://blog.example.org/post",
      "http://other.net/",
    ],
  );
  assert.ok(seeds.every((s) => s.via === "webmaster" && (s.boost ?? 0) > 0));
});

test("seedCandidates: ignores non-arrays and caps the list", () => {
  assert.deepEqual(seedCandidates("https://a.org", "cometweb.io"), []);
  assert.deepEqual(seedCandidates(undefined, "cometweb.io"), []);
  const many = Array.from({ length: MAX_SEED_URLS + 40 }, (_, i) => `https://s${i}.org/p`);
  assert.equal(seedCandidates(many, "cometweb.io").length, MAX_SEED_URLS);
  assert.equal(seedCandidates(many, "cometweb.io", 5).length, 5);
});

test("scanOptionsFromBody: validated fields pass, the rest is dropped", () => {
  const options = scanOptionsFromBody({
    mode: "light",
    budgetMs: 1_000_000,
    market: "us",
    device: "tablet",
    engines: ["bing", "yahoo", "brave"],
    depth: 15,
    skipSiteAudit: "yes",
    seedUrls: ["https://a.org/x", 7, null],
  });
  assert.equal(options.mode, "light");
  assert.equal(options.budgetMs, 300_000);
  assert.equal(options.market, "us");
  assert.equal(options.device, undefined);
  assert.deepEqual(options.engines, ["bing", "brave"]);
  assert.equal(options.depth, undefined);
  assert.equal(options.skipSiteAudit, false);
  assert.deepEqual(options.seedUrls, ["https://a.org/x"]);
});

test("scanOptionsFromBody: an empty body asks for the defaults", () => {
  const options = scanOptionsFromBody({});
  assert.equal(options.mode, undefined);
  assert.equal(options.budgetMs, undefined);
  assert.equal(options.engines, undefined);
  assert.equal(options.seedUrls, undefined);
  assert.equal(scanOptionsFromBody({ budgetMs: 100 }).budgetMs, 8_000);
  assert.equal(scanOptionsFromBody({ depth: 20 }).depth, 20);
});
