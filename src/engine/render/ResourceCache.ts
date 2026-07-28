interface CacheEntry<T> {
  resource: T;
  refCount: number;
}

/**
 * Refcounted cache keyed by a parameter hash.
 *
 * Two reasons this exists rather than "just make a geometry per mesh". First, 500 default
 * cubes should allocate one BoxGeometry, not 500 — that matters at the scale in
 * ARCHITECTURE.md §9. Second, delete/undo churn in the editor would otherwise leak GPU memory
 * steadily over a session, because Three.js resources are not garbage collected: they must be
 * explicitly disposed, and only when nothing else still references them.
 */
export class ResourceCache<T extends { dispose(): void }> {
  private entries = new Map<string, CacheEntry<T>>();

  /**
   * `teardown` overrides the plain `dispose()` for resources that own more than themselves.
   *
   * A PBR material holds a texture view per map slot — its own object, with its own tiling and
   * colour space — and `material.dispose()` does not touch them. Passing the teardown in here
   * rather than making every caller remember it is what keeps the leak impossible: the cache is
   * the only thing that knows when the last reference went away.
   */
  constructor(
    private readonly factory: (key: string) => T,
    private readonly teardown: (resource: T) => void = (resource) => resource.dispose(),
  ) {}

  acquire(key: string): T {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { resource: this.factory(key), refCount: 0 };
      this.entries.set(key, entry);
    }
    entry.refCount += 1;
    return entry.resource;
  }

  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      this.teardown(entry.resource);
      this.entries.delete(key);
    }
  }

  /** Every live resource with its key. Used to refresh materials when a texture finishes decoding. */
  forEach(visit: (resource: T, key: string) => void): void {
    for (const [key, entry] of this.entries) visit(entry.resource, key);
  }

  get size(): number {
    return this.entries.size;
  }

  disposeAll(): void {
    for (const entry of this.entries.values()) this.teardown(entry.resource);
    this.entries.clear();
  }
}
