import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCorpus, loadCorpus } from "./corpus.server.ts";
import { runBenchmark } from "./benchmark.ts";

test("corpus: suggestions are not labels; only reviewed cases are scored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rankproof-corpus-"));
  const html = `<html><body><p>See <a href="https://brand.example/">Brand</a></p></body></html>`;
  const hash = createHash("sha256").update(html).digest("hex");
  await writeFile(join(dir, `${hash}.html`), html);
  await writeFile(
    join(dir, `${hash}.json`),
    JSON.stringify({
      final_url: "https://pub.example/a",
      http_status: 200,
      content_type: "text/html",
    }),
  );
  const corpus = await buildCorpus(
    {
      results: [
        {
          source_url: "https://pub.example/a",
          target_url: "https://brand.example/",
          status: "confirmed",
          checked_at: "2026-11-12T10:00:00.000Z",
          anchor: "Brand",
          rel: "",
          reason: null,
          response_hash: hash,
        },
        // No body: cannot become a case.
        {
          source_url: "https://down.example/",
          target_url: "https://brand.example/",
          status: "error",
          checked_at: "2026-11-12T10:00:00.000Z",
          anchor: null,
          rel: null,
          reason: "timeout",
          response_hash: null,
        },
      ],
    },
    dir,
  );
  assert.equal(corpus.cases.length, 1);
  assert.equal(corpus.cases[0]!.reviewed, false);
  assert.equal(corpus.cases[0]!.suggested.anchor, "Brand");
  assert.equal(loadCorpus(corpus).scored.length, 0, "unreviewed cases are ignored");

  // A reviewer disagrees with RankProof: the benchmark must report a failure.
  corpus.cases[0]!.reviewed = true;
  corpus.cases[0]!.expected = { status: "not_found" };
  const report = runBenchmark(loadCorpus(corpus).scored);
  assert.equal(report.passed, 0);
  assert.throws(() => loadCorpus({ kind: "nope" }));
});

test("corpus: ids hash the whole target URL; bad hashes and edited snapshots are skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rankproof-corpus-"));
  const html = `<html><body><p>See <a href="https://brand.example/">Brand</a></p></body></html>`;
  const hash = createHash("sha256").update(html).digest("hex");
  await writeFile(join(dir, `${hash}.html`), html);
  await writeFile(join(dir, `${hash}.json`), JSON.stringify({ http_status: 200 }));
  // An edited snapshot: its file name no longer matches its bytes.
  const edited = createHash("sha256").update("original").digest("hex");
  await writeFile(join(dir, `${edited}.html`), "tampered");
  await writeFile(join(dir, `${edited}.json`), JSON.stringify({ http_status: 200 }));
  // A path-like hash pointing at a file that does exist outside the naming scheme.
  await writeFile(join(dir, "x.html"), html);
  await writeFile(join(dir, "x.json"), "{}");
  const row = (target_url: string, response_hash: string) => ({
    source_url: "https://pub.example/a",
    target_url,
    status: "confirmed",
    checked_at: "2026-11-12T10:00:00.000Z",
    anchor: "Brand",
    rel: "",
    reason: null,
    response_hash,
  });
  // Same first 12 base64url chars of the target would collide under a prefix id.
  const longA = "https://brand.example/a-very-long-shared-prefix/one";
  const longB = "https://brand.example/a-very-long-shared-prefix/two";
  const corpus = await buildCorpus(
    {
      results: [
        row(longA, hash),
        row(longB, hash),
        row(longA, edited),
        row(longA, "x"),
        row(longA, `../${hash}`),
      ],
    },
    dir,
  );
  assert.deepEqual(
    corpus.cases.map((c) => c.target_url),
    [longA, longB],
  );
  assert.notEqual(corpus.cases[0]!.id, corpus.cases[1]!.id);
});
