import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLimiter,
  readRenderConcurrency,
  renderAvailability,
  renderObserve,
} from "./render.server.ts";
import { needsRender, observeRepresentation, readRenderMode } from "./verify-api.server.ts";
import { compareObservations, evaluateContract, effectiveObservation } from "./observe.ts";

const SOURCE = "https://publisher.example/post";
const TARGET = "https://brand.example/guide";
const available = await renderAvailability();
const skip = available.ok ? false : `no Chromium available: ${available.reason}`;

function htmlObservation(html: string) {
  return observeRepresentation(
    { source_url: SOURCE, target_url: TARGET },
    { text: html, finalUrl: SOURCE, status: 200, contentType: "text/html" },
  );
}

test("render mode parsing and selection never touch 404s or challenges", () => {
  assert.equal(readRenderMode({ items: [] }, false), "off");
  assert.throws(() => readRenderMode({ render: "always" }, false), /not enabled/);
  assert.equal(readRenderMode({ render: true }, true), "fallback");
  assert.throws(() => readRenderMode({ render: "yes" }, true));
  const missing = htmlObservation("<html><body><p>No link here.</p></body></html>");
  assert.equal(needsRender(missing, "fallback"), true);
  const gone = observeRepresentation(
    { source_url: SOURCE, target_url: TARGET },
    { text: "x", finalUrl: SOURCE, status: 404, contentType: "text/html" },
  );
  assert.equal(needsRender(gone, "always"), false);
  const challenge = htmlObservation(
    "<html><head><title>Just a moment...</title></head><body>x</body></html>",
  );
  assert.equal(needsRender(challenge, "always"), false);
  const shell = htmlObservation(
    '<html><body><div id="root"></div><script src="/a.js"></script></body></html>',
  );
  assert.equal(shell.status, "error");
  assert.equal(needsRender(shell, "fallback"), true);
});

test("a JavaScript-inserted link is confirmed from the rendered DOM", { skip }, async () => {
  const html = `<html><body><article><p>Our pick:</p><span id="s"></span></article><script>document.getElementById("s").innerHTML='<a href="${TARGET}">Brand guide</a>'</script></body></html>`;
  const observation = htmlObservation(html);
  assert.equal(observation.status, "not_found");
  [observation.rendered] = await renderObserve([
    { source_url: SOURCE, target_url: TARGET, snapshot: { html } },
  ]);
  assert.equal(observation.rendered!.status, "confirmed");
  const contract = evaluateContract(observation, { expected_anchor: "brand guide" });
  assert.equal(contract.verdict, "meets");
  assert.equal(contract.basis, "rendered_dom");
  assert.equal(contract.visibility, "match");
  assert.ok(contract.notes.some((n) => n.includes("only after JavaScript")));
  assert.equal(observation.status, "not_found", "the fetched-HTML observation is not rewritten");
});

test("a CSS-hidden link deviates even though the HTML confirms it", { skip }, async () => {
  const html = `<html><body><p>Text</p><div style="display:none"><a href="${TARGET}">guide</a></div><a href="${TARGET}" style="position:absolute;left:-9999px">again</a></body></html>`;
  const observation = htmlObservation(html);
  assert.equal(observation.status, "confirmed");
  [observation.rendered] = await renderObserve([
    { source_url: SOURCE, target_url: TARGET, snapshot: { html } },
  ]);
  assert.equal(observation.rendered!.visible, false);
  const contract = evaluateContract(observation);
  assert.equal(contract.verdict, "deviates");
  assert.equal(contract.visibility, "mismatch");
  assert.equal(contract.basis, "fetched_html");

  const visible = { ...observation, rendered: { ...observation.rendered!, visible: true } };
  assert.equal(
    compareObservations(visible, observation).detail,
    "Still in the page, but now hidden from visitors.",
  );
});

test(
  "absent after rendering is a rendered-DOM absence; snapshot mode stays offline",
  { skip },
  async () => {
    const html = `<html><body><p>Article text.</p><template><a href="${TARGET}">x</a></template><script src="https://cdn.example/app.js"></script><img src="https://cdn.example/a.png"></body></html>`;
    const observation = htmlObservation(html);
    [observation.rendered] = await renderObserve([
      { source_url: SOURCE, target_url: TARGET, snapshot: { html } },
    ]);
    assert.equal(observation.rendered!.status, "not_found");
    assert.ok(observation.rendered!.blocked_requests >= 1, "external script was not fetched");
    assert.equal(effectiveObservation(observation).absence_scope, "rendered_dom");
    assert.equal(evaluateContract(observation).verdict, "missing");
  },
);

