import { describe, expect, it } from 'vitest';
import { createCamera, findPrimaryCamera } from '../components/Camera';
import { sceneFromJSON, sceneToJSON } from '../serialization/serialize';
import type { ScatterLayerComponent } from '../components/ScatterLayer';
import { unpackInstances } from '../scatter';
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

describe('the Scatter Layer prefab', () => {
  it('arrives already drawing, with the source it scatters', () => {
    const [layerEntity, source] = createPrefab('Scatter Layer', { position: [4, 0, -2] });

    expect(source?.components.some((c) => c.type === 'MeshRenderer')).toBe(true);
    const layer = layerEntity?.components.find((c) => c.type === 'ScatterLayer') as
      | ScatterLayerComponent
      | undefined;
    expect(layer).toBeDefined();
    expect(layer!.prototypes.map((p) => p.sourceId)).toEqual([source!.id]);
    // Filled at creation, because an empty layer renders nothing and reads as broken.
    expect(layer!.instanceCount).toBeGreaterThan(0);
    expect(unpackInstances(layer!)).toHaveLength(layer!.instanceCount);
  });

  /**
   * Adding it must select the layer and only the layer: `AddEntitiesCommand` selects every
   * parentless entity it added, and a multi-selection hides the scatter panel.
   */
  it('has exactly one root, so adding it selects the layer alone', () => {
    const entities = createPrefab('Scatter Layer');
    const roots = entities.filter((entity) => entity.parentId === null);

    expect(roots).toHaveLength(1);
    expect(roots[0]!.components.some((c) => c.type === 'ScatterLayer')).toBe(true);
    // Parents first, as `Scene.add` requires.
    expect(entities[0]).toBe(roots[0]);
  });

  it('round-trips its packed instances through the serializer', () => {
    const scene = new Scene();
    for (const entity of createPrefab('Scatter Layer')) scene.add(entity);

    const json = sceneToJSON(scene);
    const reloaded = new Scene();
    sceneFromJSON(reloaded, json);

    // Additive component fields, so still no schema bump — the packed buffers are just strings.
    expect(sceneToJSON(reloaded)).toBe(json);
  });
});

