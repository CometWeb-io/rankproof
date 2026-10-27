/** Optional Docker executor. The legacy local base is permitted only for authored .example fixtures. */
import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readdir, realpath, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { API_UA, Budget, fetchText } from "./net.server.ts";
import { parseHtmlResponse } from "./evidence-response.ts";
import { guardUrl } from "./ssrf.ts";
import { withRenderedTransport, assertRenderedUrl } from "./rendered-executor-transport.ts";

const exec = promisify(execFile);
export const RENDERER_RUNTIME = Object.freeze({
  browserVersion: "151.0.7922.34",
  driverVersion: "1.62.0",
  revision: "1234",
  browserTreeSha256: "01f17a7b05a02c00243cb0f78e086478a708a52e4f786a61d990fb2540808106",
  driverTreeSha256: "f8122fdfe04343b788ea96cc5d02cbe1e4edf0a7163ffa4bbd7b79a3c49c8b31",
  publicImage: "sha256:961f5d79e7d6255a718eb446b7d57db5deabc258d4e525e655a3034c2f17930b",
  compatibilityImage: "sha256:9e6eddb08b8566076ef778007859096bc90f8984236061c086eaede2fb60430b",
});
export const EXECUTOR_LIMITS = Object.freeze({
  wallTimeMs: 15000,
  cpuTimeMs: 5000,
  memoryBytes: 268435456,
  pids: 128,
  cpus: 0.25,
  requests: 40,
  responseBytes: 2_000_000,
  totalBytes: 8_000_000,
  outputBytes: 200_000,
  redirects: 3,
});
export const RENDERER_PROFILE = Object.freeze({
  userAgent: "RankProof/8.1 (+https://github.com/CometWeb-io/rankproof) Chromium/151.0.7922.34",
  acceptLanguage: "en-US,en;q=0.9",
  locale: "en-US",
  timezoneId: "UTC",
  viewport: Object.freeze({ width: 1280, height: 720 }),
  settleMs: 350,
  acceptByResource: Object.freeze({
    document: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    script: "*/*",
    stylesheet: "text/css,*/*;q=0.1",
    xhr: "*/*",
    fetch: "*/*",
  }),
  robotsUserAgent: API_UA,
  robotsAcceptLanguage: "en,pl;q=0.8",
  snapshotSemantics:
    "DOM captured during the recorded interval after domcontentloaded plus a fixed settle wait; future timers and async work may remain.",
});
export const PRODUCTION_RENDERER_QUALIFIED = true;
export type RendererRuntime = {
  image: string;
  browserDir: string;
  driverDir: string;
  qualification: "compatibility-fixtures-only" | "qualified-public-web";
};
type Request = {
  type: "request";
  id: number;
  url: string;
  method: "GET" | "HEAD";
  resourceType: string;
  navigation: boolean;
  mainDocument: boolean;
};
type Result = {
  type: "result";
  finalUrl: string;
  html: string;
  browserVersion: string;
  driverVersion: string;
  blocked: { url: string; reason: string }[];
  pendingRequests: number;
  snapshotStartedAt: string;
  snapshotFinishedAt: string;
  controls: { uid: number; status: string[]; memoryMax: string; pidsMax: string; cpuMax: string };
};

async function docker(args: string[]) {
  return (await exec("docker", args, { timeout: 5000, maxBuffer: 65536 })).stdout.trim();
}
async function removeContainer(name: string, created: boolean): Promise<void> {
  try {
    await docker(["rm", "--force", name]);
  } catch (error) {
    if (created || !String(error).includes("No such container"))
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        executorId: name,
      });
  }
}
/** Host attachment is terminated even when Docker cleanup reports a daemon failure. */
export async function cleanupRenderedExecutor(
  remove: () => Promise<unknown>,
  child?: { kill(signal: NodeJS.Signals): unknown },
): Promise<void> {
  try {
    await remove();
  } finally {
    child?.kill("SIGKILL");
  }
}
async function assetDigest(root: string): Promise<string> {
  const digest = createHash("sha256");
  // Hash paths in byte order, matching the reviewed runtime manifest.
  const files: string[] = [];
  async function collect(dir: string, prefix = ""): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error("Renderer assets cannot contain symlinks.");
      if (entry.isDirectory()) await collect(join(dir, entry.name), key);
      else if (entry.isFile()) files.push(key);
      else throw new Error("Renderer assets must be regular files.");
    }
  }
  await collect(root);
  for (const key of files.sort()) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(join(root, key))) hash.update(chunk);
    digest.update(key + "\0");
    digest.update(hash.digest());
  }
  return digest.digest("hex");
}

