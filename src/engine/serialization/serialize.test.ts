import { describe, expect, it } from 'vitest';
import { Scene } from '../scene/Scene';
import { createPrimitiveEntity } from '../scene/primitives';
import { SceneParseError, parseScene } from './schema';
import { sceneFromJSON, sceneToJSON, serializeScene } from './serialize';

describe('serializeScene', () => {
  it('round-trips entities, hierarchy and component values', () => {
    const scene = new Scene();
    scene.name = 'Test Scene';
    const parent = scene.add(createPrimitiveEntity('Empty', { name: 'Group' }));
    const child = scene.add(createPrimitiveEntity('Box', { position: [1, 2, 3] }));
    scene.reparent(child.id, parent.id);
    scene.updateComponent(child.id, 'Material', { color: '#ff8800', alpha: 0.5 });
    scene.setTransform(child.id, { rotation: [0, 45, 0], scale: [2, 2, 2] });

    const json = sceneToJSON(scene);
    const restored = new Scene();
    sceneFromJSON(restored, json);

    expect(restored.name).toBe('Test Scene');
    expect(restored.size).toBe(2);
    expect(restored.childrenOf(parent.id)).toEqual([child.id]);

    const restoredChild = restored.expect(child.id);
    expect(restoredChild.transform.position).toEqual([1, 2, 3]);
    expect(restoredChild.transform.rotation).toEqual([0, 45, 0]);
    expect(restoredChild.transform.scale).toEqual([2, 2, 2]);
    expect(restored.getComponent(child.id, 'Material')?.color).toBe('#ff8800');
    expect(restored.getComponent(child.id, 'Material')?.alpha).toBe(0.5);
  });

  it('buckets entities into chunks by position', () => {
    const scene = new Scene();
    scene.add(createPrimitiveEntity('Box', { position: [0, 0, 0] }));
    scene.add(createPrimitiveEntity('Box', { position: [1000, 0, 0] }));

    const data = serializeScene(scene);

    expect(data.chunks.map((c) => c.key)).toEqual(['0,0', '3,0']);
    expect(data.chunks.every((c) => c.entities.length === 1)).toBe(true);
  });

  it('restores hierarchy even when a child is serialized into a different chunk', () => {
    const scene = new Scene();
    const parent = scene.add(createPrimitiveEntity('Empty', { position: [0, 0, 0] }));
    const child = scene.add(createPrimitiveEntity('Box', { position: [1000, 0, 0] }));
    scene.reparent(child.id, parent.id);

    const data = serializeScene(scene);
    expect(data.chunks).toHaveLength(2);

    const restored = new Scene();
    sceneFromJSON(restored, JSON.stringify(data));
    expect(restored.childrenOf(parent.id)).toEqual([child.id]);
  });
});

describe('parseScene', () => {
  it('accepts the flat entity array from the original spec', () => {
    const data = parseScene({
      entities: [
        {
          id: 'e1',
          name: 'Box 1',
          parentId: null,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          components: [
            { type: 'MeshRenderer', primitive: 'Box' },
            { type: 'Material', color: '#ffffff', alpha: 1, texture: null },
          ],
        },
      ],
    });

    expect(data.chunks).toHaveLength(1);
    expect(data.chunks[0]!.entities[0]!.name).toBe('Box 1');
  });

  it('preserves unknown component types verbatim', () => {
    const scene = new Scene();
    sceneFromJSON(
      scene,
      JSON.stringify({
        version: 1,
        entities: [
          {
            id: 'e1',
            name: 'Zombie',
            parentId: null,
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            components: [{ type: 'Behaviour', script: 'chase.ts', speed: 3 }],
          },
        ],
      }),
    );

    const restored = JSON.parse(sceneToJSON(scene));
    const component = restored.chunks[0].entities[0].components[0];
    expect(component).toEqual({ type: 'Behaviour', script: 'chase.ts', speed: 3 });
  });

  it('skips malformed entities instead of failing the whole load', () => {
    const data = parseScene({
      entities: [{ id: 'good', name: 'Keep' }, { name: 'no id' }, 'garbage', null],
    });

    expect(data.chunks[0]!.entities.map((e) => e.id)).toEqual(['good']);
  });

  it('fills in missing transform fields with defaults', () => {
    const data = parseScene({ entities: [{ id: 'e1' }] });
    const entity = data.chunks[0]!.entities[0]!;

    expect(entity.transform).toEqual({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
  });

  it('promotes an orphaned child to root rather than dropping it', () => {
    const scene = new Scene();
    sceneFromJSON(
      scene,
      JSON.stringify({ entities: [{ id: 'child', parentId: 'missing-parent' }] }),
    );

    expect(scene.size).toBe(1);
    expect(scene.rootIds()).toEqual(['child']);
  });

  it('refuses a scene from a newer schema version', () => {
    expect(() => parseScene({ version: 99, entities: [] })).toThrow(SceneParseError);
  });

  it('rejects non-object input', () => {
    expect(() => parseScene('not a scene')).toThrow(SceneParseError);
  });
});
