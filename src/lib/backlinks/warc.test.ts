import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base32, exportWarc, readWarc } from "./warc.server.ts";

test("base32 follows RFC 4648, padding included", () => {
  const vectors: [string, string][] = [
    ["", ""],
    ["f", "MY======"],
    ["fo", "MZXQ===="],
    ["foo", "MZXW6==="],
    ["foob", "MZXW6YQ="],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI======"],
  ];
  for (const [input, expected] of vectors)
    assert.equal(base32(Buffer.from(input)), expected, input);
  // A SHA-256 digest is 32 bytes: 52 characters plus 4 padding characters.
  const digest = createHash("sha256").update("x").digest();
  assert.equal(base32(digest).length, 56);
  // Cross-checked with Python: base64.b32encode(hashlib.sha256(b"x").digest())
  assert.equal(base32(digest), "FVYRMQVXE2YEIALCPSU7XLBS6XEFGD5RSA6MJWYCEWDRPEQ2JCAQ====");
});

test("export-warc packages captured bodies and observations; skips what it cannot prove", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rankproof-warc-"));
  const html = "<html><body><a href='https://brand.example/'>Brand</a></body></html>";
  const hash = createHash("sha256").update(html).digest("hex");
  await writeFile(join(dir, `${hash}.html`), html);
  await writeFile(
    join(dir, `${hash}.json`),
    JSON.stringify({
      final_url: "https://pub.example/post",
      http_status: 200,
      content_type: "text/html; charset=utf-8",
      captured_at: "2026-11-12T10:00:00.000Z",
    }),
  );
  const base = {
    target_url: "https://brand.example/",
    checked_at: "2026-11-12T10:00:00.000Z",
    anchor: "Brand",
    rel: "",
    reason: null,
  };
  const run = {
    results: [
      { ...base, source_url: "https://pub.example/post", status: "confirmed", response_hash: hash },
      { ...base, source_url: "https://down.example/", status: "error", response_hash: null },
      {
        ...base,
        source_url: "https://lost.example/",
        status: "confirmed",
        response_hash: "f".repeat(64),
      },
      // Used as a file name: anything but a SHA-256 hex digest is refused.
      {
        ...base,
        source_url: "https://path.example/",
        status: "confirmed",
        response_hash: `../${hash}`,
      },
    ],
  };
  const out = await exportWarc(run, dir, { software: "RankProof test", filename: "t.warc.gz" });
  assert.equal(out.included, 1);
  assert.deepEqual(
    out.skipped.map((s) => s.source_url),
    ["https://down.example/", "https://lost.example/", "https://path.example/"],
  );
  assert.equal(out.skipped[2]!.reason, "response_hash is not a SHA-256");
  const records = readWarc(out.bytes);
  assert.deepEqual(
    records.map((r) => r.headers["WARC-Type"]),
    ["warcinfo", "resource", "metadata"],
  );
  const [, resource, metadata] = records;
  assert.equal(resource!.block.toString("utf8"), html);
  assert.equal(resource!.headers["WARC-Target-URI"], "https://pub.example/post");
  assert.equal(resource!.headers["RankProof-Response-SHA256"], hash);
  assert.equal(
    resource!.headers["WARC-Block-Digest"],
    `sha256:${base32(createHash("sha256").update(html).digest())}`,
  );
  assert.equal(metadata!.headers["WARC-Concurrent-To"], resource!.headers["WARC-Record-ID"]);
  assert.equal(JSON.parse(metadata!.block.toString("utf8")).status, "confirmed");
});
