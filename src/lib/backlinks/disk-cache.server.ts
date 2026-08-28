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
  private ready: Promise<void> | null = null;

  constructor(options: DiskCacheOptions = {}) {
    const dir = options.dir ?? envDir();
    this.dir = options.enabled === false ? null : dir;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE;
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
    if (entry.status >= 400) return;
    try {
      await this.ensureDir();
      await writeFile(this.path(key), JSON.stringify(entry), "utf8");
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

  /** Deletes expired entries. Returns how many files were removed. */
  async prune(): Promise<number> {
    if (!this.dir) return 0;
    let removed = 0;
    try {
      const files = await readdir(this.dir);
      for (const file of files) {
        const full = join(this.dir, file);
        try {
          const info = await stat(full);
          if (Date.now() - info.mtimeMs > this.maxAgeMs) {
            await unlink(full);
            removed += 1;
          }
        } catch {
          // File vanished between readdir and stat — nothing to do.
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
