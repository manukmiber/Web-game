import { describe, expect, it } from 'vitest';
import '../components';
import { createCollider } from '../components/Collider';
import type { createMaterial } from '../components/Material';
import { createPhysics } from '../components/Physics';
import { createRigidBody } from '../components/RigidBody';
import { createScript } from '../components/Script';
import { Scene } from '../scene/Scene';
import { createPrimitiveEntity } from '../scene/primitives';
import type { PhysicsComponent } from '../components/Physics';
import { EcsWorld } from './EcsWorld';

function sceneWith(...names: string[]): { scene: Scene; world: EcsWorld; ids: string[] } {
  const scene = new Scene();
  const ids = names.map((name) => scene.add(createPrimitiveEntity('Box', { name })).id);
  return { scene, world: new EcsWorld(scene), ids };
}

describe('component index', () => {
  it('finds entities by component type without walking the scene', () => {
    const { scene, world, ids } = sceneWith('a', 'b', 'c');
    scene.addComponent(ids[1]!, createCollider());

    expect(world.count('Collider')).toBe(1);
    expect(world.with('Collider').map((e) => e.name)).toEqual(['b']);
    // Every Box primitive carries a MeshRenderer, so this is the "all of them" case.
    expect(world.count('MeshRenderer')).toBe(3);
  });

  it('follows components being added and removed', () => {
    const { scene, world, ids } = sceneWith('a');
    expect(world.any('RigidBody')).toBe(false);

    scene.addComponent(ids[0]!, createRigidBody());
    expect(world.any('RigidBody')).toBe(true);

    scene.removeComponent(ids[0]!, 'RigidBody');
    expect(world.any('RigidBody')).toBe(false);
  });

  it('drops a whole removed subtree, not just its root', () => {
    const scene = new Scene();
    const parent = scene.add(createPrimitiveEntity('Box', { name: 'parent' }));
    const child = createPrimitiveEntity('Box', { name: 'child' });
    child.parentId = parent.id;
    scene.add(child);
    scene.addComponent(child.id, createCollider());
    const world = new EcsWorld(scene);
    expect(world.count('Collider')).toBe(1);

    scene.remove(parent.id);

    // The child was removed with its parent and was never named in the event's `id`. An index
    // that only un-indexed the root would keep reporting a collider on a deleted entity, and the
    // physics system would go on describing a body for it every frame.
    expect(world.count('Collider')).toBe(0);
    expect(world.count('MeshRenderer')).toBe(0);
  });

  it('rebuilds wholesale when the scene is replaced', () => {
    const { scene, world, ids } = sceneWith('a');
    scene.addComponent(ids[0]!, createCollider());
    expect(world.count('Collider')).toBe(1);

    scene.load({ name: 'other', world: scene.world, entities: [], assets: [] });

    expect(world.count('Collider')).toBe(0);
  });

  it('counts an entity once for a type it carries several of', () => {
    const { scene, world, ids } = sceneWith('a');
    scene.addComponent(ids[0]!, createScript({ name: 'one' }));
    scene.addComponent(ids[0]!, createScript({ name: 'two' }));

    // The index answers "which entities", not "how many components" — a multi-script entity is
    // one entity for the ScriptSystem to visit, which then reads all of its scripts.
    expect(world.count('Script')).toBe(1);
    expect(world.with('Script')).toHaveLength(1);
  });
});

