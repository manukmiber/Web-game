import { describe, expect, it } from 'vitest';
import { Scene } from './Scene';
import { createPrimitiveEntity, uniqueName } from './primitives';

function sceneWith(...kinds: Parameters<typeof createPrimitiveEntity>[0][]) {
  const scene = new Scene();
  const ids = kinds.map((kind) => scene.add(createPrimitiveEntity(kind)).id);
  return { scene, ids };
}

describe('Scene hierarchy', () => {
  it('tracks roots and children', () => {
    const { scene, ids } = sceneWith('Box', 'Sphere');
    const [box, sphere] = ids as [string, string];

    expect(scene.rootIds()).toEqual([box, sphere]);

    scene.reparent(sphere, box);
    expect(scene.rootIds()).toEqual([box]);
    expect(scene.childrenOf(box)).toEqual([sphere]);
    expect(scene.ancestorsOf(sphere)).toEqual([box]);
  });

  it('refuses to create a cycle', () => {
    const { scene, ids } = sceneWith('Empty', 'Empty');
    const [parent, child] = ids as [string, string];
    scene.reparent(child, parent);

    expect(() => scene.reparent(parent, child)).toThrow(/descendant/);
    expect(() => scene.reparent(parent, parent)).toThrow(/itself/);
  });

  it('removes the whole subtree and reports what went', () => {
    const { scene, ids } = sceneWith('Empty', 'Box', 'Sphere');
    const [root, mid, leaf] = ids as [string, string, string];
    scene.reparent(mid, root);
    scene.reparent(leaf, mid);

    const removed = scene.remove(root);

    expect(removed.map((e) => e.id)).toEqual([root, mid, leaf]);
    expect(scene.size).toBe(0);
    expect(scene.rootIds()).toEqual([]);
  });

  it('preserves sibling order when reparenting with an index', () => {
    const { scene, ids } = sceneWith('Box', 'Sphere', 'Cone');
    const [a, b, c] = ids as [string, string, string];

    scene.reparent(c, null, 0);
    expect(scene.rootIds()).toEqual([c, a, b]);
    expect(scene.indexOf(c)).toBe(0);
  });

  it('buckets entities into chunks by world position', () => {
    const scene = new Scene();
    const near = scene.add(createPrimitiveEntity('Box', { position: [10, 0, 10] }));
    const far = scene.add(createPrimitiveEntity('Box', { position: [600, 0, -300] }));

    // Default chunk size is 256 m.
    expect(scene.chunkKeyOf(near.id)).toBe('0,0');
    expect(scene.chunkKeyOf(far.id)).toBe('2,-2');
  });

  it('accumulates parent offsets when deciding a chunk', () => {
    const scene = new Scene();
    const parent = scene.add(createPrimitiveEntity('Empty', { position: [500, 0, 0] }));
    const child = scene.add(createPrimitiveEntity('Box', { position: [100, 0, 0] }));
    scene.reparent(child.id, parent.id);

    // 500 + 100 = 600 -> chunk 2 on x.
    expect(scene.chunkKeyOf(child.id)).toBe('2,0');
  });
});

