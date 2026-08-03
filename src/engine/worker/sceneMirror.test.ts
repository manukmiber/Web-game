import { describe, expect, it } from 'vitest';
import { Scene } from '../scene/Scene';
import { createTransform } from '../scene/types';
import { applySceneOps, SceneOpCollector } from './sceneMirror';

function makeEntity(id: string, name = id, parentId: string | null = null) {
  return { id, name, parentId, transform: createTransform(), components: [] };
}

describe('SceneOpCollector', () => {
  it('records an add and lets it round-trip onto another scene', () => {
    const source = new Scene();
    const collector = new SceneOpCollector(source);
    source.add(makeEntity('e1', 'Zombie'));

    const target = new Scene();
    applySceneOps(target, collector.drain());

    expect(target.get('e1')?.name).toBe('Zombie');
  });

  it('dedupes several component edits on the same entity into one op that reflects the last edit', () => {
    const source = new Scene();
    source.add(makeEntity('e1'));
    source.addComponent('e1', { type: 'Health', hp: 10 });

    const collector = new SceneOpCollector(source);
    source.updateComponent('e1', 'Health', { hp: 8 });
    source.updateComponent('e1', 'Health', { hp: 5 });
    source.updateComponent('e1', 'Health', { hp: 1 });

    const ops = collector.drain();
    expect(ops.filter((op) => op.op === 'components')).toHaveLength(1);

    const target = new Scene();
    target.add(makeEntity('e1'));
    applySceneOps(target, ops);
    expect(target.getComponent('e1', 'Health')).toEqual({ type: 'Health', hp: 1 });
  });

  it('replays rename, reparent and remove in order', () => {
    const source = new Scene();
    const collector = new SceneOpCollector(source);
    source.add(makeEntity('parent'));
    source.add(makeEntity('e1'));
    source.rename('e1', 'Renamed');
    source.reparent('e1', 'parent');
    source.remove('parent');

    const target = new Scene();
    applySceneOps(target, collector.drain());

    // The parent's removal took its subtree (e1) with it.
    expect(target.has('parent')).toBe(false);
    expect(target.has('e1')).toBe(false);
  });

  it('stops collecting once disposed', () => {
    const source = new Scene();
    const collector = new SceneOpCollector(source);
    collector.dispose();
    source.add(makeEntity('e1'));
    expect(collector.drain()).toEqual([]);
  });
});

describe('applySceneOps', () => {
  it('promotes an entity to root rather than dropping it when its parent is missing on this scene', () => {
    const target = new Scene();
    applySceneOps(target, [{ op: 'add', entity: makeEntity('e1', 'Orphan', 'ghost-parent') }]);
    expect(target.get('e1')?.parentId).toBeNull();
  });

  it('does not throw when an op references an entity this scene never had', () => {
    const target = new Scene();
    expect(() =>
      applySceneOps(target, [
        { op: 'rename', id: 'missing', name: 'x' },
        { op: 'remove', id: 'missing', removedIds: ['missing'] },
        { op: 'reparent', id: 'missing', parentId: null },
        { op: 'components', id: 'missing', components: [] },
      ]),
    ).not.toThrow();
  });

  it('keeps applying later ops after one throws', () => {
    const target = new Scene();
    // A 'reparent' naming itself as its own parent throws inside Scene.reparent.
    target.add(makeEntity('e1'));
    applySceneOps(target, [
      { op: 'reparent', id: 'e1', parentId: 'e1' },
      { op: 'rename', id: 'e1', name: 'still works' },
    ]);
    expect(target.get('e1')?.name).toBe('still works');
  });
});