export function rendererDockerArgs(
  name: string,
  runtime: RendererRuntime,
  worker: string,
): string[] {
  return [
    "create",
    "--name",
    name,
    "--pull",
    "never",
    "--interactive",
    "--init",
    "--network",
    "none",
    "--read-only",
    "--user",
    "65534:65534",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--security-opt",
    `seccomp=${join(dirname(worker), "seccomp-chromium.json")}`,
    "--pids-limit",
    String(EXECUTOR_LIMITS.pids),
    "--memory",
    String(EXECUTOR_LIMITS.memoryBytes),
    "--memory-swap",
    String(EXECUTOR_LIMITS.memoryBytes),
    "--cpus",
    String(EXECUTOR_LIMITS.cpus),
    "--log-driver",
    "none",
    "--ipc",
    "private",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=32m",
    "--mount",
    `type=bind,source=${runtime.browserDir},target=/rankproof-browser,readonly`,
    "--mount",
    `type=bind,source=${runtime.driverDir},target=/rankproof-driver,readonly`,
    "--mount",
    `type=bind,source=${worker},target=/rankproof-worker.cjs,readonly`,
    "--entrypoint",
    "/usr/bin/env",
    runtime.image,
    "-i",
    "HOME=/tmp",
    "PATH=/usr/bin:/bin",
    "LANG=C.UTF-8",
    "/usr/bin/timeout",
    "--signal=KILL",
    "14s",
    "/rankproof-driver/node",
    "/rankproof-worker.cjs",
  ];
}

/** Runtime configuration is trusted operator input, never a JSON request body. */
export async function renderIsolatedFixture(url: string, runtime: RendererRuntime) {
  return renderPage(url, runtime, "fixtures");
}

/** Public-web execution is available only for a registry-qualified immutable runtime. */
export async function renderIsolatedPage(url: string, runtime: RendererRuntime) {
  return renderPage(url, runtime, "public");
}

