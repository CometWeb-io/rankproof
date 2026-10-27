import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderIsolatedFixture,
  rendererDockerArgs,
  RENDERER_RUNTIME,
  EXECUTOR_LIMITS,
  renderIsolatedPage,
} from "./rendered-executor.server.ts";
import {
  withRenderedTransport,
  reserveRenderedRequest,
  recordRenderedResponse,
  renderedResponseLimit,
  renderedTransportActive,
} from "./rendered-executor-transport.ts";

const runtime = {
  image: RENDERER_RUNTIME.compatibilityImage,
  browserDir: "/fixture/browser",
  driverDir: "/fixture/driver",
  qualification: "compatibility-fixtures-only" as const,
};

test("unqualified production images and real-site compatibility targets fail before Docker or asset access", async () => {
  const { renderedPolicy } = await import("./rendered-policy.ts");
  assert.equal(renderedPolicy("https://source.example/").status, "unavailable");
  await assert.rejects(renderIsolatedFixture("https://real-site.com/", runtime), /authored/);
  await assert.rejects(
    renderIsolatedFixture("https://source.example/", { ...runtime, image: "latest" }),
    /Unknown image/,
  );
  await assert.rejects(
    renderIsolatedFixture("https://source.example/", {
      ...runtime,
      qualification: "production" as never,
    }),
    /Unknown image/,
  );
  await assert.rejects(renderIsolatedFixture("http://127.0.0.1/", runtime), /authored/);
  await assert.rejects(
    renderIsolatedPage("https://source.example/", {
      ...runtime,
      qualification: "qualified-public-web",
    }),
    /Unknown image/,
  );
  await assert.rejects(
    renderIsolatedPage("https://source.example/", {
      ...runtime,
      image: "sha256:" + "0".repeat(64),
      qualification: "qualified-public-web",
    }),
    /Unknown image/,
  );
});

test("container arguments preserve OS deny-all networking, least privilege and hard aggregate budgets", () => {
  const args = rendererDockerArgs("fixture", runtime, "/fixture/worker.cjs");
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(value("--network"), "none");
  assert.ok(args.includes("--read-only"));
  assert.equal(value("--user"), "65534:65534");
  assert.equal(value("--cap-drop"), "ALL");
  assert.ok(args.includes("no-new-privileges"));
  assert.equal(value("--memory"), String(EXECUTOR_LIMITS.memoryBytes));
  assert.equal(value("--memory-swap"), String(EXECUTOR_LIMITS.memoryBytes));
  assert.equal(value("--pids-limit"), "128");
  assert.equal(value("--cpus"), "0.25");
  assert.ok(EXECUTOR_LIMITS.cpus * 14 * 1000 < EXECUTOR_LIMITS.cpuTimeMs);
  assert.ok(args.includes("/usr/bin/timeout") && args.includes("14s"));
  assert.equal(args.filter((item) => item.startsWith("type=bind,")).length, 3);
  assert.ok(
    args
      .filter((item) => item.startsWith("type=bind,"))
      .every((item) => item.endsWith(",readonly")),
  );
  assert.ok(!args.some((item) => /docker\.sock|--privileged|--ipc=host|--network=host/.test(item)));
  assert.ok(args.includes("-i")); // Clear inherited image environment before Node/Chromium.
});

test("renderer request budgets include failed attempts and incomplete response bytes stay unknown", async () => {
  const result = await withRenderedTransport({ requests: 2, bytes: 10 }, async () => {
    assert.equal(renderedTransportActive(), true);
    reserveRenderedRequest();
    recordRenderedResponse(3);
    assert.equal(renderedResponseLimit(20), 7);
    reserveRenderedRequest();
    assert.throws(reserveRenderedRequest, /budget exhausted/);
  });
  assert.equal(result.requests, 2);
  assert.equal(result.bytes, null);
  assert.equal(renderedTransportActive(), false);
});

test("concurrent renderer contexts retain independent byte and request budgets", async () => {
  const runs = await Promise.all(
    [1, 2].map((count) =>
      withRenderedTransport({ requests: 3, bytes: 20 }, async () => {
        await Promise.resolve();
        for (let i = 0; i < count; i++) {
          reserveRenderedRequest();
          recordRenderedResponse(4);
        }
      }),
    ),
  );
  assert.deepEqual(
    runs.map(({ requests, bytes }) => ({ requests, bytes })),
    [
      { requests: 1, bytes: 4 },
      { requests: 2, bytes: 8 },
    ],
  );
});

