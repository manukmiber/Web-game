import { describe, expect, it } from 'vitest';
import '../components';
import { createCollider } from '../components/Collider';
import { createPhysics } from '../components/Physics';
import { createRigidBody } from '../components/RigidBody';
import { Engine } from '../loop/Engine';
import { Scene } from '../scene/Scene';
import { createPrimitiveEntity } from '../scene/primitives';
import { flatten, flattenNormal, onPlane, withDepthLock } from './dimension';
import { PhysicsSystem } from './PhysicsSystem';
import { DEFAULT_STEP_SETTINGS, PhysicsWorld, type BodyDescriptor } from './PhysicsWorld';
import { resolveShape } from './shapes';
import { identityTransform } from './math';

const XY = { mode: '2D' as const, plane: 'XY' as const, depth: 0 };
const XZ = { mode: '2D' as const, plane: 'XZ' as const, depth: 0 };
const THREE_D = { mode: '3D' as const, plane: 'XY' as const, depth: 0 };

/**
 * A descriptor whose shape sits at its origin, which is the invariant `PhysicsSystem` maintains
 * when it resolves a collider — `shapeOffset` is the difference, and a test that got it wrong
 * would be simulating a shape three metres from the body that owns it.
 */
function body(overrides: Partial<BodyDescriptor> = {}): BodyDescriptor {
  const origin = overrides.origin ?? [0, 0, 0];
  return {
    id: 'b',
    bodyType: 'Dynamic',
    shape: { kind: 'sphere', center: [...origin], radius: 0.5 },
    origin: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    mass: 1,
    gravityScale: 1,
    linearDamping: 0,
    maxSpeed: 0,
    locks: [false, false, false],
    restitution: 0,
    friction: 0.5,
    isTrigger: false,
    layer: 'default',
    mask: '*',
    canSleep: true,
    ...overrides,
  };
}

describe('dimension helpers', () => {
  it('zeroes the depth axis of the named plane', () => {
    expect(flatten([1, 2, 3], XY)).toEqual([1, 2, 0]);
    expect(flatten([1, 2, 3], XZ)).toEqual([1, 0, 3]);
    // In 3D every helper is the identity, which is what keeps the cost of the feature at zero
    // for scenes that do not use it.
    expect(flatten([1, 2, 3], THREE_D)).toEqual([1, 2, 3]);
  });

  it('moves a point onto the plane', () => {
    expect(onPlane([1, 2, 3], { ...XY, depth: -4 })).toEqual([1, 2, -4]);
    expect(onPlane([1, 2, 3], THREE_D)).toEqual([1, 2, 3]);
  });

  it('renormalises a projected normal', () => {
    const normal = flattenNormal([0, Math.SQRT1_2, Math.SQRT1_2], XY)!;
    // Projecting shortens the vector; leaving it short would under-resolve the contact by the
    // same factor, so a resting body would sink a little further every step.
    expect(normal[1]).toBeCloseTo(1, 6);
    expect(Math.hypot(...normal)).toBeCloseTo(1, 6);
  });

  it('rejects a normal that is entirely along the depth axis', () => {
    // Two prisms overlapping only in depth are not touching, in a world where depth is not
    // gameplay.
    expect(flattenNormal([0, 0, 1], XY)).toBeNull();
  });

  it('adds the depth lock to a body’s own locks', () => {
    expect(withDepthLock([true, false, false], XY)).toEqual([true, false, true]);
    expect(withDepthLock([true, false, false], XZ)).toEqual([true, true, false]);
    expect(withDepthLock([true, false, false], THREE_D)).toEqual([true, false, false]);
  });
});

