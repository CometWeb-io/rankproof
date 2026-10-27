import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  renderIsolatedFixture,
  renderIsolatedPage,
  PRODUCTION_RENDERER_QUALIFIED,
  RENDERER_RUNTIME,
} from "./rendered-executor.server.ts";
import { clearNetCache, setHostResolverForTests } from "./net.server.ts";
import { clearRobotsCache } from "./robots.server.ts";
import { parseAnchors } from "./html.ts";

const assets = process.env.RANKPROOF_RENDERER_ASSETS;
const integration = { skip: !assets, timeout: 30000 };
const runtime = {
  image: process.env.RANKPROOF_RENDERER_IMAGE ?? RENDERER_RUNTIME.compatibilityImage,
  browserDir: join(assets ?? "/unavailable", "chrome-linux"),
  driverDir: join(assets ?? "/unavailable", "driver"),
  qualification: "compatibility-fixtures-only" as const,
};
afterEach(() => {
  mock.restoreAll();
  clearNetCache();
  clearRobotsCache();
  setHostResolverForTests(null);
});

type Fixture = { status?: number; text?: string; headers?: Record<string, string> };
function serve(routes: Record<string, Fixture>, inspect?: (options: RequestOptions) => void) {
  const requested: string[] = [];
  setHostResolverForTests(async (host) =>
    host === "rebind.example" ? ["169.254.169.254"] : ["93.184.216.34"],
  );
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Unpinned fetch was called.");
  });
  mock.method(https, "request", ((
    options: RequestOptions,
    callback: (res: IncomingMessage) => void,
  ) => {
    const req = new EventEmitter() as ClientRequest;
    req.end = (() => {
      inspect?.(options);
      const path = String(options.path),
        host = String((options.headers as Record<string, string>).Host);
      requested.push(host + path);
      queueMicrotask(() => {
        const fixture =
          routes[host + path] ??
          routes[path] ??
          (path === "/robots.txt" ? { status: 404, text: "" } : { status: 404, text: "Not found" });
        const res = Object.assign(Readable.from(fixture.text ? [Buffer.from(fixture.text)] : []), {
          statusCode: fixture.status ?? 200,
          statusMessage: "Fixture",
          headers: { "content-type": "text/html; charset=utf-8", ...fixture.headers },
        }) as IncomingMessage;
        callback(res);
      });
      return req;
    }) as ClientRequest["end"];
    return req;
  }) as typeof https.request);
  return requested;
}
function containers(executorId: string) {
  assert.match(executorId, /^rankproof-render-[a-f0-9-]+$/);
  return execFileSync(
    "docker",
    ["ps", "--all", "--filter", `name=^/${executorId}$`, "--format", "{{.Names}}"],
    { encoding: "utf8" },
  ).trim();
}
async function expectFailure(operation: Promise<unknown>, pattern: RegExp) {
  try {
    await operation;
    assert.fail("Renderer should fail closed");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    assert.equal(containers((error as Error & { executorId: string }).executorId), "");
  }
}

test(
  "real sandboxed Chromium executes JS-only anchors and approved script/fetch subresources through pinned host IPC",
  integration,
  async () => {
    const requested = serve({
      "/": { text: '<html><body>Zażółć<script src="/app.js"></script></body></html>' },
      "/app.js": {
        text: 'fetch("/links.json").then(r=>r.json()).then(d=>{const a=document.createElement("a");a.href=d.url;a.textContent="Żółw";document.body.appendChild(a)})',
        headers: { "content-type": "application/javascript" },
      },
      "/links.json": {
        text: '{"url":"https://target.example/zażółć?ref=Łódź"}',
        headers: { "content-type": "application/json" },
      },
    });
    const result = await renderIsolatedFixture("https://source.example/", runtime);
    assert.equal(result.productionQualified, false);
    assert.equal(result.runtime.browserVersion, "151.0.7922.34");
    assert.equal(result.controls.uid, 65534);
    assert.equal(result.controls.memoryMax, "268435456");
    assert.equal(result.controls.cpuMax, "25000 100000");
    assert.equal(parseAnchors(result.rawHtml, result.finalUrl).length, 0);
    assert.equal(parseAnchors(result.renderedHtml, result.finalUrl)[0]?.text, "Żółw");
    assert.ok(
      requested.includes("source.example/app.js") &&
        requested.includes("source.example/links.json"),
    );
    assert.equal(result.network.requests, 4); // robots + document + script + JSON
    assert.equal(result.coverage.settled, true);
    assert.equal(containers(result.executorId), "");
  },
);