async function renderPage(url: string, supplied: RendererRuntime, scope: "fixtures" | "public") {
  const fixture = scope === "fixtures";
  const knownFixtureImage =
    supplied?.image === RENDERER_RUNTIME.compatibilityImage ||
    supplied?.image === RENDERER_RUNTIME.publicImage;
  if (
    !supplied ||
    (fixture
      ? supplied.qualification !== "compatibility-fixtures-only" || !knownFixtureImage
      : !PRODUCTION_RENDERER_QUALIFIED ||
        supplied.qualification !== "qualified-public-web" ||
        supplied.image !== RENDERER_RUNTIME.publicImage)
  )
    throw new Error(
      "No production-qualified renderer runtime. Unknown image/qualification refused.",
    );
  if (!guardUrl(url).allowed || (fixture && !new URL(url).hostname.endsWith(".example")))
    throw new Error(
      fixture
        ? "Compatibility renderer accepts authored .example fixtures only."
        : "Renderer requires a public HTTP(S) URL.",
    );
  const runtime = {
    ...supplied,
    browserDir: await realpath(supplied.browserDir),
    driverDir: await realpath(supplied.driverDir),
  };
  if (
    [runtime.browserDir, runtime.driverDir].some(
      (path) => path.includes(",") || /[\r\n]/.test(path),
    )
  )
    throw new Error("Invalid renderer asset path.");
  if (
    (await assetDigest(runtime.browserDir)) !== RENDERER_RUNTIME.browserTreeSha256 ||
    (await assetDigest(runtime.driverDir)) !== RENDERER_RUNTIME.driverTreeSha256
  )
    throw new Error("Renderer asset hash mismatch.");
  const packedWorker = new URL("../renderer/worker.cjs", import.meta.url);
  const worker = fileURLToPath(
    existsSync(packedWorker)
      ? packedWorker
      : new URL("../../../renderer/worker.cjs", import.meta.url),
  );
  if (!(await lstat(worker)).isFile()) throw new Error("Renderer worker unavailable.");
  const name = `rankproof-render-${randomUUID()}`;
  const abort = new AbortController();
  const budget = new Budget(EXECUTOR_LIMITS.wallTimeMs, abort.signal);
  let child: ReturnType<typeof spawn> | undefined;
  let created = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  let rawHtml = "",
    rawUrl = "",
    sourceStatus: number | null = null,
    mainSourceError: string | undefined,
    redirects = 0;
  const observedRequests: { url: string; outcome: string }[] = [];
  const startedAt = Date.now();
  try {
    await docker(rendererDockerArgs(name, runtime, worker));
    created = true;
    const actual = JSON.parse(await docker(["inspect", "--format", "{{json .HostConfig}}", name]));
    if (
      actual.NetworkMode !== "none" ||
      actual.ReadonlyRootfs !== true ||
      actual.Privileged ||
      actual.Memory !== EXECUTOR_LIMITS.memoryBytes ||
      actual.MemorySwap !== EXECUTOR_LIMITS.memoryBytes ||
      actual.NanoCpus !== 250000000 ||
      actual.PidsLimit !== EXECUTOR_LIMITS.pids ||
      !actual.CapDrop?.includes("ALL") ||
      !actual.SecurityOpt?.includes("no-new-privileges")
    )
      throw new Error("Docker isolation controls mismatch.");
    const measured = await withRenderedTransport(
      { requests: EXECUTOR_LIMITS.requests, bytes: EXECUTOR_LIMITS.totalBytes, scope },
      async () => {
        child = spawn("docker", ["start", "--attach", "--interactive", name], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        const decoder = new StringDecoder("utf8");
        let lastRequestId = 0;
        let pending = "",
          outputBytes = 0,
          stderr = "",
          chain = Promise.resolve(),
          finished = false;
        return await new Promise<Result>((done, fail) => {
          const reject = (error: Error) => {
            if (!finished) {
              finished = true;
              abort.abort();
              fail(error);
            }
          };
          timer = setTimeout(
            () => reject(new Error("Renderer wall-time budget exhausted.")),
            Math.max(1, EXECUTOR_LIMITS.wallTimeMs - (Date.now() - startedAt)),
          );
          const answer = (value: unknown) => {
            if (!child?.stdin?.destroyed && !finished)
              child!.stdin!.write(JSON.stringify(value) + "\n");
          };
          async function handle(message: Record<string, unknown>) {
            if (message.type === "fatal")
              throw new Error(
                mainSourceError
                  ? `Main source HTML unusable: ${mainSourceError}`
                  : `Renderer failed: ${String(message.error).slice(0, 1000)}`,
              );
            if (message.type === "result") {
              if (mainSourceError) throw new Error(`Main source HTML unusable: ${mainSourceError}`);
              const result = message as unknown as Result;
              assertRenderedUrl(result.finalUrl);
              if (
                typeof result.html !== "string" ||
                Buffer.byteLength(result.html) > EXECUTOR_LIMITS.outputBytes ||
                typeof result.finalUrl !== "string" ||
                new URL(result.finalUrl).origin !== new URL(rawUrl).origin ||
                result.browserVersion !== RENDERER_RUNTIME.browserVersion ||
                result.driverVersion !== RENDERER_RUNTIME.driverVersion ||
                !Array.isArray(result.blocked) ||
                !Number.isSafeInteger(result.pendingRequests) ||
                result.pendingRequests < 0 ||
                !Number.isFinite(Date.parse(result.snapshotStartedAt)) ||
                !Number.isFinite(Date.parse(result.snapshotFinishedAt)) ||
                Date.parse(result.snapshotStartedAt) > Date.parse(result.snapshotFinishedAt) ||
                result.controls?.uid !== 65534 ||
                result.controls.memoryMax !== String(EXECUTOR_LIMITS.memoryBytes) ||
                result.controls.pidsMax !== String(EXECUTOR_LIMITS.pids) ||
                result.controls.cpuMax !== "25000 100000" ||
                !result.controls.status.some((line) => /^CapEff:\s+0+$/.test(line)) ||
                !result.controls.status.some((line) => /^NoNewPrivs:\s+1$/.test(line)) ||
                !result.controls.status.some((line) => /^Seccomp:\s+2$/.test(line))
              )
                throw new Error("Invalid renderer result.");
              parseHtmlResponse({
                status: sourceStatus ?? 0,
                text: result.html,
                finalUrl: result.finalUrl,
                contentType: "text/html",
                truncated: false,
              });
              if (!finished) {
                finished = true;
                child!.stdin!.end();
                done(result);
              }
              return;
            }
            const request = message as unknown as Request;
            if (
              request.type !== "request" ||
              !Number.isSafeInteger(request.id) ||
              request.id <= lastRequestId ||
              request.id > EXECUTOR_LIMITS.requests ||
              typeof request.url !== "string" ||
              request.url.length > 2048 ||
              !["GET", "HEAD"].includes(request.method) ||
              typeof request.mainDocument !== "boolean" ||
              !["document", "script", "stylesheet", "xhr", "fetch"].includes(request.resourceType)
            )
              throw new Error("Invalid renderer request frame.");
            lastRequestId = request.id;
            let hop: { from: string; to: string; status: number } | undefined;
            try {
              assertRenderedUrl(request.url);
              if (!guardUrl(request.url).allowed) throw new Error("Unsafe renderer URL.");
              const response = await fetchText(request.url, {
                timeoutMs: Math.min(5000, budget.left()),
                maxBytes: EXECUTOR_LIMITS.responseBytes,
                cache: false,
                budget,
                signal: budget.signal,
                method: request.method,
                ua: RENDERER_PROFILE.userAgent,
                acceptLanguage: RENDERER_PROFILE.acceptLanguage,
                accept:
                  RENDERER_PROFILE.acceptByResource[
                    request.resourceType as keyof typeof RENDERER_PROFILE.acceptByResource
                  ],
                onRedirect(value) {
                  assertRenderedUrl(value.to);
                  if (++redirects > EXECUTOR_LIMITS.redirects || !guardUrl(value.to).allowed)
                    throw new Error("Unsafe renderer redirect/budget.");
                  hop = value;
                  throw new Error("renderer_redirect");
                },
              });
              if (response.truncated) throw new Error("Renderer response budget exhausted.");
              if (request.mainDocument)
                parseHtmlResponse({
                  status: response.status,
                  text: response.text,
                  finalUrl: response.finalUrl,
                  contentType: response.headers?.get("content-type") ?? "",
                  truncated: response.truncated ?? false,
                });
              const type = response.headers?.get("content-type") ?? "";
              if (
                !/^(?:text\/|application\/(?:javascript|x-javascript|json|xml|xhtml\+xml))/i.test(
                  type,
                )
              )
                throw new Error("Unsupported renderer response type.");
              const headers = Object.fromEntries(
                [...(response.headers ?? new Headers())].filter(
                  ([key]) =>
                    !/^(?:set-cookie|content-length|content-encoding|connection|transfer-encoding|keep-alive|proxy-authenticate|proxy-authorization|upgrade)$/i.test(
                      key,
                    ),
                ),
              );
              if (request.mainDocument) {
                rawHtml = response.text;
                rawUrl = request.url;
                sourceStatus = response.status;
              }
              observedRequests.push({ url: request.url, outcome: "fulfilled" });
              answer({
                type: "response",
                id: request.id,
                status: response.status,
                headers,
                body: Buffer.from(response.text).toString("base64"),
              });
            } catch (error) {
              if (hop && error instanceof Error && error.message === "renderer_redirect") {
                observedRequests.push({ url: request.url, outcome: "redirect" });
                answer(
                  request.mainDocument
                    ? { type: "response", id: request.id, redirect: hop.to }
                    : {
                        type: "response",
                        id: request.id,
                        error:
                          "Redirected subresource is unsupported by this bounded fixture executor.",
                      },
                );
              } else {
                const reason =
                  error instanceof Error ? error.message.slice(0, 250) : "Resource unavailable";
                if (request.mainDocument) mainSourceError = reason;
                observedRequests.push({ url: request.url, outcome: reason });
                answer({ type: "response", id: request.id, error: reason });
              }
            }
          }
          child!.stdout!.on("data", (chunk: Buffer) => {
            outputBytes += chunk.byteLength;
            if (outputBytes > EXECUTOR_LIMITS.outputBytes + 100000) {
              reject(new Error("Renderer IPC output budget exhausted."));
              return;
            }
            pending += decoder.write(chunk);
            for (let newline; (newline = pending.indexOf("\n")) !== -1;) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              chain = chain
                .then(async () => {
                  const value: unknown = JSON.parse(line);
                  if (!value || typeof value !== "object" || Array.isArray(value))
                    throw new Error("Invalid renderer frame.");
                  await handle(value as Record<string, unknown>);
                })
                .catch(reject);
            }
          });
          child!.stderr!.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
            if (stderr.length > 16000) reject(new Error("Renderer stderr budget exhausted."));
          });
          child!.once("error", reject);
          child!.once("close", () => {
            if (!finished)
              reject(new Error("Renderer exited before a valid result: " + stderr.slice(0, 1500)));
          });
          answer({
            type: "init",
            url,
            browserVersion: RENDERER_RUNTIME.browserVersion,
            driverVersion: RENDERER_RUNTIME.driverVersion,
            profile: RENDERER_PROFILE,
            maxRequests: EXECUTOR_LIMITS.requests,
            maxOutputBytes: EXECUTOR_LIMITS.outputBytes,
          });
        });
      },
    );
    return {
      schemaVersion: 1,
      executorId: name,
      status: "rendered" as const,
      qualification: runtime.qualification,
      productionQualified: !fixture && PRODUCTION_RENDERER_QUALIFIED,
      qualificationScope:
        "Exact registered image/browser/driver and enforced controls on Linux ARM64; supported bounded HTML/text-resource profile.",
      requestedUrl: url,
      finalUrl: measured.result.finalUrl,
      rawUrl,
      sourceStatus,
      sourceOutcome: "successful_complete_html" as const,
      renderedOutcome: "successful_complete_html" as const,
      rawHtml,
      renderedHtml: measured.result.html,
      capturedAt: measured.result.snapshotFinishedAt,
      snapshotWindow: {
        startedAt: measured.result.snapshotStartedAt,
        finishedAt: measured.result.snapshotFinishedAt,
      },
      requestProfile: RENDERER_PROFILE,
      requestProfileDigest: createHash("sha256")
        .update(JSON.stringify(RENDERER_PROFILE))
        .digest("hex"),
      representation: "rendered_dom" as const,
      indexability: "unknown" as const,
      rawHash: createHash("sha256").update(rawHtml).digest("hex"),
      renderedHash: createHash("sha256").update(measured.result.html).digest("hex"),
      runtime: RENDERER_RUNTIME,
      limits: EXECUTOR_LIMITS,
      network: {
        requests: measured.requests,
        decodedBytes: measured.bytes,
        budgetedResponseBytes: measured.budgetedBytes,
        resources: observedRequests,
      },
      blocked: measured.result.blocked,
      controls: measured.result.controls,
      coverage: {
        pendingRequests: measured.result.pendingRequests,
        blockedResources: measured.result.blocked.length,
        settled: measured.result.pendingRequests === 0 && measured.result.blocked.length === 0,
      },
      limitation:
        "Bounded DOM snapshot; settled describes the observed broker window only. Future timers/async JavaScript may remain. Anchors do not establish search-engine indexability or exhaustive rendered absence.",
    };
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      executorId: name,
    });
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
    await cleanupRenderedExecutor(() => removeContainer(name, created), child);
  }
}
