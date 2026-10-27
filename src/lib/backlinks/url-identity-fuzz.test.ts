import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeUrl, pageKey, registrableDomain, isTargetHost } from "./parse.ts";
import { backlinkId } from "./score.ts";
import { observeBacklinkResponse } from "./evidence-response.ts";

test("seeded URL mutations preserve six-market identities through actual HTML extraction", () => {
  const markets = [
    ["przykład.pl", "Zażółć"],
    ["example.co.uk", "Offer"],
    ["例子.中国", "报价"],
    ["example.co.jp", "見積もり"],
    ["example.com.br", "Orçamento"],
    ["example.co.in", "प्रस्ताव"],
  ] as const;
  let seed = 0x41c0ffee;
  const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0).toString(16);
  };
  for (let i = 0; i < 1000; i++) {
    const [host, word] = markets[i % markets.length]!;
    const nonce = next();
    const base = `https://${new URL(`https://${host}`).hostname}/${encodeURIComponent(word)}/${nonce}`;
    const urls = [
      `${base}?q=One&ref=${nonce}`,
      `${base}?q=one&ref=${nonce}`,
      `${base}?ref=${nonce}&q=One`,
      `${base}?q=One&ref=${nonce}&ref=second`,
      `${base}/?q=One&ref=${nonce}`,
      `${base.replace("https:", "http:")}?q=One&ref=${nonce}`,
      `${base.replace("https://", "https://www.")}?q=One&ref=${nonce}`,
      `${base}?q=One%26ref%3D${nonce}`,
    ];
    const source = `https://publisher.example/${nonce}`;
    assert.equal(new Set(urls.map(pageKey)).size, urls.length);
    assert.equal(
      new Set(urls.map((targetUrl) => backlinkId({ sourceUrl: source, targetUrl }))).size,
      urls.length,
    );
    for (const target of urls) {
      assert.equal(pageKey(target + "#section"), target);
      assert.equal(normalizeUrl(pageKey(target)), target);
      assert.equal(
        backlinkId({ sourceUrl: source, targetUrl: target, anchor: "Before" }),
        backlinkId({ sourceUrl: source + "#new", targetUrl: target + "#new", anchor: "After" }),
      );
    }
    const target = urls[0]!;
    const response = {
      status: 200,
      text: `<html><body><a href="${target.replaceAll("&", "&amp;")}">${word}</a></body></html>`,
      finalUrl: source,
      contentType: "text/html; charset=utf-8",
      truncated: false,
    };
    const context = {
      checkedAt: "2026-10-27T00:00:00.000Z",
      sourceRevision: "seeded-url-identity",
    };
    const confirmed = observeBacklinkResponse(
      { source_url: source, target_url: target },
      response,
      context,
    );
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.resolved_href, target);
    assert.equal(
      observeBacklinkResponse({ source_url: source, target_url: urls[1]! }, response, context)
        .status,
      "not_found",
    );
    assert.notEqual(
      registrableDomain(`a.tenant-${nonce}.github.io`),
      registrableDomain(`b.other-${nonce}.github.io`),
    );
    assert.equal(isTargetHost(`tenant-${nonce}.github.io`, `other-${nonce}.github.io`), false);
  }
});
