/**
 * Evidence seals: `rankproof seal run.json` and `rankproof check-seal run.json`.
 *
 * A seal is a separate JSON file next to a run (or any evidence file) with up
 * to three independent layers:
 *
 *   1. Ed25519 signature — who produced the file (the holder of a key).
 *   2. RFC 3161 timestamp — a Time Stamping Authority attests that this exact
 *      SHA-256 existed at genTime. The raw token is stored as `<file>.tsr`, so
 *      it can be verified with standard tooling: `openssl ts -verify`.
 *   3. Web-archive snapshots — the Internet Archive's own capture of each
 *      source page, made by a third party at (nearly) the same time.
 *
 * What a seal does NOT do is described in docs/evidence.md: a signature and a
 * timestamp prove integrity and time, not that a publisher served the page to
 * everyone; an archive snapshot is the archive's observation, not RankProof's.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { guardUrl } from "./ssrf.ts";

export const SEAL_VERSION = 1;

export type Seal = {
  kind: "rankproof.seal";
  version: typeof SEAL_VERSION;
  sealed_at: string;
  file: { name: string; sha256: string; bytes: number };
  signature: { algorithm: "ed25519"; public_key: string; value: string; signed: string } | null;
  timestamp: {
    tsa_url: string;
    token_file: string;
    hash_algorithm: "sha256";
    nonce: string;
    status: "granted" | "granted_with_mods";
    gen_time: string | null;
  } | null;
  archives: {
    source_url: string;
    status: "saved" | "existing" | "failed";
    archive_url: string | null;
    archived_at: string | null;
    reason: string | null;
  }[];
};

/* ------------------------------------------------------------------ */
/* Ed25519                                                             */
/* ------------------------------------------------------------------ */

export function generateSigningKey(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** The exact bytes that get signed: a domain-separated statement, not the raw file. */
export function signedStatement(sha256: string, sealedAt: string, name: string): string {
  return `rankproof-seal-v${SEAL_VERSION}\nsha256:${sha256}\nsealed_at:${sealedAt}\nfile:${name}\n`;
}

/* ------------------------------------------------------------------ */
/* RFC 3161: minimal DER for TimeStampReq and a structural response check */
/* ------------------------------------------------------------------ */

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, value: Buffer) =>
  Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
