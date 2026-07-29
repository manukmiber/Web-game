import type { Scene } from '../scene/Scene';
import {
  SCENE_SCHEMA_VERSION,
  type SerializedChunk,
  type SerializedEntity,
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
 *
 * Which is also why each entity carries its sibling index: bucketing by position reorders the
 * document relative to the Hierarchy, and without `order` written down the tree came back
 * rearranged every time a scene was saved and reopened.
 */
export function serializeScene(scene: Scene): SerializedScene {
  const buckets = new Map<string, SerializedEntity[]>();
  for (const entity of scene.all()) {
    const key = scene.chunkKeyOf(entity.id);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    // A copy rather than the live entity: `order` is a fact about the document, not about the
    // entity, and the scene should not start carrying a field only the serializer means.
    bucket.push({ ...entity, order: scene.indexOf(entity.id) });
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
