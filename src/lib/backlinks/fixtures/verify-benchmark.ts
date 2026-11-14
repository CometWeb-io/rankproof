/**
 * Labelled verification corpus. Each case is one fetched representation and
 * the answer a careful human gives after reading the raw HTML against the
 * documented rules (docs/api.md): exact URL identity, fragment ignored, errors
 * are never absence.
 *
 * `limitation: true` marks cases where the *ground truth in a browser* differs
 * from what fetched-HTML verification can know (e.g. links inserted by
 * JavaScript). They are scored separately so the headline accuracy is not
 * flattered by leaving them out, and not dragged down by known design limits.
 *
 * Add a case for every bug report: the corpus is the regression gate.
 */

export type BenchmarkCase = {
  id: string;
  category:
    | "identity"
    | "markup"
    | "rel"
    | "anchor-text"
    | "http"
    | "unreadable"
    | "placement"
    | "limitation";
  description: string;
  source_url?: string;
  target_url: string;
  final_url?: string;
  status?: number;
  content_type?: string;
  html: string;
  expected: {
    status: "confirmed" | "not_found" | "error";
    anchor?: string;
    rel?: string;
    placement?: string;
  };
  /** What a real browser shows when it differs from fetched-HTML truth. */
  browser_truth?: "confirmed" | "not_found";
  limitation?: boolean;
};

const T = "https://brand.example/guide?id=7";
const doc = (body: string, head = "<title>Post</title>") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