const SHA256_OID = Buffer.from([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);

function derPositiveInteger(bytes: Buffer): Buffer {
  let value = bytes;
  while (value.length > 1 && value[0] === 0 && (value[1]! & 0x80) === 0) value = value.subarray(1);
  if (value[0]! & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return tlv(0x02, value);
}

/** TimeStampReq (RFC 3161 §2.4.1): v1, SHA-256 imprint, nonce, certReq = TRUE. */
export function timeStampRequest(sha256: Buffer, nonce: Buffer): Buffer {
  const algorithm = tlv(0x30, Buffer.concat([SHA256_OID, Buffer.from([0x05, 0x00])]));
  const imprint = tlv(0x30, Buffer.concat([algorithm, tlv(0x04, sha256)]));
  return tlv(
    0x30,
    Buffer.concat([
      tlv(0x02, Buffer.from([1])),
      imprint,
      derPositiveInteger(nonce),
      Buffer.from([0x01, 0x01, 0xff]),
    ]),
  );
}

type Der = { tag: number; start: number; header: number; length: number };
function readDer(buf: Buffer, at: number): Der {
  const tag = buf[at]!;
  let length = buf[at + 1]!;
  let header = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new Error("Unsupported DER length.");
    length = 0;
    for (let i = 0; i < count; i++) length = (length << 8) | buf[at + 2 + i]!;
    header += count;
  }
  if (at + header + length > buf.length) throw new Error("Truncated DER.");
  return { tag, start: at, header, length };
}

/**
 * Checks a TimeStampResp structurally: PKIStatus granted, and the token
 * contains our exact SHA-256 imprint and nonce. Extracts genTime. The TSA's
 * CMS signature is verified with `openssl ts -verify` (see check-seal output);
 * this function never claims cryptographic validity on its own.
 */
export function inspectTimeStampResponse(
  response: Buffer,
  sha256: Buffer,
  nonce: Buffer,
): { status: "granted" | "granted_with_mods"; genTime: string | null } {
  const outer = readDer(response, 0);
  if (outer.tag !== 0x30) throw new Error("Not a TimeStampResp.");
  const statusInfo = readDer(response, outer.start + outer.header);
  const statusInt = readDer(response, statusInfo.start + statusInfo.header);
  const status = response[statusInt.start + statusInt.header + statusInt.length - 1]!;
  if (status !== 0 && status !== 1) {
    throw new Error(`The TSA refused the request (PKIStatus ${status}).`);
  }
  const tokenStart = statusInfo.start + statusInfo.header + statusInfo.length;
  if (tokenStart >= outer.start + outer.header + outer.length) {
    throw new Error("The TSA response has no timeStampToken.");
  }
  const token = response.subarray(tokenStart, outer.start + outer.header + outer.length);
  const imprintAt = token.indexOf(Buffer.concat([Buffer.from([0x04, 0x20]), sha256]));
  if (imprintAt === -1) throw new Error("The timestamp token does not cover this file's SHA-256.");
  const nonceDer = derPositiveInteger(nonce);
  if (token.indexOf(nonceDer, imprintAt) === -1)
    throw new Error("The timestamp token has a different nonce.");
  // genTime is the first GeneralizedTime after the imprint inside TSTInfo.
  let genTime: string | null = null;
  for (let i = imprintAt + 34; i < token.length - 2; i++) {
    if (token[i] === 0x18 && token[i + 1]! >= 15 && token[i + 1]! <= 24) {
      const text = token.subarray(i + 2, i + 2 + token[i + 1]!).toString("ascii");
      const m = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/);
      if (m) {
        genTime = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ?? ""}Z`;
        break;
      }
    }
  }
  return { status: status === 0 ? "granted" : "granted_with_mods", genTime };
}

function assertServiceUrl(raw: string, what: string): void {
  if (process.env.RANKPROOF_SEAL_ALLOW_PRIVATE === "1") return;
  const verdict = guardUrl(raw);
  if (!verdict.allowed) {
    throw new Error(
      `${what} URL refused: ${verdict.reason} (RANKPROOF_SEAL_ALLOW_PRIVATE=1 for an internal service).`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Internet Archive                                                    */
/* ------------------------------------------------------------------ */

const WAYBACK = "https://web.archive.org";

/** Asks the Wayback Machine to capture a page now ("Save Page Now"). */
export async function archiveSnapshot(
  sourceUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Seal["archives"][number]> {
  const base = { source_url: sourceUrl, archive_url: null, archived_at: null, reason: null };
  try {
    const res = await fetchImpl(`${WAYBACK}/save/${sourceUrl}`, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": "RankProof/seal (+https://github.com/CometWeb-io/rankproof)" },
      signal: AbortSignal.timeout(60_000),
    });
    const location = res.headers.get("content-location") ?? res.headers.get("location");
    const match = location?.match(/\/web\/(\d{14})\/(.+)$/);
    if ((res.ok || (res.status >= 300 && res.status < 400)) && match) {
      const [, stamp] = match;
      return {
        ...base,
        status: "saved",
        archive_url: new URL(location!, WAYBACK).href,
        archived_at: `${stamp!.slice(0, 4)}-${stamp!.slice(4, 6)}-${stamp!.slice(6, 8)}T${stamp!.slice(8, 10)}:${stamp!.slice(10, 12)}:${stamp!.slice(12, 14)}Z`,
      };
    }
    return {
      ...base,
      status: "failed",
      reason: `Save Page Now answered HTTP ${res.status} without a snapshot.`,
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/* ------------------------------------------------------------------ */
/* seal / check-seal                                                   */
/* ------------------------------------------------------------------ */

export async function sealFile(
  path: string,
  options: {
    keyPem?: string | null;
    tsaUrl?: string | null;
    wayback?: boolean;
    fetchImpl?: typeof fetch;
    log?: (message: string) => void;
    now?: string;
  },
): Promise<{ seal: Seal; tokenPath: string | null }> {
  const log = options.log ?? (() => {});
  const fetchImpl = options.fetchImpl ?? fetch;
  const bytes = await readFile(path);
  const digest = createHash("sha256").update(bytes).digest();
  const sha256 = digest.toString("hex");
  const sealedAt = options.now ?? new Date().toISOString();
  const name = basename(path);
  const seal: Seal = {
    kind: "rankproof.seal",
    version: SEAL_VERSION,
    sealed_at: sealedAt,
    file: { name, sha256, bytes: bytes.length },
    signature: null,
    timestamp: null,
    archives: [],
  };

  if (options.keyPem) {
    const key = createPrivateKey(options.keyPem);
    if (key.asymmetricKeyType !== "ed25519")
      throw new Error("--key must be an Ed25519 private key (rankproof keygen).");
    const statement = signedStatement(sha256, sealedAt, name);
    seal.signature = {
      algorithm: "ed25519",
      public_key: createPublicKey(key).export({ type: "spki", format: "pem" }).toString(),
      value: edSign(null, Buffer.from(statement), key).toString("base64"),
      signed: statement,
    };
    log("Signed with Ed25519.");
  }

  let tokenPath: string | null = null;
  if (options.tsaUrl) {
    assertServiceUrl(options.tsaUrl, "TSA");
    const nonce = randomBytes(8);
    const res = await fetchImpl(options.tsaUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/timestamp-query",
        Accept: "application/timestamp-reply",
      },
      body: new Uint8Array(timeStampRequest(digest, nonce)),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`TSA answered HTTP ${res.status}.`);
    const reply = Buffer.from(await res.arrayBuffer());
    const checked = inspectTimeStampResponse(reply, digest, nonce);
    tokenPath = `${path}.tsr`;
    await writeFile(tokenPath, reply);
    seal.timestamp = {
      tsa_url: options.tsaUrl,
      token_file: basename(tokenPath),
      hash_algorithm: "sha256",
      nonce: nonce.toString("hex"),
      status: checked.status,
      gen_time: checked.genTime,
    };
    log(`Timestamped by ${options.tsaUrl}${checked.genTime ? ` at ${checked.genTime}` : ""}.`);
  }

  if (options.wayback) {
    let sources: string[] = [];
    try {
      const json = JSON.parse(bytes.toString("utf8")) as { results?: { source_url?: unknown }[] };
      sources = [
        ...new Set(
          (json.results ?? [])
            .map((r) => r.source_url)
            .filter((u): u is string => typeof u === "string"),
        ),
      ];
    } catch {
      throw new Error("--wayback needs a RankProof run (JSON with results).");
    }
    for (const [index, source] of sources.entries()) {
      log(`Archiving ${index + 1}/${sources.length}: ${source}`);
      seal.archives.push(await archiveSnapshot(source, fetchImpl));
      // Save Page Now is rate-limited for anonymous use; be a good citizen.
      if (index < sources.length - 1 && !options.fetchImpl)
        await new Promise((r) => setTimeout(r, 5000));
    }
  }

  if (!seal.signature && !seal.timestamp && seal.archives.length === 0) {
    log("No --key, --tsa or --wayback: the seal records only the SHA-256.");
  }
  return { seal, tokenPath };
}

export type SealCheck = {
  /**
   * `verified`: every check passed. `unverified`: nothing failed, but at least one
   * claim (the signer without --public-key, the TSA's CMS signature) was not
   * verified here. `failed`: a check failed (CLI exit 3).
   */
  status: "verified" | "unverified" | "failed";
  /** True only when `status` is `verified`. */
  ok: boolean;
  /** `ok: null` is a claim not verified here; archive notes are informational. */
  checks: { name: string; ok: boolean | null; detail: string }[];
  openssl: string | null;
};

export async function checkSeal(
  path: string,
  sealJson: unknown,
  options: { publicKeyPem?: string | null; tokenPath?: string | null } = {},
): Promise<SealCheck> {
  const seal = sealJson as Seal;
  if (seal?.kind !== "rankproof.seal") throw new Error("Not a RankProof seal file.");
  const checks: SealCheck["checks"] = [];
  const bytes = await readFile(path);
  const digest = createHash("sha256").update(bytes).digest();
  const sha256 = digest.toString("hex");
  checks.push({
    name: "file hash",
    ok: sha256 === seal.file.sha256,
    detail:
      sha256 === seal.file.sha256
        ? `SHA-256 ${sha256} matches.`
        : `The file changed since it was sealed (now ${sha256}, sealed ${seal.file.sha256}).`,
  });

  if (seal.signature) {
    const statement = signedStatement(seal.file.sha256, seal.sealed_at, seal.file.name);
    let ok = statement === seal.signature.signed;
    try {
      ok =
        ok &&
        edVerify(
          null,
          Buffer.from(statement),
          createPublicKey(seal.signature.public_key),
          Buffer.from(seal.signature.value, "base64"),
        );
    } catch {
      ok = false;
    }
    checks.push({
      name: "signature",
      ok,
      detail: ok
        ? "Ed25519 signature is valid for the embedded public key."
        : "The signature does not verify.",
    });
    if (options.publicKeyPem) {
      const expected = createPublicKey(options.publicKeyPem).export({
        type: "spki",
        format: "der",
      });
      const embedded = createPublicKey(seal.signature.public_key).export({
        type: "spki",
        format: "der",
      });
      const same = Buffer.compare(expected, embedded) === 0;
      checks.push({
        name: "signer",
        ok: same,
        detail: same
          ? "Signed by the expected key."
          : "Signed by a different key than --public-key.",
      });
    } else {
      checks.push({
        name: "signer",
        ok: null,
        detail: "No --public-key given: the signature proves integrity, not who the signer is.",
      });
    }
  }

  let openssl: string | null = null;
  if (seal.timestamp) {
    const tokenPath = options.tokenPath ?? `${path}.tsr`;
    try {
      const reply = await readFile(tokenPath);
      const checked = inspectTimeStampResponse(
        reply,
        digest,
        Buffer.from(seal.timestamp.nonce, "hex"),
      );
      // Only the structure is checked here; the TSA's CMS signature is not.
      checks.push({
        name: "timestamp",
        ok: null,
        detail: `Structurally consistent: the token covers this SHA-256 and nonce; genTime ${checked.genTime ?? "unknown"}. The TSA's signature was NOT verified; check it with the openssl command below.`,
      });
      openssl = `openssl ts -verify -data "${path}" -in "${tokenPath}" -CAfile <TSA CA certificate>`;
    } catch (error) {
      checks.push({
        name: "timestamp",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const archive of seal.archives) {
    checks.push({
      name: "archive",
      // A missing archive copy weakens the evidence but does not falsify it.
      ok: null,
      detail:
        archive.status === "failed"
          ? `${archive.source_url}: not archived (${archive.reason}).`
          : `${archive.source_url}: open ${archive.archive_url} to see the Internet Archive's own capture.`,
    });
  }
  const status = checks.some((c) => c.ok === false)
    ? "failed"
    : checks.some((c) => c.ok === null && c.name !== "archive")
      ? "unverified"
      : "verified";
  return { status, ok: status === "verified", checks, openssl };
}

export function sealCheckText(result: SealCheck): string {
  const mark = (c: SealCheck["checks"][number]) =>
    c.ok === true ? "✓" : c.ok === false ? "✗" : c.name === "archive" ? "·" : "?";
  const lines = result.checks.map((c) => `${mark(c)} ${c.name.padEnd(10)} ${c.detail}`);
  if (result.openssl)
    lines.push("", `TSA signature (not verified by RankProof): ${result.openssl}`);
  const unverified = result.checks
    .filter((c) => c.ok === null && c.name !== "archive")
    .map((c) => c.name);
  lines.push(
    "",
    result.status === "verified"
      ? "Seal OK: every check verified."
      : result.status === "unverified"
        ? `Seal NOT fully verified: nothing failed, but ${unverified.join(" and ")} ${unverified.length === 1 ? "was" : "were"} not verified (marked ?).`
        : "Seal check FAILED.",
  );
  return lines.join("\n");
}