describe('2D shapes', () => {
  it('resolves a Circle as a prism along the depth axis', () => {
    const shape = resolveShape(
      createCollider({ shape: 'Circle', radius: 0.5, depth: 4 }),
      identityTransform(),
      XY,
    );
    expect(shape.kind).toBe('capsule');
    if (shape.kind !== 'capsule') return;
    expect(shape.radius).toBeCloseTo(0.5);
    // Extruded along Z for an XY world: its cross-section in the plane is exactly a circle.
    expect(shape.a).toEqual([0, 0, -2]);
    expect(shape.b).toEqual([0, 0, 2]);
  });

  it('extrudes a Circle along Y in an XZ world', () => {
    const shape = resolveShape(
      createCollider({ shape: 'Circle', radius: 1, depth: 6 }),
      identityTransform(),
      XZ,
    );
    if (shape.kind !== 'capsule') throw new Error('expected a capsule');
    expect(shape.a).toEqual([0, -3, 0]);
    expect(shape.b).toEqual([0, 3, 0]);
  });

  it('resolves a Rect as a box whose depth extent is the extrusion', () => {
    const shape = resolveShape(
      createCollider({ shape: 'Rect', size: [4, 2, 99], depth: 8 }),
      identityTransform(),
      XY,
    );
    if (shape.kind !== 'box') throw new Error('expected a box');
    // Size X and Y become the in-plane extents; the third size component is ignored in favour
    // of `depth`, which is why the Inspector hides it.
    expect(shape.halfExtents[0]).toBeCloseTo(2);
    expect(shape.halfExtents[1]).toBeCloseTo(1);
    expect(shape.halfExtents[2]).toBeCloseTo(4);
  });

  it('keeps a Rect’s authored size when the plane changes', () => {
    const collider = createCollider({ shape: 'Rect', size: [4, 2, 1], depth: 8 });
    const xz = resolveShape(collider, identityTransform(), XZ);
    if (xz.kind !== 'box') throw new Error('expected a box');
    expect(xz.halfExtents[0]).toBeCloseTo(2);
    expect(xz.halfExtents[2]).toBeCloseTo(1);
    expect(xz.halfExtents[1]).toBeCloseTo(4);
  });
});

describe('2D world', () => {
  it('holds a body on the plane however far off it starts', () => {
    const world = new PhysicsWorld();
    world.setDimensionality({ ...XY, depth: 1.5 });
    world.upsert(body({ origin: [0, 5, 12] }));

    expect(world.get('b')!.origin[2]).toBeCloseTo(1.5);
  });

  it('projects gravity into the plane', () => {
    const world = new PhysicsWorld();
    world.setDimensionality(XY);
    world.upsert(body());
    world.step(1 / 60);

    const velocity = world.get('b')!.velocity;
    expect(velocity[1]).toBeLessThan(0);
    expect(velocity[2]).toBe(0);
  });

  it('leaves an XZ world weightless under default gravity', () => {
    // Gravity points along the axis a top-down world does not simulate, so the projection makes
    // it zero — which is what a top-down game wants and what nobody should have to configure.
    const world = new PhysicsWorld();
    world.setDimensionality(XZ);
    world.upsert(body());
    for (let i = 0; i < 30; i += 1) world.step(1 / 60);

    expect(world.get('b')!.velocity).toEqual([0, 0, 0]);
    expect(world.get('b')!.origin[1]).toBeCloseTo(0);
  });

  it('drops the depth component of an impulse', () => {
    const world = new PhysicsWorld();
    world.setDimensionality(XY);
    world.upsert(body());
    world.applyImpulse('b', [3, 4, 5]);

    expect(world.get('b')!.velocity).toEqual([3, 4, 0]);
  });

  it('lands a circle on a rect, in the plane', () => {
    const world = new PhysicsWorld();
    world.setDimensionality(XY);
    world.upsert(body({ id: 'ball', origin: [0, 3, 0] }));
    world.upsert(
      body({
        id: 'floor',
        bodyType: 'Static',
        origin: [0, 0, 0],
        shape: { kind: 'box', center: [0, 0, 0], rotation: [0, 0, 0, 1], halfExtents: [10, 0.5, 5] },
      }),
    );

    for (let i = 0; i < 240; i += 1) world.step(1 / 60);

    const ball = world.get('ball')!;
    // Resting on top of the floor: 0.5 (box half) + 0.5 (radius), give or take the slop.
    expect(ball.origin[1]).toBeGreaterThan(0.9);
    expect(ball.origin[1]).toBeLessThan(1.05);
    expect(ball.origin[2]).toBeCloseTo(0);
  });

  it('never pushes a body off the plane, even off a corner', () => {
    const world = new PhysicsWorld();
    world.setDimensionality(XY);
    // Sitting on the very corner of the box is where an unprojected normal leans out of the
    // plane, and where the body used to buzz between the contact and the snap forever.
    world.upsert(body({ id: 'ball', origin: [0.5, 0.55, 0] }));
    world.upsert(
      body({
        id: 'block',
        bodyType: 'Static',
        shape: { kind: 'box', center: [0, 0, 0], rotation: [0, 0, 0, 1], halfExtents: [0.5, 0.5, 0.5] },
      }),
    );

    for (let i = 0; i < 60; i += 1) world.step(1 / 60);
    expect(world.get('ball')!.origin[2]).toBe(0);
  });

  it('flattens a raycast into the plane', () => {
    const world = new PhysicsWorld();
    world.setDimensionality(XY);
    world.upsert(
      body({
        id: 'wall',
        bodyType: 'Static',
        origin: [5, 0, 0],
        shape: { kind: 'box', center: [5, 0, 0], rotation: [0, 0, 0, 1], halfExtents: [1, 5, 1] },
      }),
    );

    // Fired from off the plane and angled out of it. Both are projected, so it measures the 2D
    // distance to the wall rather than missing above or beside it.
    const hit = world.raycast([0, 0, 3], [1, 0, 0.5], 20);
    expect(hit?.entityId).toBe('wall');
    expect(hit!.distance).toBeCloseTo(4, 3);
  });

  it('leaves 3D behaviour untouched', () => {
    const world = new PhysicsWorld();
    world.upsert(body({ origin: [0, 0, 7] }));
    world.step(1 / 60, DEFAULT_STEP_SETTINGS);

    expect(world.get('b')!.origin[2]).toBeCloseTo(7);
    expect(world.getDimensionality().mode).toBe('3D');
  });

  it('moves already-registered bodies when the mode is switched', () => {
    const world = new PhysicsWorld();
    world.upsert(body({ origin: [1, 2, 3] }));
    world.setVelocity('b', [1, 1, 1]);

    world.setDimensionality(XY);

    // A query made in the same frame as the switch has to see them on the plane, so this cannot
    // wait for the next step.
    expect(world.get('b')!.origin).toEqual([1, 2, 0]);
    expect(world.get('b')!.velocity).toEqual([1, 1, 0]);
  });
});

