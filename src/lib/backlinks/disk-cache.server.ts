import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Disk cache with conditional revalidation.
 *
 * Repeat scans of the same domain re-fetch the same pages. Keeping bodies on
 * disk together with their `ETag` / `Last-Modified` lets us send
 * `If-None-Match` and take a 304 instead of a full body — faster for us and
 * measurably less load on servers that never asked to be crawled in the
 * first place.
 *
 * The cache is opt-in (`RANKPROOF_CACHE_DIR`) because a long-running web
 * instance is usually better served by the in-memory cache alone.
 */

export type CachedResponse = {
  url: string;
  status: number;
  text: string;
  finalUrl: string;
  etag: string | null;
  lastModified: string | null;
  storedAt: number;
};

export type DiskCacheOptions = {
  dir?: string;
  /** Entries older than this are ignored and eventually pruned. */
  maxAgeMs?: number;
  enabled?: boolean;
  /** Bound unique cached responses to avoid unbounded disk usage. */
  maxEntries?: number;
  maxTotalBytes?: number;
};

const DEFAULT_MAX_AGE = 7 * 24 * 3600 * 1000;

function envDir(): string | null {
  const raw = typeof process !== "undefined" ? process.env?.RANKPROOF_CACHE_DIR : undefined;
  if (!raw || !raw.trim()) return null;
  return raw.trim() === "1" ? join(tmpdir(), "rankproof-cache") : raw.trim();
}

export class DiskCache {
  private readonly dir: string | null;
  private readonly maxAgeMs: number;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private writes = 0;
  private ready: Promise<void> | null = null;

  constructor(options: DiskCacheOptions = {}) {
    const dir = options.dir ?? envDir();
    this.dir = options.enabled === false ? null : dir;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE;
    this.maxEntries = options.maxEntries ?? 1_000;
    this.maxTotalBytes = options.maxTotalBytes ?? 128 * 1024 * 1024;
  }

  get enabled(): boolean {
    return this.dir !== null;
  }

  private path(key: string): string {
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 40);
    return join(this.dir!, `${hash}.json`);
  }

  private async ensureDir(): Promise<void> {
    if (!this.dir) return;
    this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
    await this.ready;
  }

  async get(key: string): Promise<CachedResponse | null> {
    if (!this.dir) return null;
    try {
      const info = await stat(this.path(key));
      if (info.size > 2_000_000) return null;
      const raw = await readFile(this.path(key), "utf8");
      const entry = JSON.parse(raw) as CachedResponse;
      if (Date.now() - entry.storedAt > this.maxAgeMs) return null;
      return entry;
    } catch {
      return null;
    }
  }

  async set(key: string, entry: CachedResponse): Promise<void> {
    if (!this.dir) return;
    // Never persist error bodies — they poison the next run.
    if (entry.status < 200 || entry.status >= 300) return;
    const content = JSON.stringify(entry);
    if (Buffer.byteLength(content, "utf8") > 2_000_000) return;
    try {
      await this.ensureDir();
      await writeFile(this.path(key), content, "utf8");
      this.writes += 1;
      if (this.writes % 128 === 0) await this.prune();
    } catch {
      // A cache that cannot be written must never break a scan.
    }
  }

  /** Headers that turn the next request into a conditional one. */
  conditionalHeaders(entry: CachedResponse | null): Record<string, string> {
    if (!entry) return {};
    const headers: Record<string, string> = {};
    if (entry.etag) headers["If-None-Match"] = entry.etag;
    if (entry.lastModified) headers["If-Modified-Since"] = entry.lastModified;
    return headers;
  }

  /** Prunes only our cache files, never arbitrary user files in the folder. */
  async prune(): Promise<number> {
    if (!this.dir) return 0;
    let removed = 0;
    const live: { path: string; size: number; modified: number }[] = [];
    let totalBytes = 0;
    try {
      const files = await readdir(this.dir);
      for (const file of files) {
        if (!/^[a-f0-9]{40}\.json$/.test(file)) continue;
        const path = join(this.dir, file);
        try {
          const info = await stat(path);
          if (!info.isFile()) continue;
          if (Date.now() - info.mtimeMs > this.maxAgeMs) {
            await unlink(path);
            removed += 1;
          } else {
            live.push({ path, size: info.size, modified: info.mtimeMs });
            totalBytes += info.size;
          }
        } catch {
          // Another process may have replaced or pruned an entry.
        }
      }
      live.sort((a, b) => a.modified - b.modified);
      while (live.length > this.maxEntries || totalBytes > this.maxTotalBytes) {
        const oldest = live.shift();
        if (!oldest) break;
        try {
          await unlink(oldest.path);
          removed += 1;
          totalBytes -= oldest.size;
        } catch {
          // A concurrent cleanup already removed this entry.
        }
      }
    } catch {
      return removed;
    }
    return removed;
  }
}

let shared: DiskCache | null = null;

export function diskCache(): DiskCache {
  shared ??= new DiskCache();
  return shared;
}

export function resetDiskCache(): void {
  shared = null;
}
