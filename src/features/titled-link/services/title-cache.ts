export const DEFAULT_TITLE_CACHE_CAPACITY = 100;
export const DEFAULT_TITLE_CACHE_TTL_MS = 5 * 60 * 1000;
const EPOCH_SHIFT = 2 ** 26;

interface CacheEntry {
  readonly title: string;
  readonly expiresAt: number;
}

export interface TitleCacheOptions {
  capacity?: number;
  ttlMs?: number;
  now?: () => number;
}

/** In-memory LRU with per-URL generations and epoch invalidation on clear(). */
export class TitleCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private epoch = 0;
  private readonly generations = new Map<string, number>();

  constructor(options: TitleCacheOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_TITLE_CACHE_CAPACITY;
    this.ttlMs = options.ttlMs ?? DEFAULT_TITLE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1) {
      throw new Error("Title cache capacity must be a positive integer");
    }
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error("Title cache TTL must be positive");
    }
  }

  get size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  get(url: string): string | undefined {
    const entry = this.entries.get(url);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(url);
      return undefined;
    }
    this.entries.delete(url);
    this.entries.set(url, entry);
    return entry.title;
  }

  /** Capture before a request; pass the token to set when the response arrives. */
  captureGeneration(url: string): number {
    return this.epoch * EPOCH_SHIFT + (this.generations.get(url) ?? 0);
  }

  /** Returns false after a newer manual refresh or any clear invalidates the token. */
  set(url: string, title: string, expectedGeneration: number): boolean {
    if (expectedGeneration !== this.captureGeneration(url)) return false;
    this.store(url, title);
    return true;
  }

  /** Manual refresh advances this URL's generation so older in-flight responses cannot win. */
  refresh(url: string, title: string): number {
    const next = (this.generations.get(url) ?? 0) + 1;
    this.generations.set(url, next);
    this.store(url, title);
    return this.epoch * EPOCH_SHIFT + next;
  }

  clear(): void {
    this.epoch += 1;
    this.generations.clear();
    this.entries.clear();
  }

  private store(url: string, title: string): void {
    this.entries.delete(url);
    this.entries.set(url, { title, expiresAt: this.now() + this.ttlMs });
    this.pruneExpired();
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [url, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(url);
    }
  }
}