describe('2D through the system', () => {
  function engineWith2D(plane: 'XY' | 'XZ' = 'XY'): { engine: Engine; physics: PhysicsSystem } {
    const engine = new Engine(new Scene());
    const settings = createPrimitiveEntity('Box', { name: 'World' });
    settings.components.push(createPhysics({ mode: '2D', plane }));
    engine.scene.add(settings);
    const physics = new PhysicsSystem();
    engine.addSystem(physics);
    engine.setMode('play');
    return { engine, physics };
  }

  it('reads the mode off the scene’s Physics component', () => {
    const { engine, physics } = engineWith2D('XZ');
    engine.tick(1 / 60);

    expect(physics.getDimensionality()).toEqual({ mode: '2D', plane: 'XZ', depth: 0 });
    expect(engine.physics.getDimensionality().mode).toBe('2D');
  });

  it('locks the depth axis of every body it describes', () => {
    const { engine } = engineWith2D();
    const crate = createPrimitiveEntity('Box', { name: 'Crate' });
    crate.transform.position = [0, 4, 2];
    crate.components.push(createCollider(), createRigidBody());
    engine.scene.add(crate);

    engine.tick(1 / 60);

    const body = engine.physics.get(crate.id)!;
    expect(body.locks).toEqual([false, false, true]);
    // Authored at z = 2 and simulated at z = 0: in a 2D scene, depth is not gameplay.
    expect(body.origin[2]).toBe(0);
  });

  it('writes the snapped position back onto the entity', () => {
    const { engine } = engineWith2D();
    const crate = createPrimitiveEntity('Box', { name: 'Crate' });
    crate.transform.position = [0, 4, 2];
    crate.components.push(createCollider(), createRigidBody());
    engine.scene.add(crate);

    for (let i = 0; i < 10; i += 1) engine.tick(1 / 60);

    expect(crate.transform.position[1]).toBeLessThan(4);
    expect(crate.transform.position[2]).toBe(0);
  });
});