test(
  "real renderer blocks metadata/loopback/private-DNS/redirect SSRF, robots-disallowed scripts and WebSockets",
  integration,
  async () => {
    const requested = serve({
      "/robots.txt": {
        text: "User-agent: *\nDisallow: /denied.js",
        headers: { "content-type": "text/plain" },
      },
      "/": {
        text: `<html><body>Fixture<script src="/denied.js"></script><script>
      for(const u of ["http://169.254.169.254/latest/meta-data/","http://127.0.0.1/","https://rebind.example/secret","/redirect-private"]){fetch(u).catch(()=>{})}
      new WebSocket("ws://127.0.0.1:9222/");
      const a=document.createElement("a");a.href="https://target.example/safe";document.body.appendChild(a);
    </script></body></html>`,
      },
      "/denied.js": {
        text: 'document.body.innerHTML="DENIED_SCRIPT_EXECUTED"',
        headers: { "content-type": "application/javascript" },
      },
      "/redirect-private": { status: 302, headers: { location: "http://169.254.169.254/" } },
    });
    const result = await renderIsolatedFixture("https://source.example/", runtime);
    assert.ok(!result.renderedHtml.includes("DENIED_SCRIPT_EXECUTED"));
    assert.ok(!requested.some((url) => /169\.254|127\.0\.0|rebind|denied\.js/.test(url)));
    assert.ok(
      result.blocked.some(({ reason }) => /Unsafe renderer URL|authored .example/.test(reason)),
    );
    assert.ok(result.blocked.some(({ reason }) => /robots/.test(reason)));
    assert.ok(result.blocked.some(({ reason }) => /private|resolves/i.test(reason)));
    assert.equal(result.coverage.settled, false);
    assert.equal(containers(result.executorId), "");
  },
);

test(
  "real redirect navigation preserves final document URL/base and meters every hop",
  integration,
  async () => {
    serve({
      "/start": { status: 302, headers: { location: "https://source.example/final" } },
      "/final": {
        text: '<html><body><script>const a=document.createElement("a");a.href="relative";document.body.appendChild(a)</script></body></html>',
      },
    });
    const result = await renderIsolatedFixture("https://source.example/start", runtime);
    assert.equal(result.finalUrl, "https://source.example/final");
    assert.equal(
      parseAnchors(result.renderedHtml, result.finalUrl)[0]?.href,
      "https://source.example/relative",
    );
    assert.equal(result.network.requests, 3);
    assert.equal(result.network.decodedBytes, Buffer.byteLength(result.rawHtml)); // Pinned redirect and robots bodies reached EOF.
    assert.equal(containers(result.executorId), "");
  },
);

test(
  "rendered output overflow fails closed and removes its task container",
  integration,
  async () => {
    serve({
      "/": {
        text: '<html><body><script>document.documentElement.setAttribute("data-large","x".repeat(210000))</script></body></html>',
      },
    });
    await expectFailure(
      renderIsolatedFixture("https://source.example/", runtime),
      /output budget exhausted|IPC output budget/,
    );
  },
);

test(
  "CPU-loop fixture hits a deadline under aggregate cgroup quota and removes its task container",
  integration,
  async () => {
    serve({ "/": { text: "<html><body><script>while(true){}</script></body></html>" } });
    const started = Date.now();
    await expectFailure(
      renderIsolatedFixture("https://source.example/", runtime),
      /Timeout|deadline|wall-time|exited/,
    );
    assert.ok(Date.now() - started < 22000);
  },
);

