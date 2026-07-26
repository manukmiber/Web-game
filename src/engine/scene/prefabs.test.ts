import { describe, expect, it } from 'vitest';
import { createCamera, findPrimaryCamera } from '../components/Camera';
import { sceneFromJSON, sceneToJSON } from '../serialization/serialize';
import { Scene } from './Scene';
import { PREFAB_MENU, createPrefab, createStarterScene } from './prefabs';
import { createTransform, type Entity } from './types';

function componentTypes(entity: Entity): string[] {
  return entity.components.map((component) => component.type);
}

describe('prefabs', () => {
  it('builds every menu entry with a unique id', () => {
    const ids = new Set<string>();
    for (const kind of PREFAB_MENU) {
      const entities = createPrefab(kind);
      expect(entities.length).toBeGreaterThan(0);
      for (const entity of entities) {
        expect(ids.has(entity.id)).toBe(false);
        ids.add(entity.id);
      }
    }
  });

  it('gives the player a camera as a child, which is the whole third-person rig', () => {
    const [body, camera] = createPrefab('Player');
    expect(componentTypes(body!)).toContain('CharacterController');
    expect(componentTypes(body!)).toContain('MeshRenderer');
    expect(camera?.parentId).toBe(body!.id);
    expect(componentTypes(camera!)).toContain('Camera');
    // Behind the character and level with it: -Z is forward for both, so no rotation needed
    // beyond a slight downward tilt.
    expect(camera!.transform.position[2]).toBeGreaterThan(0);
  });

  it('parents prefab children only to entities in the same batch', () => {
    for (const kind of PREFAB_MENU) {
      const entities = createPrefab(kind);
      const ids = new Set(entities.map((entity) => entity.id));
      for (const entity of entities) {
        if (entity.parentId !== null) expect(ids.has(entity.parentId)).toBe(true);
      }
    }
  });

  it('spawns characters on the ground at the requested spot', () => {
    const [zombie] = createPrefab('Zombie', { position: [7, 3, -2] });
    expect(zombie!.transform.position[0]).toBe(7);
    expect(zombie!.transform.position[2]).toBe(-2);
    // Y comes from the prefab, not from wherever the editor camera was looking.
    expect(zombie!.transform.position[1]).toBeCloseTo(0.9);
  });
});

describe('findPrimaryCamera', () => {
  const withCamera = (id: string, primary: boolean): Entity => ({
    id,
    name: id,
    parentId: null,
    transform: createTransform(),
    components: [createCamera({ primary })],
  });

  it('prefers the primary camera', () => {
    const entities = [withCamera('a', false), withCamera('b', true), withCamera('c', true)];
    expect(findPrimaryCamera(entities)?.id).toBe('b');
  });

  it('falls back to any camera rather than to a black screen', () => {
    expect(findPrimaryCamera([withCamera('a', false)])?.id).toBe('a');
  });

  it('returns null when the scene has no camera at all', () => {
    expect(findPrimaryCamera([])).toBeNull();
  });
});

describe('starter scene', () => {
  const entities = createStarterScene();

  it('is playable out of the box', () => {
    const types = new Set(entities.flatMap(componentTypes));
    expect(types).toContain('Environment');
    expect(types).toContain('Light');
    expect(types).toContain('Camera');
    expect(types).toContain('CharacterController');
    expect(types).toContain('NpcAgent');
  });

  it('is internally consistent', () => {
    const ids = new Set<string>();
    for (const entity of entities) {
      expect(ids.has(entity.id)).toBe(false);
      ids.add(entity.id);
    }
    for (const entity of entities) {
      if (entity.parentId !== null) expect(ids.has(entity.parentId)).toBe(true);
    }
  });

  it('loads into a Scene and survives a save/load round trip unchanged', () => {
    const scene = new Scene();
    for (const entity of entities) scene.add(entity);
    const before = sceneToJSON(scene);

    const reloaded = new Scene();
    sceneFromJSON(reloaded, before);

    // No schema bump was needed for this version: the new components are additive, so they
    // round-trip through the existing serializer untouched.
    expect(sceneToJSON(reloaded)).toBe(before);
    expect(reloaded.size).toBe(entities.length);
  });
});
