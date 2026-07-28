import * as THREE from 'three';
import { Emitter } from '../core/Emitter';
import type { AssetRecord } from '../scene/types';

interface AssetEvents {
  textureLoaded: { id: string };
}

/**
 * Owns GPU-side texture objects keyed by asset id.
 *
 * Decoding goes through `fetch` + `createImageBitmap` rather than THREE.TextureLoader
 * specifically because both are available in a Web Worker while `Image`/`document` are not —
 * ARCHITECTURE.md §9.5 requires the engine stay movable off the main thread.
 */
export class AssetStore {
  readonly events = new Emitter<AssetEvents>();

  private textures = new Map<string, THREE.Texture>();
  private pending = new Map<string, Promise<THREE.Texture | null>>();
  /** Applied to every texture, existing and future. See `setAnisotropy`. */
  private anisotropy = 1;

  /**
   * Anisotropic filtering level for colour textures.
   *
   * Stored as well as applied, because textures arrive asynchronously: a setting changed while
   * a texture is still decoding has to be waiting for it when it lands, or the scene ends up
   * with a mix of levels that depends on network timing.
   *
   * The caller is responsible for clamping to `renderer.capabilities.getMaxAnisotropy()` —
   * this class has no renderer, deliberately, so it can be driven from a worker.
   */
  setAnisotropy(value: number): void {
    const next = Math.max(1, Math.floor(value));
    if (next === this.anisotropy) return;
    this.anisotropy = next;
    for (const texture of this.textures.values()) {
      texture.anisotropy = next;
      // Filtering is part of the sampler state, so the texture has to be re-uploaded.
      texture.needsUpdate = true;
    }
  }

  getAnisotropy(): number {
    return this.anisotropy;
  }

  /** Synchronous lookup — returns null while a texture is still decoding. */
  getTexture(id: string | null): THREE.Texture | null {
    if (!id) return null;
    return this.textures.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.textures.has(id);
  }

  async load(record: AssetRecord): Promise<THREE.Texture | null> {
    const existing = this.textures.get(record.id);
    if (existing) return existing;
    const inFlight = this.pending.get(record.id);
    if (inFlight) return inFlight;

    const task = this.decode(record)
      .then((texture) => {
        if (texture) {
          this.textures.set(record.id, texture);
          this.events.emit('textureLoaded', { id: record.id });
        }
        return texture;
      })
      .finally(() => this.pending.delete(record.id));

    this.pending.set(record.id, task);
    return task;
  }

  private async decode(record: AssetRecord): Promise<THREE.Texture | null> {
    try {
      const response = await fetch(record.src);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY' });
      const texture = new THREE.Texture(bitmap);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = this.anisotropy;
      texture.needsUpdate = true;
      return texture;
    } catch {
      // A texture that fails to decode should leave the scene renderable, not blank it.
      return null;
    }
  }

  /** Registers an already-built texture (procedural defaults take this path). */
  put(id: string, texture: THREE.Texture): void {
    this.textures.get(id)?.dispose();
    texture.anisotropy = this.anisotropy;
    this.textures.set(id, texture);
    this.events.emit('textureLoaded', { id });
  }

  remove(id: string): void {
    this.textures.get(id)?.dispose();
    this.textures.delete(id);
  }

  disposeAll(): void {
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
    this.pending.clear();
  }
}
