import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnchors } from "./html.ts";
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
