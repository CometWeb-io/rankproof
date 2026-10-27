/** Configured operator credentials + actual entrypoints; all upstream I/O is hermetic. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const source = (name: string) => new URL(`./${name}.ts`, import.meta.url).href;
const canary = "PRIVATE_OWNER_QUERY_CANARY";
const env = {
  PATH: process.env.PATH,
  RANKPROOF_PIN_DNS: "0",
  RANKPROOF_PERSIST_HISTORY: "0",
  RANKPROOF_ENGINES: "bing",
  RANKPROOF_SCAN_PROFILE: "quick",
  GOOGLE_OAUTH_REFRESH_TOKEN: "synthetic-refresh-token",
  GOOGLE_OAUTH_CLIENT_ID: "synthetic-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "synthetic-client-secret",
  BING_WEBMASTER_API_KEY: "synthetic-bing-key",
};
function fixture(trace: string) {
  return `
    import {writeFileSync} from 'node:fs';
    import {setHostResolverForTests} from ${JSON.stringify(source("net.server"))};
    setHostResolverForTests(async () => ['93.184.216.34']);
    globalThis.ownerRequests = {oauth:0,google:0,bing:0};
    const record = kind => {
      globalThis.ownerRequests[kind]++;
      writeFileSync(${JSON.stringify(trace)}, JSON.stringify(globalThis.ownerRequests), {mode:0o600});
    };
    writeFileSync(${JSON.stringify(trace)}, JSON.stringify(globalThis.ownerRequests), {mode:0o600});
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') {
        record('oauth');
        return Response.json({access_token:'synthetic-access-token'});
      }
      if (url.hostname === 'searchconsole.googleapis.com') {
        record('google');
        if (new Headers(init?.headers).get('authorization') !== 'Bearer synthetic-access-token') throw Error('Wrong fixture credential');
        const request = JSON.parse(String(init.body));
        return Response.json({rows:[{keys:request.dimensions?.includes('page') ? ['https://target.example/'] : [${JSON.stringify(canary)}],clicks:9876,impressions:12345,ctr:0.8,position:4}]});
      }
      if (url.hostname === 'ssl.bing.com') {
        record('bing');
        if (url.searchParams.get('apikey') !== 'synthetic-bing-key') throw Error('Wrong fixture credential');
        return Response.json({d:[{Query:${JSON.stringify(canary)},Clicks:345,Impressions:456,AvgImpressionPosition:3}]});
      }
      if (url.pathname === '/robots.txt') return new Response('', {status:404});
      if (url.hostname === 'target.example' || url.hostname === 'rival.example')
        return new Response('<html><head><title>Public target fixture</title></head><body><p>Public readable target information.</p></body></html>', {headers:{'content-type':'text/html'}});
      return Response.json({});
    };
  `;
}
const importFlag = (trace: string) => `data:text/javascript,${encodeURIComponent(fixture(trace))}`;
const ownerCount = (path: string) => {
  const rows = JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
  return Object.values(rows).reduce((sum, value) => sum + value, 0);
};

async function childScript(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "rankproof-webmaster-boundary-"));
  const trace = join(dir, "calls.json");
  try {
    const result = await execute(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        "--import",
        importFlag(trace),
        "--input-type=module",
        "--eval",
        script,
      ],
      { env, timeout: 20_000, maxBuffer: 4_000_000 },
    );
    return { stdout: result.stdout, ownerCalls: ownerCount(trace) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("real full scan and Web handler keep configured operator GSC/Bing private, including exports and reuse", async () => {
  const result = await childScript(`
    import assert from 'node:assert/strict';
    import {registerHooks} from 'node:module';
    import {runScan} from ${JSON.stringify(source("engine.server"))};
    import {scanOptionsFromBody} from ${JSON.stringify(source("service-api"))};
    import {ownerConnector} from ${JSON.stringify(source("connectors.server"))};
    import * as exports from ${JSON.stringify(source("export"))};
    const privateCount = () => Object.values(globalThis.ownerRequests).reduce((a,b) => a+b,0);
    const assertPublic = result => {
      assert.equal(result.ok,true);
      assert.equal(result.report.searchConsole,null);
      assert.equal(result.report.stats.realClicks,0);
      for (const format of [exports.reportJson,exports.reportHtml,exports.backlinksCsv,exports.domainsCsv,exports.keywordsCsv,exports.planCsv,exports.disavowFile])
        assert.ok(!format(result.report).includes(${JSON.stringify(canary)}));
    };
    assertPublic(await runScan('target.example'));
    assertPublic(await runScan('target.example',{profile:'quick',skipSiteAudit:true}));
    assertPublic(await runScan('target.example',scanOptionsFromBody({includeWebmaster:true,authorized:true,isOperator:true,mode:'full',profile:'deep',skipSiteAudit:true})));
    assert.equal(privateCount(),0);
    const empty = ownerConnector({source:'google',credentials:{}});
    assert.equal((await empty.collect({url:'target.example'})).status,'not-configured');
    assert.equal(privateCount(),0);
    const operator = await runScan('target.example',{profile:'quick',skipSiteAudit:true,includeWebmaster:true});
    assert.equal(operator.ok,true);
    assert.equal(operator.report.searchConsole.connected,true);
    assert.ok(JSON.stringify(operator.report.searchConsole).includes(${JSON.stringify(canary)}));
    assert.ok(globalThis.ownerRequests.oauth>0 && globalThis.ownerRequests.google>0 && globalThis.ownerRequests.bing>0);
    const afterOperator = privateCount();
    // Reusing a process/configuration after an owner scan must not reuse its private report.
    assertPublic(await runScan('target.example',{profile:'quick',skipSiteAudit:true}));
    assertPublic(await runScan('target.example',{mode:'light',includeWebmaster:true,skipSiteAudit:true}));
    // Capture the actual Web validator/handler. Only the TanStack transport adapter is replaced;
    // its validator, public options, capacity gate and engine execute unchanged.
    const adapter = 'export function createServerFn(){return {validator(validate){return {handler(handle){return options=>handle({data:validate(options.data)})}}}}}';
    registerHooks({resolve(specifier,context,next){return specifier==='@tanstack/react-start' ? {url:'data:text/javascript,'+encodeURIComponent(adapter),shortCircuit:true} : next(specifier,context)}});
    const {scanBacklinks,scanLinkGap} = await import(${JSON.stringify(source("scan"))});
    assertPublic(await scanBacklinks({data:{url:'target.example',includeWebmaster:true,authorized:true,credentials:{accessToken:'injected-client-token'}}}));
    const gap = await scanLinkGap({data:{url:'target.example',competitors:['rival.example'],includeWebmaster:true}});
    assert.equal(gap.ok,true);
    assert.ok(!JSON.stringify(gap).includes(${JSON.stringify(canary)}));
    assert.equal(privateCount(),afterOperator);
    console.log(JSON.stringify({operatorPositiveControl:true,publicSurfaces:'raw/Web/gap/exports/process-reuse'}));
  `);
  assert.ok(
    result.ownerCalls > 0,
    "positive control actually exercised configured owner credentials",
  );
  assert.equal(JSON.parse(result.stdout).operatorPositiveControl, true);
});

test("actual standalone HTTP scans cannot opt into operator data with JSON or a service Bearer token", async () => {
  for (const serviceToken of ["", "synthetic-service-token"]) {
    const dir = mkdtempSync(join(tmpdir(), "rankproof-webmaster-http-"));
    const trace = join(dir, "calls.json");
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        "--import",
        importFlag(trace),
        "scripts/serve-api.mjs",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
      ],
      { env: { ...env, RANKPROOF_API_TOKEN: serviceToken }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      const endpoint = await new Promise<string>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => reject(new Error(`API exited: ${stderr}`)));
        child.stdout.on("data", (data) => {
          const match = /RankProof API: (http:\/\/127\.0\.0\.1:\d+)/.exec(String(data));
          if (match) resolve(match[1]!);
        });
      });
      const post = (path: string, body: unknown, auth = Boolean(serviceToken)) =>
        fetch(endpoint + path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(auth ? { Authorization: `Bearer ${serviceToken}` } : {}),
          },
          body: JSON.stringify(body),
        });
      if (serviceToken)
        assert.equal(
          (await post("/scan", { url: "target.example", includeWebmaster: true }, false)).status,
          401,
        );
      for (const mode of ["full", "light"]) {
        const response = await post("/scan", {
          url: "target.example",
          mode,
          skipSiteAudit: true,
          includeWebmaster: true,
          authorized: true,
          isOperator: true,
          credentials: { accessToken: "injected" },
        });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.ok, true);
        assert.equal(result.report.searchConsole, null);
        assert.equal(result.report.stats.realClicks, 0);
        assert.ok(!JSON.stringify(result).includes(canary));
      }
      for (const [path, body] of [
        ["/serp", { url: "target.example", keywords: ["public keyword"] }],
        ["/ideas", { keywords: ["public keyword"] }],
        ["/gap", { url: "target.example", competitors: ["rival.example"] }],
      ] as const) {
        const response = await post(path, { ...body, includeWebmaster: true });
        assert.equal(response.status, 200);
        assert.ok(!(await response.text()).includes(canary));
      }
      assert.equal(ownerCount(trace), 0);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, "exit");
        child.kill("SIGTERM");
        await stopped;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("actual CLI output formats keep configured owner data private until explicit local --webmaster", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rankproof-webmaster-cli-"));
  const trace = join(dir, "calls.json");
  const run = async (format: string, owner = false) =>
    execute(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        "--import",
        importFlag(trace),
        "bin/rankproof.mjs",
        "scan",
        "target.example",
        "--profile",
        "quick",
        "--skip-audit",
        "--quiet",
        "--format",
        format,
        ...(owner ? ["--webmaster"] : []),
      ],
      { env, timeout: 20_000, maxBuffer: 4_000_000 },
    );
  try {
    for (const format of ["json", "html", "csv", "text", "disavow"]) {
      const result = await run(format);
      assert.ok(!result.stdout.includes(canary), format);
      assert.equal(ownerCount(trace), 0, format);
    }
    const result = await run("json", true);
    const report = JSON.parse(result.stdout);
    assert.equal(report.searchConsole.connected, true);
    assert.ok(result.stdout.includes(canary));
    assert.ok(ownerCount(trace) > 0);
    for (const secret of [
      env.GOOGLE_OAUTH_REFRESH_TOKEN,
      env.GOOGLE_OAUTH_CLIENT_SECRET,
      env.BING_WEBMASTER_API_KEY,
    ])
      assert.ok(!result.stdout.includes(secret));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
