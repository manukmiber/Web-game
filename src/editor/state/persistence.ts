import type { Scene } from '@engine/scene/Scene';
import { sceneFromJSON, sceneToJSON } from '@engine/serialization/serialize';

/**
 * Storage backend for scenes.
 *
 * The interface exists so the Cloudflare adapter confirmed for after the MVP (Workers + R2
 * for assets, D1/KV for metadata) is a second implementation rather than a refactor of every
 * call site. Chunk-level addressing is already in the serialized format, so a remote adapter
 * can fetch per chunk without a schema change.
 */
export interface ScenePersistence {
  save(key: string, json: string): Promise<void>;
  load(key: string): Promise<string | null>;
  list(): Promise<string[]>;
  remove(key: string): Promise<void>;
}

const PREFIX = 'webgame.scene.';

export class LocalStorageAdapter implements ScenePersistence {
  async save(key: string, json: string): Promise<void> {
    try {
      localStorage.setItem(PREFIX + key, json);
    } catch (error) {
      // Quota is the realistic failure here, and it will arrive much sooner once textures are
      // inlined as data URLs in Phase 2. Surface it rather than silently losing the save.
      throw new Error(
        `Could not save scene "${key}" to local storage: ${(error as Error).message}`,
      );
    }
  }

  async load(key: string): Promise<string | null> {
    return localStorage.getItem(PREFIX + key);
  }

  async list(): Promise<string[]> {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key.slice(PREFIX.length));
    }
    return keys.sort();
  }

  async remove(key: string): Promise<void> {
    localStorage.removeItem(PREFIX + key);
  }
}

export const AUTOSAVE_KEY = '__autosave';

export async function saveScene(
  storage: ScenePersistence,
  scene: Scene,
  key = AUTOSAVE_KEY,
): Promise<void> {
  await storage.save(key, sceneToJSON(scene, false));
}

export async function loadScene(
  storage: ScenePersistence,
  scene: Scene,
  key = AUTOSAVE_KEY,
): Promise<boolean> {
  const json = await storage.load(key);
  if (!json) return false;
  sceneFromJSON(scene, json);
  return true;
}

/** Triggers a browser download of the scene as a .json file. */
export function exportSceneFile(scene: Scene): void {
  const blob = new Blob([sceneToJSON(scene, true)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${scene.name.replace(/[^\w-]+/g, '_') || 'scene'}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/** Reads a user-picked .json file into the scene. Throws if the file isn't a valid scene. */
export async function importSceneFile(scene: Scene, file: File): Promise<void> {
  sceneFromJSON(scene, await file.text());
}
