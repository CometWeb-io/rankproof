import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DiskCache } from "./disk-cache.server.ts";

function cached(status: number, text: string) {
  return {
    url: "https://source.example/page",
    status,
    text,
    finalUrl: "https://source.example/page",
    etag: null,
    lastModified: null,
    storedAt: Date.now(),
  };
}

test("disk cache ignores 304/500, bounds entries and preserves unrelated files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rankproof-cache-test-"));
  const cache = new DiskCache({ dir, maxEntries: 2, maxTotalBytes: 20_000 });
  try {
    await writeFile(join(dir, "README.txt"), "This must not be deleted.");
    await cache.set("not-modified", cached(304, ""));
    await cache.set("server-error", cached(500, "oops"));
    assert.equal((await readdir(dir)).filter((name) => name.endsWith(".json")).length, 0);
    await cache.set("one", cached(200, "1"));
    await cache.set("two", cached(200, "2"));
    await cache.set("three", cached(200, "3"));
    assert.equal(await cache.prune(), 1);
    const names = await readdir(dir);
    assert.equal(names.filter((name) => name.endsWith(".json")).length, 2);
    assert.ok(names.includes("README.txt"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disk cache will not accept oversized persisted content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rankproof-cache-size-"));
  const cache = new DiskCache({ dir, maxEntries: 2 });
  try {
    await cache.set("huge", cached(200, "x".repeat(2_100_000)));
    assert.equal(await cache.get("huge"), null);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
