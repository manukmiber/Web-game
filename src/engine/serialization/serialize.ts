import type { Scene } from '../scene/Scene';
import type { Entity } from '../scene/types';
import {
  SCENE_SCHEMA_VERSION,
  type SerializedChunk,
  type SerializedScene,
  entitiesOf,
  parseScene,
} from './schema';

/**
 * Buckets entities by chunk and writes the versioned document.
 *
 * An entity is filed under its own chunk regardless of where its parent sits — chunk
 * membership is a spatial fact, not a hierarchy fact, and the loader rebuilds parenting from
 * `parentId` after flattening. That is what lets a chunk be loaded independently later (§9.2).
 */
export function serializeScene(scene: Scene): SerializedScene {
  const buckets = new Map<string, Entity[]>();
  for (const entity of scene.all()) {
    const key = scene.chunkKeyOf(entity.id);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(entity);
  }

  const chunks: SerializedChunk[] = [...buckets.entries()]
    // Stable ordering keeps saved files diff-friendly.
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entities]) => ({ key, entities }));

  return {
    version: SCENE_SCHEMA_VERSION,
    name: scene.name,
    world: { ...scene.world },
    assets: scene.listAssets(),
    chunks,
  };
}

export function deserializeScene(scene: Scene, raw: unknown): void {
  const data = parseScene(raw);
  scene.load({
    name: data.name,
    world: data.world,
    entities: entitiesOf(data),
    assets: data.assets,
  });
}

export function sceneToJSON(scene: Scene, pretty = true): string {
  return JSON.stringify(serializeScene(scene), null, pretty ? 2 : 0);
}

export function sceneFromJSON(scene: Scene, json: string): void {
  deserializeScene(scene, JSON.parse(json));
}
