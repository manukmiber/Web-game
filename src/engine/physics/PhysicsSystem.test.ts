import { beforeEach, describe, expect, it } from 'vitest';
import { createCollider } from '../components/Collider';
import { createPhysics } from '../components/Physics';
import { createRigidBody } from '../components/RigidBody';
import { Engine } from '../loop/Engine';
import { createPrimitiveEntity } from '../scene/primitives';
import { createTransform, type Entity, type Vec3 } from '../scene/types';
import { PhysicsSystem, worldTransformOf } from './PhysicsSystem';
import { quatFromEuler } from './math';

const STEP = 1 / 60;

function boxBody(name: string, position: Vec3, dynamic = true): Entity {
  const entity = createPrimitiveEntity('Box', { name, position });
  entity.components.push(createCollider({ shape: 'Box', size: [1, 1, 1] }));
  if (dynamic) entity.components.push(createRigidBody());
  return entity;
}

function floor(): Entity {
  const entity = createPrimitiveEntity('Plane', { name: 'Floor' });
  entity.components.push(createCollider({ shape: 'Plane' }));
  return entity;
}

function run(engine: Engine, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / STEP); i += 1) engine.tick(STEP);
}

describe('PhysicsSystem', () => {
  let engine: Engine;
  let physics: PhysicsSystem;

  beforeEach(() => {
    engine = new Engine();
    physics = new PhysicsSystem();
    engine.addSystem(physics);
  });

  it('does not simulate in edit mode', () => {
    const crate = boxBody('Crate', [0, 5, 0]);
    engine.scene.add(crate);
    run(engine, 1);
    expect(crate.transform.position[1]).toBe(5);
  });

  it('writes solver positions back onto the entity transform', () => {
    engine.scene.add(floor());
    const crate = boxBody('Crate', [0, 5, 0]);
    engine.scene.add(crate);
    engine.setMode('play');

    run(engine, 3);

    expect(crate.transform.position[1]).toBeGreaterThan(0.48);
    expect(crate.transform.position[1]).toBeLessThan(0.52);
  });

  /**
   * The solver owns a falling crate's position — but only until something else writes one.
   * It used to own it unconditionally, copying its own origin back over the transform every
   * frame, so a gizmo drag, an Inspector edit or `entity.position = …` on anything with a
   * RigidBody was undone before the next frame drew, with no message to say why.
   */
  it('honours a position written from outside while the body is simulating', () => {
    engine.scene.add(floor());
    const crate = boxBody('Crate', [0, 5, 0]);
    engine.scene.add(crate);
    engine.setMode('play');

    run(engine, 3);
    expect(crate.transform.position[1]).toBeLessThan(1);

    // What the Inspector and the gizmo both do: write the transform and let physics catch up.
    engine.scene.setTransform(crate.id, { position: [2, 8, -3] });
    engine.tick(STEP);

    // The body moved to where it was put, rather than being dragged back by the solver — and
    // it is a step into falling from there, not pinned at the height it was dropped at. A crate
    // that had already settled and gone to sleep is the case that catches the difference.
    expect(crate.transform.position[0]).toBeCloseTo(2, 5);
    expect(crate.transform.position[2]).toBeCloseTo(-3, 5);
    expect(crate.transform.position[1]).toBeCloseTo(8, 2);
    expect(crate.transform.position[1]).toBeLessThan(8);

    run(engine, 0.5);
    expect(crate.transform.position[1]).toBeLessThan(7);
    expect(crate.transform.position[0]).toBeCloseTo(2, 5);
    expect(crate.transform.position[2]).toBeCloseTo(-3, 5);
  });

  it('still lets the solver own the position nobody else touched', () => {
    engine.scene.add(floor());
    const crate = boxBody('Crate', [0, 5, 0]);
    engine.scene.add(crate);
    engine.setMode('play');

    // Falls the whole way and settles: the frame-by-frame write-back is not mistaken for an
    // outside edit and does not re-seed the body from a stale transform.
    run(engine, 3);
    expect(crate.transform.position[1]).toBeGreaterThan(0.48);
    expect(crate.transform.position[1]).toBeLessThan(0.52);
  });

  it('leaves a collider with no RigidBody exactly where it is', () => {
    const wall = boxBody('Wall', [0, 5, 0], false);
    engine.scene.add(wall);
    engine.setMode('play');
    run(engine, 1);
    expect(wall.transform.position[1]).toBe(5);
  });

  it('takes gravity from the scene Physics component', () => {
    const settings = {
      id: 'physics',
      name: 'Physics',
      parentId: null,
      transform: createTransform(),
      components: [createPhysics({ gravity: [0, 4, 0] })],
    };
    engine.scene.add(settings);
    const crate = boxBody('Crate', [0, 0, 0]);
    engine.scene.add(crate);
    engine.setMode('play');

    run(engine, 1);
    // Positive gravity: it goes up. The point is that the component is read, not ignored.
    expect(crate.transform.position[1]).toBeGreaterThan(1);
  });

  it('drops every body when play mode ends, so velocities do not survive a restart', () => {
    engine.scene.add(floor());
    engine.scene.add(boxBody('Crate', [0, 5, 0]));
    engine.setMode('play');
    run(engine, 0.5);
    expect(engine.physics.size).toBeGreaterThan(0);

    engine.setMode('edit');
    expect(engine.physics.size).toBe(0);
    expect(physics.getDiagnostics().bodies).toBe(0);
  });

  it('restores the scene a physics session moved', () => {
    engine.scene.add(floor());
    const crate = boxBody('Crate', [0, 5, 0]);
    engine.scene.add(crate);

    engine.setMode('play');
    run(engine, 1);
    expect(engine.scene.expect(crate.id).transform.position[1]).toBeLessThan(5);

    engine.setMode('edit');
    expect(engine.scene.expect(crate.id).transform.position[1]).toBe(5);
  });

  it('removes a body when its entity is deleted', () => {
    engine.scene.add(floor());
    const crate = boxBody('Crate', [0, 5, 0]);
    engine.scene.add(crate);
    engine.setMode('play');
    engine.tick(STEP);
    expect(engine.physics.has(crate.id)).toBe(true);

    engine.scene.remove(crate.id);
    engine.tick(STEP);
    expect(engine.physics.has(crate.id)).toBe(false);
  });

  it('picks up a collider added mid-play', () => {
    engine.scene.add(floor());
    const crate = createPrimitiveEntity('Box', { name: 'Crate', position: [0, 5, 0] });
    engine.scene.add(crate);
    engine.setMode('play');
    engine.tick(STEP);
    expect(engine.physics.has(crate.id)).toBe(false);

    engine.scene.addComponent(crate.id, createCollider({ shape: 'Box', size: [1, 1, 1] }));
    engine.scene.addComponent(crate.id, createRigidBody());
    engine.tick(STEP);
    expect(engine.physics.has(crate.id)).toBe(true);
  });

  it('follows an entity dragged in the Inspector while it is static', () => {
    engine.scene.add(floor());
    const wall = boxBody('Wall', [0, 2, 0], false);
    engine.scene.add(wall);
    engine.setMode('play');
    engine.tick(STEP);

    // The authored transform is the source of truth for anything the solver does not own.
    engine.scene.setTransform(wall.id, { position: [7, 2, 0] });
    engine.tick(STEP);
    expect(engine.physics.get(wall.id)!.origin[0]).toBe(7);
  });

  it('emits collision events for a landing, once', () => {
    engine.scene.add(floor());
    const crate = boxBody('Crate', [0, 1.2, 0]);
    engine.scene.add(crate);
    engine.setMode('play');

    let entered = 0;
    let stayed = 0;
    physics.events.on('collisionEnter', () => (entered += 1));
    physics.events.on('collisionStay', () => (stayed += 1));

    run(engine, 2);

    expect(entered).toBe(1);
    expect(stayed).toBeGreaterThan(10);
  });

  it('reports a trigger overlap and lets the body through', () => {
    const zone = createPrimitiveEntity('Box', { name: 'Zone', position: [0, 1, 0] });
    zone.components.push(createCollider({ shape: 'Box', size: [4, 2, 4], isTrigger: true }));
    engine.scene.add(zone);
    const crate = boxBody('Crate', [0, 6, 0]);
    engine.scene.add(crate);
    engine.setMode('play');

    const triggers: boolean[] = [];
    physics.events.on('collisionEnter', (event) => triggers.push(event.trigger));

    run(engine, 3);

    expect(triggers).toContain(true);
    expect(crate.transform.position[1]).toBeLessThan(-1);
  });

  it('reports how hard the frame worked', () => {
    engine.scene.add(floor());
    engine.scene.add(boxBody('Crate', [0, 2, 0]));
    engine.setMode('play');
    engine.tick(STEP);

    const diagnostics = physics.getDiagnostics();
    expect(diagnostics.bodies).toBe(2);
    expect(diagnostics.dynamicBodies).toBe(1);
    expect(diagnostics.steps).toBe(1);
    expect(diagnostics.throttled).toBe(false);
  });

  it('runs whole steps out of an accumulator rather than the frame delta', () => {
    engine.scene.add(boxBody('Crate', [0, 20, 0]));
    engine.setMode('play');

    // Half a step: not enough to simulate anything yet.
    engine.tick(STEP / 2);
    expect(physics.getDiagnostics().steps).toBe(0);

    // The other half completes one step, so the leftover is carried rather than lost.
    engine.tick(STEP / 2);
    expect(physics.getDiagnostics().steps).toBe(1);
  });

  it('caps substeps rather than spiralling on a slow frame', () => {
    engine.scene.add(boxBody('Crate', [0, 20, 0]));
    engine.setMode('play');

    // A 200 ms frame is twelve steps' worth; the default cap is four.
    engine.tick(0.2);
    const diagnostics = physics.getDiagnostics();
    expect(diagnostics.steps).toBe(4);
    expect(diagnostics.throttled).toBe(true);
  });
});