test(
  "memory-pressure fixture cannot escape the aggregate RAM cgroup and cleans up after failure",
  integration,
  async () => {
    serve({
      "/": {
        text: "<html><body><script>const b=[];while(true){const a=new Uint8Array(8*1024*1024);a.fill(42);b.push(a)}</script></body></html>",
      },
    });
    await expectFailure(
      renderIsolatedFixture("https://source.example/", runtime),
      /crashed|exited|budget|Timeout/,
    );
  },
);

test(
  "compatibility image cannot reach nonfixture scripts, fetches, workers or redirected robots",
  integration,
  async () => {
    const requested = serve({
      "/": {
        text: '<html><body>Fixture<script src="https://outside-real.com/script.js"></script><script src="https://allowed.example/protected.js"></script><script>fetch("https://outside-real.com/data").catch(()=>{});try{new Worker("https://outside-real.com/worker.js")}catch{}</script></body></html>',
      },
      "allowed.example/robots.txt": {
        status: 302,
        headers: { location: "https://outside-real.com/robots.txt" },
      },
    });
    const dns: string[] = [];
    setHostResolverForTests(async (host) => {
      dns.push(host);
      if (!host.endsWith(".example")) throw new Error("External DNS attempted");
      return ["93.184.216.34"];
    });
    const result = await renderIsolatedFixture("https://source.example/", runtime);
    assert.ok(result.blocked.some(({ reason }) => /authored .example/.test(reason)));
    assert.ok(
      !requested.some((url) => url.includes("outside-real.com") || url.includes("protected.js")),
    );
    assert.ok(!dns.includes("outside-real.com"));
    assert.ok(requested.includes("allowed.example/robots.txt"));
    assert.equal(result.coverage.settled, false);
  },
);

test(
  "compatibility location changes to a real domain fail closed before DNS/network",
  integration,
  async () => {
    const requested = serve({
      "/": {
        text: '<html><body><script>location.href="https://outside-real.com/escape"</script></body></html>',
      },
    });
    const dns: string[] = [];
    setHostResolverForTests(async (host) => {
      dns.push(host);
      if (!host.endsWith(".example")) throw new Error("External DNS attempted");
      return ["93.184.216.34"];
    });
    await expectFailure(
      renderIsolatedFixture("https://source.example/", runtime),
      /Renderer failed|Invalid renderer result|Main source HTML unusable/,
    );
    assert.ok(!requested.some((url) => url.includes("outside-real.com")));
    assert.ok(!dns.includes("outside-real.com"));
  },
);

test(
  "WebSocket-only dynamic fixtures explicitly report blocked coverage",
  integration,
  async () => {
    serve({
      "/": {
        text: '<html><body>Fixture<script>new WebSocket("wss://socket.example/updates")</script></body></html>',
      },
    });
    const result = await renderIsolatedFixture("https://source.example/", runtime);
    assert.equal(result.coverage.settled, false);
    assert.ok(
      result.blocked.some(
        ({ url, reason }) =>
          url === "wss://socket.example/updates" && reason === "unsupported_websocket",
      ),
    );
    assert.equal(containers(result.executorId), "");
  },
);