test("failed oversized pinned responses retain conservative reservations and stop the fifth network attempt", async () => {
  const { mock } = await import("node:test");
  const https = await import("node:https");
  const { EventEmitter } = await import("node:events");
  const { Readable } = await import("node:stream");
  const { fetchText, setHostResolverForTests, clearNetCache } = await import("./net.server.ts");
  const { gzipSync } = await import("node:zlib");
  setHostResolverForTests(async () => ["93.184.216.34"]);
  try {
    for (const compressed of [false, true]) {
      const body = Buffer.alloc(2_000_001);
      const payload = compressed ? gzipSync(body) : body;
      const request = mock.method(https.default, "request", ((
        _options: unknown,
        callback: (res: import("node:http").IncomingMessage) => void,
      ) => {
        const req = new EventEmitter() as import("node:http").ClientRequest;
        req.end = (() => {
          queueMicrotask(() =>
            callback(
              Object.assign(Readable.from([payload]), {
                statusCode: 200,
                statusMessage: "OK",
                headers: {
                  "content-type": "text/html",
                  ...(compressed ? { "content-encoding": "gzip" } : {}),
                },
              }) as import("node:http").IncomingMessage,
            ),
          );
          return req;
        }) as import("node:http").ClientRequest["end"];
        return req;
      }) as typeof https.request);
      const result = await withRenderedTransport({ requests: 40, bytes: 8_000_000 }, async () => {
        for (let attempt = 0; attempt < 5; attempt++)
          await assert.rejects(
            fetchText("https://source.example/large", {
              timeoutMs: 1000,
              maxBytes: 2_000_000,
              skipRobots: true,
              cache: false,
            }),
          );
      });
      assert.equal(
        request.mock.callCount(),
        4,
        compressed ? "decompression failures" : "wire-size failures",
      );
      assert.equal(result.requests, 4);
      assert.equal(result.bytes, null);
      assert.equal(result.budgetedBytes, 8_000_000);
      mock.restoreAll();
      clearNetCache();
    }
  } finally {
    mock.restoreAll();
    setHostResolverForTests(null);
    clearNetCache();
  }
});

test("a mocked Docker-daemon cleanup failure still kills the actual host attachment child", async () => {
  const { cleanupRenderedExecutor } = await import("./rendered-executor.server.ts");
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
    child.once("exit", (code, signal) => resolve([code, signal])),
  );
  try {
    await assert.rejects(
      cleanupRenderedExecutor(async () => {
        throw new Error("Docker daemon unavailable");
      }, child),
      /daemon unavailable/,
    );
    const [, signal] = await exited;
    assert.equal(signal, "SIGKILL");
  } finally {
    child.kill("SIGKILL");
  }
});

test("public transport scope admits public URLs while retaining SSRF and credential guards", async () => {
  const { assertRenderedUrl } = await import("./rendered-executor-transport.ts");
  await withRenderedTransport({ requests: 2, bytes: 100, scope: "public" }, async () => {
    assert.doesNotThrow(() => assertRenderedUrl("https://public-fixture.test/page"));
    for (const url of [
      "http://127.0.0.1/",
      "http://169.254.169.254/",
      "http://[::1]/",
      "https://user:pass@public-fixture.test/",
      "file:///etc/passwd",
      "http://private.internal/",
    ])
      assert.throws(() => assertRenderedUrl(url), /public HTTP/);
  });
});

test("runtime asset mismatch fails before Docker startup even for an accepted immutable image", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "rankproof-renderer-pin-"));
  try {
    const browserDir = join(dir, "browser"),
      driverDir = join(dir, "driver");
    await mkdir(browserDir);
    await mkdir(driverDir);
    await writeFile(join(browserDir, "headless_shell"), "wrong browser");
    await writeFile(join(driverDir, "node"), "wrong driver");
    await assert.rejects(
      renderIsolatedFixture("https://source.example/", { ...runtime, browserDir, driverDir }),
      /asset hash mismatch/,
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});
