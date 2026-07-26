import * as THREE from 'three';

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

  constructor(private readonly factory: (key: string) => T) {}

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
      entry.resource.dispose();
      this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  disposeAll(): void {
    for (const entry of this.entries.values()) entry.resource.dispose();
    this.entries.clear();
  }
}

export function disposeMaterial(material: THREE.Material): void {
  const withMap = material as THREE.Material & { map?: THREE.Texture | null };
  withMap.map?.dispose();
  material.dispose();
}