describe('worldTransformOf', () => {
  it('accumulates position, rotation and scale through parents', () => {
    const engine = new Engine();
    const parent = createPrimitiveEntity('Box', { name: 'Parent', position: [10, 0, 0] });
    parent.transform.rotation = [0, 90, 0];
    parent.transform.scale = [2, 2, 2];
    engine.scene.add(parent);

    const child = createPrimitiveEntity('Box', { name: 'Child', position: [1, 0, 0] });
    child.parentId = parent.id;
    engine.scene.add(child);

    const world = worldTransformOf(engine.scene, child);
    // Parent turned 90° about Y sends the child's local +X to world -Z, doubled by the scale.
    expect(world.position[0]).toBeCloseTo(10);
    expect(world.position[2]).toBeCloseTo(-2);
    expect(world.scale).toEqual([2, 2, 2]);
  });

  it('ignores parent rotation for a root entity, which has none', () => {
    const engine = new Engine();
    const entity = createPrimitiveEntity('Box', { name: 'Solo', position: [1, 2, 3] });
    entity.transform.rotation = [0, 45, 0];
    engine.scene.add(entity);

    const world = worldTransformOf(engine.scene, entity);
    expect(world.position).toEqual([1, 2, 3]);
    expect(world.rotation[1]).toBeCloseTo(quatFromEuler([0, 45, 0])[1]);
  });

  it('substitutes a solver-owned origin for the authored one', () => {
    const engine = new Engine();
    const entity = createPrimitiveEntity('Box', { name: 'Falling', position: [0, 10, 0] });
    engine.scene.add(entity);

    expect(worldTransformOf(engine.scene, entity, [0, 4, 0]).position).toEqual([0, 4, 0]);
  });
});