test(
  "qualified modern profile renders general public URLs through pinned IPC and blocks private targets",
  { ...integration, skip: !assets || !PRODUCTION_RENDERER_QUALIFIED },
  async () => {
    const profiles: RequestOptions[] = [];
    const requested = serve(
      {
        "/": {
          text: '<html><body>Fixture<script src="https://public-fixture.test/app.js"></script></body></html>',
        },
        "/app.js": {
          text: 'const a=document.createElement("a");a.href="https://target.example/public-js";a.textContent="Public JS";document.body.appendChild(a);document.body.setAttribute("data-profile",JSON.stringify({ua:navigator.userAgent,locale:navigator.language,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,width:innerWidth,height:innerHeight}));fetch("http://169.254.169.254/").catch(()=>{});fetch("https://rebind.example/private").catch(()=>{})',
          headers: { "content-type": "application/javascript" },
        },
      },
      (options) => profiles.push(options),
    );
    const result = await renderIsolatedPage("https://cometweb.io/", {
      ...runtime,
      image: RENDERER_RUNTIME.publicImage,
      qualification: "qualified-public-web",
    });
    const scriptHeaders = profiles.find((options) => options.path === "/app.js")?.headers as Record<
      string,
      string
    >;
    assert.equal(scriptHeaders["User-Agent"], result.requestProfile.userAgent);
    assert.equal(scriptHeaders["Accept-Language"], result.requestProfile.acceptLanguage);
    assert.equal(scriptHeaders.Accept, result.requestProfile.acceptByResource.script);
    assert.ok(result.renderedHtml.includes(result.requestProfile.userAgent));
    assert.equal(result.requestProfile.locale, "en-US");
    assert.equal(result.requestProfile.timezoneId, "UTC");
    assert.deepEqual(result.requestProfile.viewport, { width: 1280, height: 720 });
    assert.equal(result.requestProfile.settleMs, 350);
    assert.match(result.requestProfileDigest, /^[a-f0-9]{64}$/);
    assert.ok(Date.parse(result.snapshotWindow.startedAt) <= Date.parse(result.capturedAt));
    assert.equal(result.productionQualified, true);
    assert.equal(result.qualification, "qualified-public-web");
    assert.equal(result.finalUrl, "https://cometweb.io/");
    assert.equal(parseAnchors(result.renderedHtml, result.finalUrl)[0]?.text, "Public JS");
    assert.ok(requested.includes("public-fixture.test/app.js"));
    assert.ok(!requested.some((url) => /169\.254|rebind/.test(url)));
    assert.ok(result.blocked.some(({ reason }) => /public HTTP|non-public/.test(reason)));
    assert.equal(containers(result.executorId), "");
  },
);

test(
  "main HTTP403 and recognized200 browser challenges fail closed instead of complete rendered quality",
  integration,
  async () => {
    for (const source of [
      { status: 403, text: "<html><body>Access denied</body></html>", reason: /HTTP 403/ },
      {
        status: 200,
        text: '<html><head><title>Just a moment</title></head><body>Verify you are human<a href="https://target.example/fake">Challenge</a></body></html>',
        reason: /browser or JavaScript challenge/,
      },
    ]) {
      serve({ "/": { status: source.status, text: source.text } });
      await expectFailure(renderIsolatedFixture("https://source.example/", runtime), source.reason);
      mock.restoreAll();
      clearNetCache();
      clearRobotsCache();
    }
  },
);

test(
  "SPA History API changes retain actual fetched raw URL and separate DOM URL/base including fragments",
  integration,
  async () => {
    for (const fragment of ["", "#initial-panel"]) {
      const requested = serve({
        "/origin/index": {
          text: '<html><body><a href="child">Child</a><script>history.replaceState({},"","/virtual/view?x=1#panel")</script></body></html>',
        },
      });
      const result = await renderIsolatedFixture(
        "https://source.example/origin/index" + fragment,
        runtime,
      );
      assert.equal(result.requestedUrl, "https://source.example/origin/index" + fragment);
      assert.equal(result.rawUrl, "https://source.example/origin/index");
      assert.equal(result.finalUrl, "https://source.example/virtual/view?x=1#panel");
      assert.equal(
        parseAnchors(result.rawHtml, result.rawUrl)[0]?.href,
        "https://source.example/origin/child",
      );
      assert.equal(
        parseAnchors(result.renderedHtml, result.finalUrl)[0]?.href,
        "https://source.example/virtual/child",
      );
      assert.deepEqual(requested, ["source.example/robots.txt", "source.example/origin/index"]);
      assert.equal(
        result.network.resources.filter(({ outcome }) => outcome === "redirect").length,
        0,
      );
      assert.equal(containers(result.executorId), "");
      mock.restoreAll();
      clearNetCache();
      clearRobotsCache();
    }
  },
);

test(
  "a recognized browser challenge produced by JavaScript is not complete rendered quality",
  integration,
  async () => {
    serve({
      "/": {
        text: '<html><body>Fixture<script>document.title=["Just","a","moment"].join(" ")</script></body></html>',
      },
    });
    await expectFailure(
      renderIsolatedFixture("https://source.example/", runtime),
      /browser or JavaScript challenge/,
    );
  },
);