export const BENCHMARK_CASES: BenchmarkCase[] = [
  /* --------------------------- identity ---------------------------- */
  {
    id: "exact-plain",
    category: "identity",
    description: "Plain absolute link to the exact URL.",
    target_url: T,
    html: doc(`<p>See <a href="${T}">the guide</a>.</p>`),
    expected: { status: "confirmed", anchor: "the guide", rel: "" },
  },
  {
    id: "fragment-ignored",
    category: "identity",
    description: "Fragment differs: still the same resource.",
    target_url: T,
    html: doc(`<a href="${T}#part-2">guide</a>`),
    expected: { status: "confirmed", anchor: "guide" },
  },
  {
    id: "entity-ampersand",
    category: "identity",
    description: "&amp; in the href decodes to the same query.",
    target_url: "https://brand.example/p?a=1&b=2",
    html: doc(`<a href="https://brand.example/p?a=1&amp;b=2">p</a>`),
    expected: { status: "confirmed", anchor: "p" },
  },
  {
    id: "host-case",
    category: "identity",
    description: "Host case is not significant.",
    target_url: T,
    html: doc(`<a href="https://BRAND.example/guide?id=7">guide</a>`),
    expected: { status: "confirmed" },
  },
  {
    id: "default-port",
    category: "identity",
    description: "An explicit default port is the same URL.",
    target_url: T,
    html: doc(`<a href="https://brand.example:443/guide?id=7">guide</a>`),
    expected: { status: "confirmed" },
  },
  {
    id: "protocol-relative",
    category: "identity",
    description: "A protocol-relative href takes the source page's scheme.",
    target_url: T,
    html: doc(`<a href="//brand.example/guide?id=7">guide</a>`),
    expected: { status: "confirmed", anchor: "guide" },
  },
  {
    id: "base-href",
    category: "identity",
    description: "<base href> on the source changes what a relative href means.",
    target_url: "https://brand.example/docs/start",
    html: doc(`<a href="start">start</a>`, `<base href="https://brand.example/docs/">`),
    expected: { status: "confirmed", anchor: "start" },
  },
  {
    id: "query-differs",
    category: "identity",
    description: "A different query string is a different URL.",
    target_url: T,
    html: doc(`<a href="https://brand.example/guide?id=8">guide</a>`),
    expected: { status: "not_found" },
  },
  {
    id: "tracking-param",
    category: "identity",
    description: "Added utm parameters are not collapsed.",
    target_url: T,
    html: doc(`<a href="${T}&utm_source=x">guide</a>`),
    expected: { status: "not_found" },
  },
  {
    id: "trailing-slash",
    category: "identity",
    description: "/guide and /guide/ are different paths.",
    target_url: "https://brand.example/guide",
    html: doc(`<a href="https://brand.example/guide/">guide</a>`),
    expected: { status: "not_found" },
  },
  {
    id: "http-vs-https",
    category: "identity",
    description: "Scheme is significant.",
    target_url: T,
    html: doc(`<a href="http://brand.example/guide?id=7">guide</a>`),
    expected: { status: "not_found" },
  },
  {
    id: "www-differs",
    category: "identity",
    description: "www is a different host.",
    target_url: T,
    html: doc(`<a href="https://www.brand.example/guide?id=7">guide</a>`),
    expected: { status: "not_found" },
  },
  {
    id: "redirect-wrapper",
    category: "identity",
    description: "An outbound redirect wrapper is not a link to the target.",
    target_url: T,
    html: doc(`<a href="https://pub.example/out?url=${encodeURIComponent(T)}">guide</a>`),
    expected: { status: "not_found" },
  },

  /* ---------------------------- markup ----------------------------- */
  {
    id: "in-comment",
    category: "markup",
    description: "A link inside an HTML comment is not rendered.",
    target_url: T,
    html: doc(`<p>Text</p><!-- <a href="${T}">old link</a> -->`),
    expected: { status: "not_found" },
  },
  {
    id: "in-script-string",
    category: "markup",
    description: "Markup inside a script string is not an anchor.",
    target_url: T,
    html: doc(`<p>Article text.</p><script>var s = '<a href="${T}">x</a>';</script>`),
    expected: { status: "not_found" },
  },
  {
    id: "in-textarea",
    category: "markup",
    description: "Raw text in <textarea> is not markup.",
    target_url: T,
    html: doc(`<p>Copy the embed code:</p><textarea><a href="${T}">guide</a></textarea>`),
    expected: { status: "not_found" },
  },
  {
    id: "in-template",
    category: "markup",
    description: "<template> content is inert until a script clones it.",
    target_url: T,
    html: doc(`<p>Text</p><template><a href="${T}">guide</a></template>`),
    expected: { status: "not_found" },
  },
  {
    id: "unquoted-attrs",
    category: "markup",
    description: "Unquoted attribute values are valid HTML.",
    target_url: "https://brand.example/guide",
    html: doc(`<a rel=nofollow href=https://brand.example/guide>guide</a>`),
    expected: { status: "confirmed", rel: "nofollow" },
  },
  {
    id: "attr-in-quoted-gt",
    category: "markup",
    description: "A > inside a quoted attribute does not end the tag.",
    target_url: T,
    html: doc(`<a title="a > b" href="${T}">guide</a>`),
    expected: { status: "confirmed", anchor: "guide" },
  },
  {
    id: "duplicate-href-attr",
    category: "markup",
    description: "With duplicate attributes the first one wins.",
    target_url: T,
    html: doc(`<a href="https://other.example/" href="${T}">guide</a>`),
    expected: { status: "not_found" },
  },

  /* ------------------------------ rel ------------------------------ */
  {
    id: "rel-sponsored",
    category: "rel",
    description: "rel tokens are reported as written.",
    target_url: T,
    html: doc(`<a rel="sponsored noopener" href="${T}">guide</a>`),
    expected: { status: "confirmed", rel: "sponsored noopener" },
  },
  {
    id: "rel-uppercase",
    category: "rel",
    description: "rel values keep their spelling (the contract folds case).",
    target_url: T,
    html: doc(`<a rel="NoFollow" href="${T}">guide</a>`),
    expected: { status: "confirmed", rel: "NoFollow" },
  },
  {
    id: "rel-none",
    category: "rel",
    description: "No rel attribute is an empty string.",
    target_url: T,
    html: doc(`<a href="${T}">guide</a>`),
    expected: { status: "confirmed", rel: "" },
  },

  /* -------------------------- anchor text -------------------------- */
  {
    id: "anchor-nested-markup",
    category: "anchor-text",
    description: "Nested inline markup collapses to its text.",
    target_url: T,
    html: doc(`<a href="${T}"><strong>Brand</strong> <em>guide</em></a>`),
    expected: { status: "confirmed", anchor: "Brand guide" },
  },
  {
    id: "anchor-image-alt",
    category: "anchor-text",
    description: "An image link reads its alt text.",
    target_url: T,
    html: doc(`<a href="${T}"><img src="/logo.png" alt="Brand logo"></a>`),
    expected: { status: "confirmed", anchor: "Brand logo" },
  },
  {
    id: "anchor-wbr",
    category: "anchor-text",
    description: "<wbr> does not split a word.",
    target_url: T,
    html: doc(`<a href="${T}">back<wbr>links</a>`),
    expected: { status: "confirmed", anchor: "backlinks" },
  },
  {
    id: "anchor-entities",
    category: "anchor-text",
    description: "Entities in the text are decoded.",
    target_url: T,
    html: doc(`<a href="${T}">Smith &amp; Sons&nbsp;guide</a>`),
    expected: { status: "confirmed", anchor: "Smith & Sons guide" },
  },

  /* ---------------------------- placement -------------------------- */
  {
    id: "placement-article",
    category: "placement",
    description: "Inside <article> is content.",
    target_url: T,
    html: doc(`<article><p>Read <a href="${T}">the guide</a></p></article>`),
    expected: { status: "confirmed", placement: "content" },
  },
  {
    id: "placement-footer",
    category: "placement",
    description: "Inside <footer> is footer.",
    target_url: T,
    html: doc(`<main><p>Body</p></main><footer><a href="${T}">partner</a></footer>`),
    expected: { status: "confirmed", placement: "footer" },
  },
  {
    id: "placement-sidebar-class",
    category: "placement",
    description: "A widget class marks a sidebar.",
    target_url: T,
    html: doc(`<div class="sidebar widget"><a href="${T}">partner</a></div>`),
    expected: { status: "confirmed", placement: "sidebar" },
  },

  /* ------------------------------ http ----------------------------- */
  {
    id: "http-404",
    category: "http",
    description: "404 means the source page itself is missing.",
    target_url: T,
    status: 404,
    html: doc(`<p>Not found. Try <a href="${T}">our guide</a></p>`),
    expected: { status: "not_found" },
  },
  {
    id: "http-410",
    category: "http",
    description: "410 Gone is missing too.",
    target_url: T,
    status: 410,
    html: doc(`<p>Gone</p>`),
    expected: { status: "not_found" },
  },
  {
    id: "http-503",
    category: "http",
    description: "A server error is not evidence of absence.",
    target_url: T,
    status: 503,
    html: doc(`<p>Maintenance</p>`),
    expected: { status: "error" },
  },
  {
    id: "http-403",
    category: "http",
    description: "Forbidden is not evidence of absence.",
    target_url: T,
    status: 403,
    html: doc(`<p>Forbidden</p>`),
    expected: { status: "error" },
  },
  {
    id: "redirect-into-target",
    category: "http",
    description: "A source that redirected into the target site is an internal link.",
    target_url: T,
    final_url: "https://brand.example/",
    html: doc(`<a href="${T}">guide</a>`),
    expected: { status: "error" },
  },

  /* --------------------------- unreadable -------------------------- */
  {
    id: "cloudflare-challenge",
    category: "unreadable",
    description: "Bot challenge pages are errors.",
    target_url: T,
    html: doc(`<div id="cf-chl-widget">Checking</div>`, "<title>Just a moment...</title>"),
    expected: { status: "error" },
  },
  {
    id: "js-shell",
    category: "unreadable",
    description: "An empty application shell cannot establish absence.",
    target_url: T,
    html: doc(`<div id="root"></div><script src="/app.js"></script>`),
    expected: { status: "error" },
  },
  {
    id: "non-html",
    category: "unreadable",
    description: "JSON is not an HTML page.",
    target_url: T,
    content_type: "application/json",
    html: `{"link":"${T}"}`,
    expected: { status: "error" },
  },
  {
    id: "empty-body",
    category: "unreadable",
    description: "An empty 200 response is an error.",
    target_url: T,
    html: "   ",
    expected: { status: "error" },
  },

  /* ---------------------- documented limitations ------------------- */
  {
    id: "js-inserted-link",
    category: "limitation",
    description:
      "The article is server-rendered but the link is added by a script. Fetched HTML has no anchor; a browser shows one.",
    target_url: T,
    html: doc(
      `<article><p>Our pick is below.</p><span id="slot"></span></article><script>document.getElementById("slot").innerHTML='<a href="${T}">guide</a>'</script>`,
    ),
    expected: { status: "not_found" },
    browser_truth: "confirmed",
    limitation: true,
  },
  {
    id: "css-hidden-link",
    category: "limitation",
    description:
      "The link is in the HTML but hidden with CSS. RankProof confirms it; a visitor never sees it.",
    target_url: T,
    html: doc(`<p>Text</p><div style="display:none"><a href="${T}">guide</a></div>`),
    expected: { status: "confirmed" },
    browser_truth: "not_found",
    limitation: true,
  },
];
