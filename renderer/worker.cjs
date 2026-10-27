/* eslint-disable @typescript-eslint/no-require-imports -- The isolated worker loads its pinned CJS driver. */
/* Untrusted pages have no OS network; stdio brokers only parent-approved text responses. */
"use strict";
const { createInterface } = require("node:readline");
const { readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { chromium } = require("/rankproof-driver/package");
const driverVersion = require("/rankproof-driver/package/package.json").version;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const waiting = new Map();
let initial;
const init = new Promise((resolve) => {
  initial = resolve;
});
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (Buffer.byteLength(line) > 3_000_000) throw new Error("IPC frame too large");
  const message = JSON.parse(line);
  if (message.type === "init") initial(message);
  else if (message.type === "response" && waiting.has(message.id)) {
    waiting.get(message.id)(message);
    waiting.delete(message.id);
  } else throw new Error("Unexpected IPC message");
});
input.on("close", () => {
  for (const resolve of waiting.values()) resolve({ error: "Host closed IPC" });
});
(async () => {
  let browser;
  try {
    const config = await init;
    if (process.getuid() === 0 || driverVersion !== config.driverVersion)
      throw new Error("Unqualified worker identity/driver");
    const executable = "/rankproof-browser/headless_shell";
    const version = execFileSync(executable, ["--version"], {
      timeout: 2000,
      maxBuffer: 1024,
      encoding: "utf8",
    }).trim();
    if (version !== "Chromium " + config.browserVersion)
      throw new Error("Browser version mismatch");
    browser = await chromium.launch({
      executablePath: executable,
      headless: true,
      chromiumSandbox: true,
      args: [
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    });
    const context = await browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
      viewport: config.profile.viewport,
      userAgent: config.profile.userAgent,
      locale: config.profile.locale,
      timezoneId: config.profile.timezoneId,
      extraHTTPHeaders: { "Accept-Language": config.profile.acceptLanguage },
    });
    const blocked = [];
    await context.routeWebSocket("**/*", (socket) => {
      blocked.push({ url: socket.url().slice(0, 2048), reason: "unsupported_websocket" });
      socket.close();
    });
    let sequence = 0;
    let nextNavigation;
    await context.route("**/*", async (route) => {
      const request = route.request();
      const id = ++sequence;
      if (
        id > config.maxRequests ||
        !["GET", "HEAD"].includes(request.method()) ||
        !["document", "script", "stylesheet", "xhr", "fetch"].includes(request.resourceType())
      ) {
        blocked.push({
          url: request.url().slice(0, 2048),
          reason: "unsupported_resource_or_budget",
        });
        await route.abort();
        return;
      }
      let timer;
      const response = await new Promise((resolve) => {
        waiting.set(id, resolve);
        timer = setTimeout(() => {
          waiting.delete(id);
          resolve({ error: "Host response deadline" });
        }, 6000);
        send({
          type: "request",
          id,
          url: request.url(),
          method: request.method(),
          resourceType: request.resourceType(),
          navigation: request.isNavigationRequest(),
          mainDocument: request.isNavigationRequest() && request.frame().parentFrame() === null,
        });
      });
      clearTimeout(timer);
      if (
        typeof response.redirect === "string" &&
        request.isNavigationRequest() &&
        request.frame().parentFrame() === null
      ) {
        nextNavigation = response.redirect;
        await route.abort();
        return;
      }
      if (response.error) {
        blocked.push({
          url: request.url().slice(0, 2048),
          reason: String(response.error).slice(0, 250),
        });
        await route.abort();
        return;
      }
      await route.fulfill({
        status: response.status,
        headers: response.headers,
        body: Buffer.from(response.body, "base64"),
      });
    });
    let page = await context.newPage();
    page.on("popup", (popup) => popup.close());
    let navigation = config.url;
    for (let hop = 0; hop <= 3; hop++) {
      nextNavigation = undefined;
      try {
        await page.goto(navigation, { waitUntil: "domcontentloaded", timeout: 6000 });
        break;
      } catch (error) {
        if (!nextNavigation || hop === 3) throw error;
        navigation = nextNavigation;
        await page.close();
        page = await context.newPage();
        page.on("popup", (popup) => popup.close());
      }
    }
    await page.waitForTimeout(config.profile.settleMs);
    const snapshotStartedAt = new Date().toISOString();
    const html = await page.content();
    const snapshotFinishedAt = new Date().toISOString();
    if (Buffer.byteLength(html) > config.maxOutputBytes)
      throw new Error("Rendered HTML output budget exhausted");
    send({
      type: "result",
      finalUrl: page.url(),
      snapshotStartedAt,
      snapshotFinishedAt,
      html,
      browserVersion: config.browserVersion,
      driverVersion,
      blocked: blocked.slice(0, 40),
      pendingRequests: waiting.size,
      controls: {
        uid: process.getuid(),
        status: readFileSync("/proc/self/status", "utf8")
          .split("\n")
          .filter((line) => /^(?:CapEff|NoNewPrivs|Seccomp):/.test(line)),
        memoryMax: readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(),
        pidsMax: readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim(),
        cpuMax: readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(),
      },
    });
  } catch (error) {
    send({ type: "fatal", error: String(error.message ?? error).slice(0, 1000) });
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    input.close();
  }
})().catch(() => process.exit(1));