describe('queries', () => {
  it('intersects with `all`', () => {
    const { scene, world, ids } = sceneWith('body', 'collider-only', 'plain');
    scene.addComponent(ids[0]!, createCollider());
    scene.addComponent(ids[0]!, createRigidBody());
    scene.addComponent(ids[1]!, createCollider());

    const dynamic = world.entities({ all: ['Collider', 'RigidBody'] });
    expect(dynamic.map((e) => e.name)).toEqual(['body']);
  });

  it('excludes with `none`', () => {
    const { scene, world, ids } = sceneWith('body', 'static');
    scene.addComponent(ids[0]!, createCollider());
    scene.addComponent(ids[0]!, createRigidBody());
    scene.addComponent(ids[1]!, createCollider());

    const statics = world.entities({ all: ['Collider'], none: ['RigidBody'] });
    expect(statics.map((e) => e.name)).toEqual(['static']);
  });

  it('unions with `any`', () => {
    const { scene, world, ids } = sceneWith('a', 'b', 'c');
    scene.addComponent(ids[0]!, createCollider());
    scene.addComponent(ids[1]!, createRigidBody());

    const either = world.entities({ any: ['Collider', 'RigidBody'] });
    expect(either.map((e) => e.name).sort()).toEqual(['a', 'b']);
  });

  it('returns matches in scene order', () => {
    // Not the index's order, which follows insertion into a hash set. A system that writes
    // transforms has to be deterministic across a save and reload.
    const { scene, world, ids } = sceneWith('first', 'second', 'third');
    for (const id of [ids[2]!, ids[0]!, ids[1]!]) scene.addComponent(id, createCollider());

    expect(world.entities({ all: ['Collider'] }).map((e) => e.name)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('caches results and reuses them until the shape changes', () => {
    const { scene, world, ids } = sceneWith('a');
    scene.addComponent(ids[0]!, createCollider());
    const query = { all: ['Collider'] };

    const first = world.ids(query);
    expect(world.ids(query)).toBe(first);

    // A field edit cannot change which entities have a collider, so the cache must survive it —
    // dragging a radius slider emits this event sixty times a second.
    scene.updateComponent(ids[0]!, 'Collider', { radius: 2 });
    expect(world.ids(query)).toBe(first);

    scene.addComponent(ids[0]!, createRigidBody());
    expect(world.ids(query)).not.toBe(first);
  });

  it('answers nothing for a query with no positive term', () => {
    const { world } = sceneWith('a');
    // "Every entity" is the Scene's question, not the index's — it only knows entities that
    // carry at least one component, so answering it here would be quietly wrong.
    expect(world.ids({ none: ['Collider'] })).toEqual([]);
  });

  it('reports whether one entity matches, without resolving the set', () => {
    const { scene, world, ids } = sceneWith('a', 'b');
    scene.addComponent(ids[0]!, createCollider());

    expect(world.matches(ids[0]!, { all: ['Collider'] })).toBe(true);
    expect(world.matches(ids[1]!, { all: ['Collider'] })).toBe(false);
  });
});

describe('scene-wide singletons', () => {
  it('resolves the first component of a type in scene order', () => {
    const { scene, world, ids } = sceneWith('a', 'b');
    scene.addComponent(ids[1]!, createPhysics({ gravity: [0, -1, 0] }));
    scene.addComponent(ids[0]!, createPhysics({ gravity: [0, -20, 0] }));

    // "First in scene order wins" is the documented rule for Physics and Environment. The entity
    // that was created first holds the -20, even though the component was added second.
    expect(world.firstComponent<PhysicsComponent>('Physics')?.gravity).toEqual([0, -20, 0]);
  });

  it('returns null when the scene has none', () => {
    const { world } = sceneWith('a');
    expect(world.firstComponent('Physics')).toBeNull();
  });
});

describe('each', () => {
  it('hands over the component named by the query', () => {
    const { scene, world, ids } = sceneWith('a');
    // A Box primitive already carries a Material, so this edits it rather than adding a second.
    scene.updateComponent(ids[0]!, 'Material', { roughness: 0.25 });

    const seen: number[] = [];
    world.each<ReturnType<typeof createMaterial>>({ all: ['Material'] }, (_entity, material) => {
      seen.push(material.roughness);
    });
    expect(seen).toEqual([0.25]);
  });
});

describe('census', () => {
  it('reports every type present with an entity count', () => {
    const { scene, world, ids } = sceneWith('a', 'b');
    scene.addComponent(ids[0]!, createCollider());

    const census = world.census();
    expect(census.get('MeshRenderer')).toBe(2);
    expect(census.get('Collider')).toBe(1);
    expect(census.has('RigidBody')).toBe(false);
  });
});