describe('Scene components', () => {
  it('reads, patches and removes components by type', () => {
    const { scene, ids } = sceneWith('Box');
    const id = ids[0]!;

    expect(scene.getComponent(id, 'Material')?.color).toBe('#cccccc');

    scene.updateComponent(id, 'Material', { color: '#ff0000' });
    expect(scene.getComponent(id, 'Material')?.color).toBe('#ff0000');

    scene.removeComponent(id, 'Material');
    expect(scene.getComponent(id, 'Material')).toBeUndefined();
  });

  it('sizes a default Plane as square ground, not a strip', () => {
    // Guards the axis rename: Plane is width x depth, and setting `height` here silently left
    // the depth at its 1 m default, producing a 10x1 sliver of ground.
    const { scene, ids } = sceneWith('Plane');
    const params = scene.getComponent(ids[0]!, 'MeshRenderer')?.params as Record<string, number>;

    expect(params.width).toBe(10);
    expect(params.depth).toBe(10);
  });

  it('starts every primitive with an empty modifier stack', () => {
    const { scene, ids } = sceneWith('Box');
    expect(scene.getComponent(ids[0]!, 'MeshRenderer')?.modifiers).toEqual([]);
  });

  it('gives an Empty only a transform', () => {
    const { scene, ids } = sceneWith('Empty');
    expect(scene.expect(ids[0]!).components).toEqual([]);
  });

  /**
   * Repeatable components — `Script`, as of v0.7.5.
   *
   * Every method here exists because the by-type ones cannot express "the second one", and
   * silently operating on the first is the failure mode: removing script two deleted script one.
   */
  describe('several components of one type', () => {
    it('lists every component of a type in array order', () => {
      const { scene, ids } = sceneWith('Box');
      const id = ids[0]!;
      scene.addComponent(id, { type: 'Script', name: 'First' });
      scene.addComponent(id, { type: 'Script', name: 'Second' });

      expect(scene.getComponents(id, 'Script').map((c) => c.name)).toEqual(['First', 'Second']);
      // The by-type reader still answers with the first, which is what single-instance callers
      // have always wanted from it.
      expect(scene.getComponent(id, 'Script')?.name).toBe('First');
    });

    it('removes the one at an index, not the first of its type', () => {
      const { scene, ids } = sceneWith('Box');
      const id = ids[0]!;
      scene.addComponent(id, { type: 'Script', name: 'First' });
      scene.addComponent(id, { type: 'Script', name: 'Second' });

      const index = scene.expect(id).components.findIndex((c) => c.name === 'First');
      const removed = scene.removeComponentAt(id, index);

      expect(removed?.name).toBe('First');
      expect(scene.getComponents(id, 'Script').map((c) => c.name)).toEqual(['Second']);
    });

    it('ignores an index that is out of range rather than splicing wildly', () => {
      const { scene, ids } = sceneWith('Box');
      const before = scene.expect(ids[0]!).components.length;
      expect(scene.removeComponentAt(ids[0]!, 99)).toBeUndefined();
      expect(scene.removeComponentAt(ids[0]!, -1)).toBeUndefined();
      expect(scene.expect(ids[0]!).components).toHaveLength(before);
    });

    it('patches the component at an index', () => {
      const { scene, ids } = sceneWith('Box');
      const id = ids[0]!;
      scene.addComponent(id, { type: 'Script', name: 'First' });
      scene.addComponent(id, { type: 'Script', name: 'Second' });

      const index = scene.expect(id).components.findIndex((c) => c.name === 'Second');
      scene.updateComponentAt(id, index, { name: 'Renamed' });

      expect(scene.getComponents(id, 'Script').map((c) => c.name)).toEqual(['First', 'Renamed']);
    });

    it('announces an in-place mutation through touchComponents', () => {
      const { scene, ids } = sceneWith('Box');
      let fired = 0;
      scene.events.on('componentsChanged', () => (fired += 1));
      scene.touchComponents(ids[0]!);
      expect(fired).toBe(1);

      // A dead entity has nothing to announce, and must not throw for asking.
      scene.touchComponents('nope');
      expect(fired).toBe(1);
    });
  });
});

describe('uniqueName', () => {
  it('leaves an unused name alone', () => {
    expect(uniqueName('Box', ['Sphere'])).toBe('Box');
  });

  it('appends the first free index', () => {
    expect(uniqueName('Box', ['Box'])).toBe('Box (1)');
    expect(uniqueName('Box', ['Box', 'Box (1)'])).toBe('Box (2)');
  });

  it('does not stack suffixes when duplicating a duplicate', () => {
    expect(uniqueName('Box (1)', ['Box', 'Box (1)'])).toBe('Box (2)');
  });
});