test("live rendering refuses private addresses through the URL policy", { skip }, async () => {
  const [result] = await renderObserve(
    [{ source_url: "http://127.0.0.1:9/", target_url: TARGET }],
    {
      timeoutMs: 5000,
    },
  );
  assert.equal(result!.status, "error");
  assert.match(result!.reason!, /URL policy refused/);
  // A failed render never overrides the HTML verdict.
  const observation = htmlObservation(`<html><body><a href="${TARGET}">g</a></body></html>`);
  observation.rendered = result!;
  assert.equal(evaluateContract(observation).verdict, "meets");
});

test(
  "rendered benchmark: no regressions, both documented limitations resolved",
  { skip },
  async () => {
    const { runRenderedBenchmark } = await import("./benchmark.ts");
    const report = await runRenderedBenchmark();
    assert.deepEqual(
      report.results.filter((r) => !r.pass).map((r) => `${r.id}: ${r.actual} ≠ ${r.expected}`),
      [],
    );
    assert.equal(report.limitations_resolved, report.limitations);
  },
);

test("an empty rendered page is an error, not an absence", { skip }, async () => {
  const html = `<html><body><div id="root"></div><script src="https://cdn.example/app.js"></script></body></html>`;
  const [result] = await renderObserve([
    { source_url: SOURCE, target_url: TARGET, snapshot: { html } },
  ]);
  assert.equal(result!.status, "error");
  assert.match(result!.reason!, /no readable content/);
  assert.ok(result!.blocked_script_requests >= 1);
});

test(
  "pinned rendering: every browser request is answered from Node, redirects included",
  { skip },
  async () => {
    const http = await import("node:http");
    const seen: { path: string; viaNode: boolean }[] = [];
    const server = http.createServer((req, res) => {
      seen.push({ path: req.url ?? "", viaNode: req.headers["x-test-via"] === "node" });
      if (req.url === "/old") {
        res.writeHead(301, { location: "/post" });
        return res.end();
      }
      if (req.url === "/app.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        return res.end(
          `document.getElementById("s").innerHTML='<a href="${TARGET}">Brand guide</a>'`,
        );
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<html><body><article><p>Pick:</p><span id="s"></span></article><script src="/app.js"></script></body></html>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const fetched: string[] = [];
    try {
      const [rendered] = await renderObserve(
        [{ source_url: `http://127.0.0.1:${port}/old`, target_url: TARGET }],
        {
          policy: async () => ({ allowed: true }),
          fetcher: async (url, init) => {
            fetched.push(url);
            const res = await fetch(url, {
              method: init.method,
              redirect: "manual",
              headers: { "x-test-via": "node" },
            });
            const headers: Record<string, string> = {};
            res.headers.forEach((value, key) => {
              if (key !== "content-length" && key !== "content-encoding") headers[key] = value;
            });
            return { status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) };
          },
        },
      );
      assert.equal(rendered!.status, "confirmed", rendered!.reason ?? "");
      assert.equal(rendered!.final_url, `http://127.0.0.1:${port}/post`);
      assert.deepEqual(
        seen.map((s) => s.path),
        ["/old", "/post", "/app.js"],
      );
      assert.ok(
        seen.every((s) => s.viaNode),
        "the browser never connected on its own",
      );
      assert.equal(fetched.length, 3, "each redirect hop came back through the fetcher");
    } finally {
      server.close();
    }
  },
);

test("pinned rendering: a refused connection is an error, never an absence", { skip }, async () => {
  const [rendered] = await renderObserve([{ source_url: SOURCE, target_url: TARGET }], {
    policy: async () => ({ allowed: true }),
    fetcher: async () => {
      throw new Error("No public address available to pin.");
    },
  });
  assert.equal(rendered!.status, "error");
  assert.match(rendered!.reason ?? "", /pinned request failed: No public address/);
});

test(
  "redirect hops are checked by the URL policy (main frame and scripts), without pinning",
  { skip },
  async () => {
    const http = await import("node:http");
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/old" || req.url === "/js-old") {
        res.writeHead(302, { location: req.url === "/old" ? "/forbidden" : "/js-forbidden" });
        return res.end();
      }
      if (req.url === "/page") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end('<html><body><p>Text</p><script src="/js-old"></script></body></html>');
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>secret</p>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const policy = async (url: string) => ({
      allowed: !url.includes("forbidden"),
      reason: "address not allowed",
    });
    try {
      const [main, script] = await renderObserve(
        [
          { source_url: `${base}/old`, target_url: TARGET },
          { source_url: `${base}/page`, target_url: TARGET },
        ],
        { policy, fetcher: null, concurrency: 1 },
      );
      assert.equal(main!.status, "error");
      assert.match(main!.reason ?? "", /URL policy refused/);
      assert.equal(script!.status, "not_found");
      assert.ok(script!.blocked_script_requests >= 1);
      assert.ok(
        !hits.some((path) => path.includes("forbidden")),
        "no refused hop reached the server",
      );
    } finally {
      server.close();
    }
  },
);

