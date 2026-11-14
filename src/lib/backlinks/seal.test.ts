import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSeal,
  generateSigningKey,
  sealCheckText,
  sealFile,
  timeStampRequest,
} from "./seal.server.ts";

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

async function tempRun() {
  const dir = await mkdtemp(join(tmpdir(), "rankproof-seal-"));
  const path = join(dir, "run.json");
  await writeFile(
    path,
    JSON.stringify({
      kind: "rankproof.verify-run",
      results: [
        { source_url: "https://pub.example/a" },
        { source_url: "https://pub.example/a" },
        { source_url: "https://other.example/" },
      ],
    }),
  );
  return { dir, path };
}

/** A real RFC 3161 TSA: OpenSSL with a throwaway CA, behind a fetch stub. */
async function opensslTsa(dir: string) {
  const cnf = join(dir, "ts.cnf");
  await writeFile(join(dir, "serial"), "01\n");
  await writeFile(
    cnf,
    `[ tsa ]\ndefault_tsa = t\n[ t ]\nserial = ${join(dir, "serial")}\ncrypto_device = builtin\nsigner_cert = ${join(dir, "tsa.crt")}\ncerts = ${join(dir, "ca.crt")}\nsigner_key = ${join(dir, "tsa.key")}\nsigner_digest = sha256\ndefault_policy = 1.2.3.4.1\ndigests = sha256\naccuracy = secs:1\nordering = yes\ness_cert_id_alg = sha256\n[ v3_tsa ]\nbasicConstraints = CA:FALSE\nkeyUsage = critical, digitalSignature, nonRepudiation\nextendedKeyUsage = critical, timeStamping\n[ v3_ca ]\nbasicConstraints = critical, CA:TRUE\nkeyUsage = critical, keyCertSign, cRLSign\n[ req ]\ndistinguished_name = dn\n[ dn ]\n`,
  );
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  run([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-subj",
    "/CN=Test CA",
    "-days",
    "2",
    "-config",
    cnf,
    "-extensions",
    "v3_ca",
  ]);
  run([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "tsa.key",
    "-out",
    "tsa.csr",
    "-subj",
    "/CN=Test TSA",
    "-config",
    cnf,
  ]);
  run([
    "x509",
    "-req",
    "-in",
    "tsa.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "tsa.crt",
    "-days",
    "2",
    "-extfile",
    cnf,
    "-extensions",
    "v3_tsa",
  ]);
  return (async (_url: string, init: RequestInit) => {
    await writeFile(join(dir, "q.tsq"), Buffer.from(init.body as Uint8Array));
    run(["ts", "-reply", "-queryfile", "q.tsq", "-out", "r.tsr", "-config", cnf]);
    return new Response(new Uint8Array(await readFile(join(dir, "r.tsr"))), { status: 200 });
  }) as typeof fetch;
}

test("signature: valid, bound to the expected key, and broken by any edit", async () => {
  const { path } = await tempRun();
  const key = generateSigningKey();
  const { seal } = await sealFile(path, { keyPem: key.privatePem });
  const ok = await checkSeal(path, seal, { publicKeyPem: key.publicPem });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, "verified");
  assert.match(sealCheckText(ok), /Seal OK/);
  // Without --public-key the signer is unknown: intact, but not OK.
  const anySigner = await checkSeal(path, seal);
  assert.equal(anySigner.status, "unverified");
  assert.equal(anySigner.ok, false);
  assert.doesNotMatch(sealCheckText(anySigner), /Seal OK/);
  assert.match(sealCheckText(anySigner), /NOT fully verified: .*signer was not verified/);
  const stranger = generateSigningKey();
  const wrongSigner = await checkSeal(path, seal, { publicKeyPem: stranger.publicPem });
  assert.equal(wrongSigner.ok, false);
  assert.equal(wrongSigner.status, "failed");
  await writeFile(path, (await readFile(path, "utf8")).replace("pub.example", "pwn.example"));
  const tampered = await checkSeal(path, seal);
  assert.equal(tampered.ok, false);
  assert.equal(tampered.checks[0]!.name, "file hash");
  // A forged statement inside the seal does not help either.
  const forged = { ...seal, file: { ...seal.file, sha256: "0".repeat(64) } };
  assert.equal(
    (await checkSeal(path, forged)).checks.find((c) => c.name === "signature")!.ok,
    false,
  );
});

