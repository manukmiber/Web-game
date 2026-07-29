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

  /**
   * The Hierarchy's order is authored — rows are dragged into it — so it has to survive a save.
   * Chunk bucketing is what threatens it: entities are filed by position, so the document comes
   * back grouped spatially, and a scene reopened after a save used to list its objects in an
   * order nobody chose. One object sitting at a negative coordinate was enough to trigger it.
   */
  it('restores sibling order across a save, whatever chunks the entities fall in', () => {
    const scene = new Scene();
    const names = ['Sky', 'Ground', 'West Tower', 'Crate', 'East Tower'];
    // Positions chosen to scatter these across four chunks in an order unrelated to the tree.
    const positions: [number, number, number][] = [
      [0, 0, 0],
      [-400, 0, -400],
      [-400, 0, 0],
      [0, 0, -400],
      [400, 0, 400],
    ];
    names.forEach((name, index) =>
      scene.add(createPrimitiveEntity('Box', { name, position: positions[index] })),
    );

    const data = serializeScene(scene);
    expect(data.chunks.length).toBeGreaterThan(1);

    const restored = new Scene();
    sceneFromJSON(restored, JSON.stringify(data));
    expect(restored.rootIds().map((id) => restored.expect(id).name)).toEqual(names);
  });

  it('restores the order of nested children too', () => {
    const scene = new Scene();
    const parent = scene.add(createPrimitiveEntity('Empty', { name: 'Rig' }));
    const children = ['Head', 'Torso', 'Legs'].map((name, index) =>
      // Spread far enough apart that each child lands in its own chunk.
      scene.add(createPrimitiveEntity('Box', { name, position: [index * 500, 0, 0] })),
    );
    for (const child of children) scene.reparent(child.id, parent.id);

    const restored = new Scene();
    sceneFromJSON(restored, sceneToJSON(scene));
    expect(restored.childrenOf(parent.id).map((id) => restored.expect(id).name)).toEqual([
      'Head',
      'Torso',
      'Legs',
    ]);
  });

  it('serializes identically twice, so a save is stable across reopening', () => {
    const scene = new Scene();
    scene.add(createPrimitiveEntity('Box', { name: 'A', position: [-400, 0, 0] }));
    scene.add(createPrimitiveEntity('Box', { name: 'B', position: [400, 0, 0] }));

    const first = sceneToJSON(scene);
    const reloaded = new Scene();
    sceneFromJSON(reloaded, first);
    expect(sceneToJSON(reloaded)).toBe(first);
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

  /**
   * A parent chain that loops cannot be built through `reparent`, so it only ever arrives in a
   * file — and every walk up the tree (`ancestorsOf`, and the world position the serializer asks
   * for to pick a chunk) follows `parentId` until it reaches null. A cycle never does. Left
   * alone, importing such a file gave you entities that no longer appeared in the Hierarchy at
   * all, and the next Ctrl+S hung the tab for good.
   */
  it('breaks a parent cycle rather than loading an unreachable, unsaveable scene', () => {
    const scene = new Scene();
    sceneFromJSON(
      scene,
      JSON.stringify({
        version: 2,
        name: 'Looped',
        world: { chunkSize: 256 },
        assets: [],
        chunks: [
          {
            key: '0,0',
            entities: [
              { id: 'a', name: 'A', parentId: 'b', transform: {}, components: [] },
              { id: 'b', name: 'B', parentId: 'a', transform: {}, components: [] },
            ],
          },
        ],
      }),
    );

    expect(scene.size).toBe(2);
    // Both survive, and both are reachable from a root — the same "promote rather than drop"
    // policy an orphan gets.
    expect(scene.rootIds().length).toBeGreaterThan(0);
    for (const entity of scene.all()) expect(scene.ancestorsOf(entity.id)).not.toContain(entity.id);
    // The walks that used to spin now terminate, so the scene can be saved again.
    expect(() => sceneToJSON(scene)).not.toThrow();
  });

  it('breaks a longer cycle that closes further up the chain', () => {
    const scene = new Scene();
    sceneFromJSON(
      scene,
      JSON.stringify({
        version: 2,
        name: 'Ring',
        world: { chunkSize: 256 },
        assets: [],
        chunks: [
          {
            key: '0,0',
            entities: [
              { id: 'a', name: 'A', parentId: 'c', transform: {}, components: [] },
              { id: 'b', name: 'B', parentId: 'a', transform: {}, components: [] },
              { id: 'c', name: 'C', parentId: 'b', transform: {}, components: [] },
            ],
          },
        ],
      }),
    );

    expect(scene.size).toBe(3);
    expect(scene.rootIds().length).toBeGreaterThan(0);
    for (const entity of scene.all()) expect(scene.ancestorsOf(entity.id)).not.toContain(entity.id);
    expect(() => sceneToJSON(scene)).not.toThrow();
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

  it('migrates a v1 Plane from height to depth', () => {
    const data = parseScene({
      version: 1,
      entities: [
        {
          id: 'e1',
          components: [
            { type: 'MeshRenderer', primitive: 'Plane', params: { width: 10, height: 8 } },
          ],
        },
      ],
    });

    const component = data.chunks[0]!.entities[0]!.components[0]! as Record<string, unknown>;
    const params = component.params as Record<string, unknown>;
    expect(params.depth).toBe(8);
    expect(params.height).toBeUndefined();
    expect(component.modifiers).toEqual([]);
  });

  it('leaves a non-Plane primitive height alone during the migration', () => {
    const data = parseScene({
      version: 1,
      entities: [
        { id: 'e1', components: [{ type: 'MeshRenderer', primitive: 'Cylinder', params: { height: 3 } }] },
      ],
    });

    const params = (data.chunks[0]!.entities[0]!.components[0]! as Record<string, unknown>)
      .params as Record<string, unknown>;
    expect(params.height).toBe(3);
  });

  it('migrates a document that predates the version field', () => {
    const data = parseScene({
      entities: [
        { id: 'e1', components: [{ type: 'MeshRenderer', primitive: 'Plane', params: { height: 4 } }] },
      ],
    });

    const params = (data.chunks[0]!.entities[0]!.components[0]! as Record<string, unknown>)
      .params as Record<string, unknown>;
    expect(params.depth).toBe(4);
  });

  it('round-trips a modifier stack', () => {
    const scene = new Scene();
    const entity = scene.add(createPrimitiveEntity('Box'));
    scene.updateComponent(entity.id, 'MeshRenderer', {
      modifiers: [
        { type: 'Subdivide', enabled: true, levels: 2, smooth: true },
        { type: 'Twist', enabled: false, axis: 'Y', angle: 45 },
      ],
    });

    const restored = new Scene();
    sceneFromJSON(restored, sceneToJSON(scene));
    const modifiers = restored.getComponent(entity.id, 'MeshRenderer')?.modifiers as unknown[];

    expect(modifiers).toHaveLength(2);
    expect(modifiers[0]).toMatchObject({ type: 'Subdivide', levels: 2 });
    expect(modifiers[1]).toMatchObject({ type: 'Twist', enabled: false });
  });

  it('refuses a scene from a newer schema version', () => {
    expect(() => parseScene({ version: 99, entities: [] })).toThrow(SceneParseError);
  });

  it('rejects non-object input', () => {
    expect(() => parseScene('not a scene')).toThrow(SceneParseError);
  });
});