test("the render limiter never runs more than its limit and frees slots on failure", async () => {
  const run = createLimiter(2);
  let active = 0;
  let peak = 0;
  const order: number[] = [];
  const task = (id: number, fail = false) =>
    run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      order.push(id);
      if (fail) throw new Error(`task ${id}`);
      return id;
    });
  const results = await Promise.allSettled([task(1, true), task(2), task(3), task(4), task(5)]);
  assert.equal(peak, 2);
  assert.equal(results[0]!.status, "rejected");
  assert.deepEqual(
    results.slice(1).map((r) => (r.status === "fulfilled" ? r.value : null)),
    [2, 3, 4, 5],
  );
  assert.deepEqual(order.slice(2), [3, 4, 5], "waiters run in arrival order");
  const single = createLimiter(1);
  let concurrent = 0;
  await Promise.all(
    [1, 2, 3].map(() =>
      single(async () => {
        concurrent += 1;
        assert.equal(concurrent, 1);
        await new Promise((resolve) => setTimeout(resolve, 1));
        concurrent -= 1;
      }),
    ),
  );
  assert.equal(readRenderConcurrency({}), 1);
  assert.equal(readRenderConcurrency({ RANKPROOF_RENDER_CONCURRENCY: "3" }), 3);
  assert.equal(readRenderConcurrency({ RANKPROOF_RENDER_CONCURRENCY: "0" }), 1);
  assert.equal(readRenderConcurrency({ RANKPROOF_RENDER_CONCURRENCY: "abc" }), 1);
  assert.equal(readRenderConcurrency({ RANKPROOF_RENDER_CONCURRENCY: "99" }), 8);
});

test(
  "a rendered page that redirects into the target site is an internal link",
  { skip },
  async () => {
    const [rendered] = await renderObserve([{ source_url: SOURCE, target_url: TARGET }], {
      policy: async () => ({ allowed: true }),
      fetcher: async (
        url,
      ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> =>
        url === SOURCE
          ? {
              status: 301,
              headers: { location: "https://www.brand.example/home" },
              body: Buffer.alloc(0),
            }
          : {
              status: 200,
              headers: { "content-type": "text/html" },
              body: Buffer.from(
                `<html><body><article><a href="${TARGET}">guide</a></article></body></html>`,
              ),
            },
    });
    assert.equal(rendered!.status, "error");
    assert.equal(rendered!.final_url, "https://www.brand.example/home");
    assert.match(rendered!.reason ?? "", /redirected into the target site/);
    assert.deepEqual(rendered!.matching_anchors, []);
  },
);

test("WebSockets are closed without reaching the server", { skip }, async () => {
  const http = await import("node:http");
  let upgrades = 0;
  const server = http.createServer((_req, res) => res.end("ok"));
  server.on("upgrade", (_req, socket) => {
    upgrades += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const html = `<html><body><article><p id="p">Text.</p></article><script>
    const ws = new WebSocket("ws://127.0.0.1:${port}/ws");
    ws.onclose = () => { document.getElementById("p").dataset.closed = "1"; };
  </script></body></html>`;
  try {
    const [rendered] = await renderObserve(
      [{ source_url: SOURCE, target_url: TARGET, snapshot: { html } }],
      { budgetMs: 20_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(rendered!.status, "not_found", rendered!.reason ?? "");
    assert.equal(upgrades, 0, "the page never opened a WebSocket to the server");
    assert.ok(rendered!.blocked_requests >= 1);
  } finally {
    server.close();
  }
});

test("oversized browser responses are refused, not buffered into the page", { skip }, async () => {
  const http = await import("node:http");
  const big = "/*" + "x".repeat(6_000_000) + "*/";
  const server = http.createServer((req, res) => {
    if (req.url === "/big.js") {
      res.writeHead(200, { "content-type": "text/javascript", "content-length": big.length });
      return res.end(big);
    }
    if (req.url === "/chunked.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.write(big.slice(0, 3_000_000));
      return res.end(big.slice(3_000_000));
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      '<html><body><article><p>Text</p></article><script src="/big.js"></script><script src="/chunked.js"></script></body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const [rendered] = await renderObserve([{ source_url: `${base}/page`, target_url: TARGET }], {
      policy: async () => ({ allowed: true }),
      fetcher: null,
    });
    assert.equal(rendered!.status, "not_found", rendered!.reason ?? "");
    assert.equal(rendered!.blocked_script_requests, 2);
  } finally {
    server.close();
  }
});