test(
  "RFC 3161 timestamp from a real (OpenSSL) TSA verifies with openssl ts -verify",
  { skip: !hasOpenssl },
  async () => {
    const { dir, path } = await tempRun();
    const tsa = await opensslTsa(dir);
    const { seal, tokenPath } = await sealFile(path, {
      tsaUrl: "https://tsa.example/",
      fetchImpl: tsa,
    });
    assert.equal(seal.timestamp!.status, "granted");
    assert.match(seal.timestamp!.gen_time!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const result = await checkSeal(path, seal);
    // The token's structure matches, but its CMS signature is not checked here.
    assert.equal(result.status, "unverified");
    assert.equal(result.ok, false);
    assert.equal(result.checks.find((c) => c.name === "timestamp")!.ok, null);
    const text = sealCheckText(result);
    assert.doesNotMatch(text, /✓ timestamp|Seal OK/);
    assert.match(text, /\? timestamp\s+Structurally consistent/);
    assert.match(text, /openssl ts -verify/);
    const verify = spawnSync("openssl", [
      "ts",
      "-verify",
      "-data",
      path,
      "-in",
      tokenPath!,
      "-CAfile",
      join(dir, "ca.crt"),
    ]);
    assert.equal(verify.status, 0, verify.stderr.toString());
    assert.match(verify.stdout.toString(), /Verification: OK/);
    // The token no longer matches once the file changes.
    await writeFile(path, "{}");
    assert.equal((await checkSeal(path, seal)).status, "failed");
  },
);

test("the timestamp request is DER that OpenSSL parses", { skip: !hasOpenssl }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "rankproof-tsq-"));
  const digest = Buffer.alloc(32, 0xab);
  await writeFile(join(dir, "q.tsq"), timeStampRequest(digest, Buffer.from([0x80, 1, 2, 3])));
  const text = execFileSync("openssl", [
    "ts",
    "-query",
    "-in",
    join(dir, "q.tsq"),
    "-text",
  ]).toString();
  assert.match(text, /Hash Algorithm: sha256/);
  assert.match(text, /Nonce: 0x80010203/);
  assert.match(text, /Certificate required: yes/);
});

test("wayback: unique sources, snapshot URLs parsed, failures recorded not hidden", async () => {
  const { path } = await tempRun();
  const asked: string[] = [];
  const fake = (async (url: string) => {
    asked.push(url);
    if (url.includes("other.example")) return new Response("", { status: 429 });
    return new Response("", {
      status: 302,
      headers: { location: "https://web.archive.org/web/20261112101500/https://pub.example/a" },
    });
  }) as typeof fetch;
  const { seal } = await sealFile(path, { wayback: true, fetchImpl: fake });
  assert.equal(asked.length, 2, "duplicates are archived once");
  assert.equal(seal.archives[0]!.status, "saved");
  assert.equal(seal.archives[0]!.archived_at, "2026-11-12T10:15:00Z");
  assert.equal(seal.archives[1]!.status, "failed");
  const result = await checkSeal(path, seal);
  assert.equal(result.ok, true, "a missing archive copy does not falsify the file");
  assert.ok(
    result.checks.some((c) => c.name === "archive" && /not archived/.test(c.detail)),
    "but it is reported",
  );
});

test("TSA URL goes through the URL policy", async () => {
  const { path } = await tempRun();
  await assert.rejects(() => sealFile(path, { tsaUrl: "http://169.254.169.254/tsa" }), /refused/);
});

test("keygen refuses to overwrite an existing key unless --force", async () => {
  const { fileURLToPath } = await import("node:url");
  const bin = fileURLToPath(new URL("../../../bin/rankproof.mjs", import.meta.url));
  const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
  const dir = await mkdtemp(join(tmpdir(), "rankproof-keygen-"));
  const out = join(dir, "signing");
  const keygen = (...extra: string[]) =>
    spawnSync(process.execPath, [bin, "keygen", "--out", out, ...extra], { env });
  assert.equal(keygen().status, 0);
  const original = await readFile(`${out}.pem`, "utf8");
  const again = keygen();
  assert.notEqual(again.status, 0);
  assert.match(again.stderr.toString(), /refusing to overwrite a signing key/);
  assert.equal(await readFile(`${out}.pem`, "utf8"), original, "the existing key is untouched");
  assert.equal(keygen("--force").status, 0);
  assert.notEqual(await readFile(`${out}.pem`, "utf8"), original);
});
