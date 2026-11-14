/**
 * `rankproof export-warc`: package captured evidence as a WARC 1.1 file
 * (ISO 28500), the format web archives use, so evidence can live outside
 * RankProof and be opened with standard tools (warcio, pywb, ReplayWeb.page).
 *
 * Per captured observation:
 *   - one `resource` record: the exact body that was hashed, at the final URL.
 *     Not `response`: RankProof does not store raw HTTP headers, and a WARC
 *     must not pretend otherwise.
 *   - one `metadata` record (WARC-Concurrent-To the resource): the RankProof
 *     observation and contract as JSON.
 * Each record is gzipped separately (standard .warc.gz), so tools can seek.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { previousObservations, type ObservationLike } from "./observe.ts";
import { isResponseHash } from "./measurement.server.ts";

const CRLF = "\r\n";

/** RFC 4648 base32 with padding. */
export function base32(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    // Keep only the bits not yet emitted, so the buffer never exceeds 13 bits.
    value = ((value & ((1 << bits) - 1)) << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  // Pad to a multiple of 8: a SHA-256 digest (32 bytes) needs "====", and
  // readers such as warcio decode strictly.
  while (out.length % 8 !== 0) out += "=";
  return out;
}

const digest = (block: Buffer) => `sha256:${base32(createHash("sha256").update(block).digest())}`;

function record(headers: [string, string][], block: Buffer): Buffer {
  const head =
    ["WARC/1.1", ...headers.map(([k, v]) => `${k}: ${v.replace(/[\r\n]+/g, " ")}`)].join(CRLF) +
    `${CRLF}Content-Length: ${block.length}${CRLF}${CRLF}`;
  return gzipSync(Buffer.concat([Buffer.from(head, "utf8"), block, Buffer.from(CRLF + CRLF)]));
}

const recordId = () => `<urn:uuid:${randomUUID()}>`;
const warcDate = (iso: string | null | undefined) =>
  new Date(iso && !Number.isNaN(Date.parse(iso)) ? iso : Date.now())
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

export type WarcExport = {
  bytes: Buffer;
  records: number;
  included: number;
  skipped: { source_url: string; reason: string }[];
};

export async function exportWarc(
  runJson: unknown,
  captureDir: string,
  meta: { software: string; filename: string },
): Promise<WarcExport> {
  const observations = previousObservations(runJson) as (ObservationLike & {
    final_url?: string | null;
    http_status?: number | null;
    extraction_version?: string;
    identity_policy?: string;
  })[];
  const parts: Buffer[] = [];
  const info = Buffer.from(
    [
      `software: ${meta.software}`,
      "format: WARC File Format 1.1",
      "conformsTo: https://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/",
      "description: RankProof link-verification evidence. resource records hold the exact bodies that were hashed and parsed; metadata records hold the observation. HTTP headers were not captured.",
      `generated: ${new Date().toISOString()}`,
    ].join(CRLF) + CRLF,
    "utf8",
  );
  parts.push(
    record(
      [
        ["WARC-Type", "warcinfo"],
        ["WARC-Date", warcDate(null)],
        ["WARC-Filename", meta.filename],
        ["WARC-Record-ID", recordId()],
        ["Content-Type", "application/warc-fields"],
      ],
      info,
    ),
  );
  let included = 0;
  const skipped: WarcExport["skipped"] = [];
  const written = new Map<string, string>();
  for (const item of observations) {
    if (!item.response_hash) {
      skipped.push({ source_url: item.source_url, reason: "no response body was recorded" });
      continue;
    }
    if (!isResponseHash(item.response_hash)) {
      skipped.push({ source_url: item.source_url, reason: "response_hash is not a SHA-256" });
      continue;
    }
    let resourceId = written.get(item.response_hash);
    if (!resourceId) {
      let body: Buffer;
      let captured: {
        final_url?: string;
        http_status?: number;
        content_type?: string;
        captured_at?: string;
      };
      try {
        body = await readFile(join(captureDir, `${item.response_hash}.html`));
        captured = JSON.parse(
          await readFile(join(captureDir, `${item.response_hash}.json`), "utf8"),
        );
      } catch {
        skipped.push({
          source_url: item.source_url,
          reason: "snapshot not in the capture directory",
        });
        continue;
      }
      const hex = createHash("sha256").update(body.toString("utf8")).digest("hex");
      if (hex !== item.response_hash) {
        skipped.push({
          source_url: item.source_url,
          reason: "snapshot fails its SHA-256 (modified?)",
        });
        continue;
      }
      resourceId = recordId();
      written.set(item.response_hash, resourceId);
      parts.push(
        record(
          [
            ["WARC-Type", "resource"],
            ["WARC-Record-ID", resourceId],
            ["WARC-Date", warcDate(captured.captured_at ?? item.checked_at)],
            ["WARC-Target-URI", item.final_url ?? captured.final_url ?? item.source_url],
            ["Content-Type", captured.content_type || "text/html"],
            ["WARC-Block-Digest", digest(body)],
            ["WARC-Payload-Digest", digest(body)],
            ["RankProof-Response-SHA256", item.response_hash],
            ["RankProof-HTTP-Status", String(item.http_status ?? captured.http_status ?? "")],
          ],
          body,
        ),
      );
    }
    const metaBlock = Buffer.from(`${JSON.stringify(item, null, 2)}\n`, "utf8");
    parts.push(
      record(
        [
          ["WARC-Type", "metadata"],
          ["WARC-Record-ID", recordId()],
          ["WARC-Concurrent-To", resourceId],
          ["WARC-Date", warcDate(item.checked_at)],
          ["WARC-Target-URI", item.source_url],
          ["Content-Type", "application/json"],
          ["WARC-Block-Digest", digest(metaBlock)],
        ],
        metaBlock,
      ),
    );
    included += 1;
  }
  return { bytes: Buffer.concat(parts), records: parts.length, included, skipped };
}

/** Minimal reader for tests and for checking an export: headers + block per record. */
export function readWarc(gz: Buffer): { headers: Record<string, string>; block: Buffer }[] {
  // gunzipSync decodes concatenated gzip members as one stream.
  const raw = gunzipSync(gz);
  const out: { headers: Record<string, string>; block: Buffer }[] = [];
  let at = 0;
  while (at < raw.length) {
    const end = raw.indexOf("\r\n\r\n", at);
    if (end === -1) break;
    const lines = raw.subarray(at, end).toString("utf8").split("\r\n");
    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(":");
      headers[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    const length = Number(headers["Content-Length"]);
    const block = raw.subarray(end + 4, end + 4 + length);
    out.push({ headers, block });
    at = end + 4 + length + 4;
  }
  return out;
}
