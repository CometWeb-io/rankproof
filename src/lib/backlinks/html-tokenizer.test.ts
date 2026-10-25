import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnchors, parseTagAttrs } from "./html.ts";
import { tokenizeHtml } from "./html-tokenizer.ts";

test("shared discovery parser accepts only genuine anchor elements outside inert markup", () => {
  const target = "https://target.example/offer";
  const html = `<div data-preview="<a href='${target}'>fake</a>">Article</div><a-card href='${target}'>custom</a-card><script>"<a href='${target}'>script</a>"</script><!-- <a href='${target}'>comment</a> --><template><a href='${target}'>template</a></template><a data-href='${target}'>data</a><a href='https://real.example/'>real</a>`;
  assert.deepEqual(
    parseAnchors(html, "https://source.example/").map((anchor) => anchor.href),
    ["https://real.example/"],
  );
});

test("2MB unterminated and quoted adversarial inputs have bounded parsing work", () => {
  const start = performance.now();
  for (const html of ["<a ".repeat(650_000), `<div data-preview='${"<a ".repeat(650_000)}`]) {
    assert.throws(() => tokenizeHtml(html, true), /incomplete/);
    assert.deepEqual(parseAnchors(html, "https://source.example/", { withPlacement: false }), []);
  }
  assert.ok(performance.now() - start < 1000, "parsing must remain linear and bounded");
});

test("shared discovery keeps original offsets across Unicode case-expansion characters", () => {
  const html = `<p>İstanbul</p><script>let x='İ'</script><a href='https://target.example/offer'>Offer</a>`;
  assert.deepEqual(
    parseAnchors(html, "https://source.example/").map((a) => a.href),
    ["https://target.example/offer"],
  );
});

test("unquoted values retain equals, duplicate attributes and a single entity decoding pass", () => {
  const raw = "https://target.example/offer?sku=ABC&amp;x=a=b&amp;again=&amp;amp;";
  assert.equal(parseTagAttrs(` HREF=${raw} rel=nofollow data-key=a=b href=ignored`).href, raw);
  const token = tokenizeHtml(`<a href=${raw} rel=nofollow>Offer</a>`, true).tokens[0]!;
  assert.equal(token.attrs.href, raw);
  assert.equal(token.attrs.rel, "nofollow");
  const anchor = parseAnchors(`<a href=${raw}>Offer</a>`, "https://source.example/")[0]!;
  assert.equal(anchor.href, "https://target.example/offer?sku=ABC&x=a=b&again=&amp;");
  assert.equal(parseTagAttrs("content=a=b=c data-key='' disabled").content, "a=b=c");
});
