// ═══════════════════════════════════════════════════════════════════════════
// Simple LRU cache with TTL for server-side use.
// Reduces repeated API calls (Google Maps, geocoding) within the same
// serverless instance. Not shared across instances — that's fine for
// cost reduction (even 50% hit rate saves significant API spend).
// ═══════════════════════════════════════════════════════════════════════════

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize = 500, ttlMs = 15 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Drop one entry immediately (e.g. after an admin publish invalidates it). */
  delete(key: string): void {
    this.cache.delete(key);
  }
}
