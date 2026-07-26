import type { AssetRecord, Component, Entity, Vec3, WorldSettings } from '../scene/types';

export const SCENE_SCHEMA_VERSION = 2;

export interface SerializedChunk {
  /** "cx,cz" — derived from entity world position, never authored. */
  key: string;
  entities: Entity[];
}

export interface SerializedScene {
  version: number;
  name: string;
  world: WorldSettings;
  assets: AssetRecord[];
  chunks: SerializedChunk[];
}

/** Migrations run in order for any scene older than SCENE_SCHEMA_VERSION. */
export type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

/**
 * v1 -> v2: primitives became editable quad meshes with a modifier stack.
 *
 * Two things changed on disk. Plane is now sized by `width` x `depth` rather than
 * `width` x `height`, because it lies in the XZ plane and calling its second axis "height"
 * was always confusing. And every MeshRenderer gained a `modifiers` array.
 *
 * This is the migration table earning its keep: without it, every scene saved before this
 * change would open with a Plane of the wrong size and no obvious reason why.
 */
function migrateV1ToV2(data: Record<string, unknown>): Record<string, unknown> {
  const visitEntity = (entity: unknown) => {
    if (!isRecord(entity) || !Array.isArray(entity.components)) return;
    for (const component of entity.components) {
      if (!isRecord(component) || component.type !== 'MeshRenderer') continue;
      component.modifiers ??= [];
      const params = isRecord(component.params) ? component.params : undefined;
      if (component.primitive === 'Plane' && params && typeof params.height === 'number') {
        params.depth ??= params.height;
        delete params.height;
      }
    }
  };

  if (Array.isArray(data.entities)) for (const entity of data.entities) visitEntity(entity);
  if (Array.isArray(data.chunks)) {
    for (const chunk of data.chunks) {
      if (isRecord(chunk) && Array.isArray(chunk.entities)) {
        for (const entity of chunk.entities) visitEntity(entity);
      }
    }
  }
  return data;
}

export const migrations: Record<number, Migration> = {
  1: migrateV1ToV2,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class SceneParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SceneParseError';
  }
}

function parseVec3(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) return [...fallback];
  const out = value.map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0));
  return [out[0]!, out[1]!, out[2]!];
}

function parseComponent(value: unknown): Component | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  // Deliberately not validated against the registry: unknown component types round-trip
  // verbatim so a scene from a newer build survives this one. ARCHITECTURE.md §3.
  return value as Component;
}

function parseEntity(value: unknown): Entity | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id === '') return null;

  const transform = isRecord(value.transform) ? value.transform : {};
  const components = Array.isArray(value.components)
    ? value.components.map(parseComponent).filter((c): c is Component => c !== null)
    : [];

  return {
    id: value.id,
    name: typeof value.name === 'string' ? value.name : 'Entity',
    parentId: typeof value.parentId === 'string' ? value.parentId : null,
    transform: {
      position: parseVec3(transform.position, [0, 0, 0]),
      rotation: parseVec3(transform.rotation, [0, 0, 0]),
      scale: parseVec3(transform.scale, [1, 1, 1]),
    },
    components,
  };
}

function parseAsset(value: unknown): AssetRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || typeof value.src !== 'string') return null;
  return {
    id: value.id,
    type: 'texture',
    name: typeof value.name === 'string' ? value.name : value.id,
    src: value.src,
  };
}

/**
 * Validates and normalises untrusted JSON into a SerializedScene.
 *
 * Tolerant by design — a malformed entity is skipped rather than failing the whole load, so a
 * partially corrupt autosave still opens. Only structural nonsense throws.
 */
export function parseScene(raw: unknown): SerializedScene {
  if (!isRecord(raw)) throw new SceneParseError('Scene must be a JSON object');

  let data = raw;
  // A document with no version predates the field entirely; treat it as v1 so it still runs
  // through the v1 -> v2 migration rather than skipping it.
  const version = typeof data.version === 'number' ? data.version : 1;
  if (version > SCENE_SCHEMA_VERSION) {
    throw new SceneParseError(
      `Scene was saved with schema v${version}, but this build only understands v${SCENE_SCHEMA_VERSION}`,
    );
  }
  for (let v = version; v < SCENE_SCHEMA_VERSION; v += 1) {
    const migrate = migrations[v];
    if (migrate) data = migrate(data);
  }

  const world = isRecord(data.world) ? data.world : {};
  const chunkSize =
    typeof world.chunkSize === 'number' && world.chunkSize > 0 ? world.chunkSize : 256;

  // Accept both the chunked form and a flat `entities` array. The flat form is what the
  // original brief specified and what a hand-written scene will look like, so reading it
  // costs one branch and saves everyone a conversion step.
  const chunks: SerializedChunk[] = [];
  if (Array.isArray(data.chunks)) {
    for (const rawChunk of data.chunks) {
      if (!isRecord(rawChunk) || !Array.isArray(rawChunk.entities)) continue;
      const entities = rawChunk.entities.map(parseEntity).filter((e): e is Entity => e !== null);
      chunks.push({ key: typeof rawChunk.key === 'string' ? rawChunk.key : '0,0', entities });
    }
  } else if (Array.isArray(data.entities)) {
    const entities = data.entities.map(parseEntity).filter((e): e is Entity => e !== null);
    chunks.push({ key: '0,0', entities });
  }

  const assets = Array.isArray(data.assets)
    ? data.assets.map(parseAsset).filter((a): a is AssetRecord => a !== null)
    : [];

  return {
    version: SCENE_SCHEMA_VERSION,
    name: typeof data.name === 'string' ? data.name : 'Untitled Scene',
    world: { chunkSize },
    assets,
    chunks,
  };
}

/** Flattens chunk buckets back into a single entity list. */
export function entitiesOf(scene: SerializedScene): Entity[] {
  return scene.chunks.flatMap((chunk) => chunk.entities);
}
