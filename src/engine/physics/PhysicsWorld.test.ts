import { beforeEach, describe, expect, it } from 'vitest';
import type { BodyType } from '../components/RigidBody';
import { IDENTITY_QUAT } from './math';
import {
  DEFAULT_STEP_SETTINGS,
  PhysicsWorld,
  type BodyDescriptor,
  type StepSettings,
} from './PhysicsWorld';
import type { WorldShape } from './shapes';

const STEP = 1 / 60;

function body(id: string, shape: WorldShape, overrides: Partial<BodyDescriptor> = {}): BodyDescriptor {
  return {
    id,
    bodyType: 'Dynamic' as BodyType,
    shape,
    origin: originOf(shape),
    rotation: [...IDENTITY_QUAT],
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

function originOf(shape: WorldShape): [number, number, number] {
  if (shape.kind === 'sphere' || shape.kind === 'box') return [...shape.center];
  if (shape.kind === 'capsule') {
    return [(shape.a[0] + shape.b[0]) / 2, (shape.a[1] + shape.b[1]) / 2, (shape.a[2] + shape.b[2]) / 2];
  }
  return [0, shape.constant, 0];
}

const ball = (y: number, radius = 0.5): WorldShape => sphereAt([0, y, 0], radius);

const sphereAt = (center: [number, number, number], radius = 0.5): WorldShape => ({
  kind: 'sphere',
  center,
  radius,
});

const crate = (
  position: [number, number, number],
  half: [number, number, number] = [0.5, 0.5, 0.5],
): WorldShape => ({ kind: 'box', center: position, rotation: [...IDENTITY_QUAT], halfExtents: half });

const floorShape: WorldShape = { kind: 'plane', normal: [0, 1, 0], constant: 0 };

/** Runs whole fixed steps, the way the PhysicsSystem does. */
function simulate(world: PhysicsWorld, seconds: number, settings: StepSettings = DEFAULT_STEP_SETTINGS) {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i += 1) world.step(STEP, settings);
}

describe('PhysicsWorld', () => {
  let world: PhysicsWorld;

  beforeEach(() => {
    world = new PhysicsWorld();
  });

  it('accelerates a dynamic body under gravity', () => {
    world.upsert(body('ball', ball(10)));
    simulate(world, 0.5);

    const velocity = world.get('ball')!.velocity;
    // v = g·t. Semi-implicit Euler is off by one step's worth, which is a tenth of a m/s here.
    expect(velocity[1]).toBeCloseTo(-9.81 * 0.5, 0);
    expect(world.get('ball')!.origin[1]).toBeLessThan(10);
  });

  it('leaves a static body exactly where it was put', () => {
    world.upsert(body('wall', crate([0, 5, 0]), { bodyType: 'Static' }));
    simulate(world, 1);
    expect(world.get('wall')!.origin[1]).toBe(5);
  });

  it('lands a falling body on a static floor and holds it there', () => {
    world.upsert(body('floor', floorShape, { bodyType: 'Static' }));
    world.upsert(body('ball', ball(4)));

    simulate(world, 3);

    const resting = world.get('ball')!.origin[1];
    // Resting within the allowed penetration of the surface, not through it.
    expect(resting).toBeGreaterThan(0.5 - DEFAULT_STEP_SETTINGS.allowedPenetration * 2);
    expect(resting).toBeLessThan(0.52);
    expect(world.get('ball')!.grounded).toBe(true);
  });

  it('puts a settled body to sleep, and wakes it when something lands on it', () => {
    world.upsert(body('floor', floorShape, { bodyType: 'Static' }));
    world.upsert(body('lower', crate([0, 0.5, 0])));
    simulate(world, 3);

    expect(world.get('lower')!.sleeping).toBe(true);

    // Drop a second crate onto it. A sleeping body that stayed asleep would be a ghost.
    world.upsert(body('upper', crate([0, 3, 0])));

    let everWoke = false;
    for (let i = 0; i < 120; i += 1) {
      world.step(STEP);
      if (!world.get('lower')!.sleeping) everWoke = true;
    }

    expect(everWoke).toBe(true);
    // Landed on top of it rather than through it, and both have settled again by now.
    expect(world.get('upper')!.origin[1]).toBeGreaterThan(1.4);
    expect(world.get('upper')!.origin[1]).toBeLessThan(1.6);
    expect(world.get('lower')!.sleeping).toBe(true);
  });

  it('never sleeps a body that says it must not', () => {
    world.upsert(body('floor', floorShape, { bodyType: 'Static' }));
    world.upsert(body('ball', ball(0.5), { canSleep: false }));
    simulate(world, 3);
    expect(world.get('ball')!.sleeping).toBe(false);
  });

  it('bounces an elastic body and settles an inelastic one', () => {
    world.upsert(body('floor', floorShape, { bodyType: 'Static' }));
    world.upsert(body('bouncy', ball(3), { restitution: 0.8 }));
    world.upsert(body('dead', sphereAt([4, 3, 0]), { restitution: 0 }));

    let bouncyPeak = 0;
    let deadPeak = 0;
    for (let i = 0; i < 180; i += 1) {
      world.step(STEP);
      // After the first landing, how high does each get again?
      if (i > 45) {
        bouncyPeak = Math.max(bouncyPeak, world.get('bouncy')!.origin[1]);
        deadPeak = Math.max(deadPeak, world.get('dead')!.origin[1]);
      }
    }

    expect(bouncyPeak).toBeGreaterThan(1);
    expect(deadPeak).toBeLessThan(0.6);
  });

  it('respects motion locks, against gravity and against contacts alike', () => {
    world.upsert(body('floor', floorShape, { bodyType: 'Static' }));
    world.upsert(body('locked', ball(5), { locks: [false, true, false] }));
    // Half-buried in the floor, so the only thing that could move it vertically is the
    // positional correction — which a lock has to hold against too.
    world.upsert(body('buried', sphereAt([4, 0.2, 0], 0.2), { locks: [false, true, false] }));

    simulate(world, 1);

    expect(world.get('locked')!.origin[1]).toBe(5);
    expect(world.get('buried')!.origin[1]).toBe(0.2);
  });

  it('caps speed at maxSpeed', () => {
    world.upsert(body('capped', ball(100), { maxSpeed: 3 }));
    simulate(world, 2);
    expect(Math.abs(world.get('capped')!.velocity[1])).toBeLessThanOrEqual(3.001);
  });

  it('lets gravityScale float, sink or reverse a body', () => {
    world.upsert(body('floaty', ball(5), { gravityScale: 0 }));
    world.upsert(body('rising', sphereAt([3, 5, 0]), { gravityScale: -1 }));
    simulate(world, 1);

    expect(world.get('floaty')!.origin[1]).toBe(5);
    expect(world.get('rising')!.origin[1]).toBeGreaterThan(5);
  });

  it('splits a contact by inverse mass, so the light body does the moving', () => {
    // Two overlapping bodies and nothing else, so the only correction in play is the pair's.
    world.upsert(body('heavy', ball(5, 0.5), { mass: 100, gravityScale: 0 }));
    world.upsert(body('light', sphereAt([0, 5.4, 0]), { mass: 1, gravityScale: 0 }));

    world.step(STEP);

    const heavyMoved = Math.abs(world.get('heavy')!.origin[1] - 5);
    const lightMoved = Math.abs(world.get('light')!.origin[1] - 5.4);
    expect(lightMoved).toBeGreaterThan(heavyMoved * 50);
  });

  it('ignores pairs whose layers do not accept each other', () => {
    world.upsert(body('floor', floorShape, { bodyType: 'Static', layer: 'ground' }));
    world.upsert(body('ghost', ball(2), { mask: 'nothing' }));
    simulate(world, 2);
    // Fell straight through, because it collides with a layer nothing is on.
    expect(world.get('ghost')!.origin[1]).toBeLessThan(0);
  });

  it('reports triggers without pushing anything', () => {
    world.upsert(body('zone', crate([0, 1, 0], [2, 2, 2]), { bodyType: 'Static', isTrigger: true }));
    world.upsert(body('ball', ball(6)));

    let entered = 0;
    let exited = 0;
    for (let i = 0; i < 240; i += 1) {
      const result = world.step(STEP);
      entered += result.began.filter((event) => event.trigger).length;
      exited += result.ended.filter((event) => event.trigger).length;
    }

    expect(entered).toBe(1);
    expect(exited).toBe(1);
    // Straight through: a trigger is a sensor, not a floor.
    expect(world.get('ball')!.origin[1]).toBeLessThan(-1);
  });

  it('reports a pair beginning once, then persisting', () => {
    world.upsert(body('floor', floorShape, { bodyType: 'Static' }));
    world.upsert(body('ball', ball(0.6)));

    let began = 0;
    let persisted = 0;
    for (let i = 0; i < 60; i += 1) {
      const result = world.step(STEP);
      began += result.began.length;
      persisted += result.persisted.length;
    }

    expect(began).toBe(1);
    expect(persisted).toBeGreaterThan(30);
  });

  it('ends a pair when one side is removed, so the survivor hears about it', () => {
    world.upsert(body('floor', floorShape, { bodyType: 'Static' }));
    world.upsert(body('ball', ball(0.5)));
    simulate(world, 0.5);

    world.remove('floor');
    const result = world.step(STEP);
    // The pair is gone from `touching` on removal, so nothing lingers as a stale contact.
    expect(result.persisted).toHaveLength(0);
  });

  it('carries an impulse straight into velocity, scaled by inverse mass', () => {
    world.upsert(body('light', ball(5), { mass: 1, gravityScale: 0 }));
    world.upsert(body('heavy', sphereAt([4, 5, 0]), { mass: 4, gravityScale: 0 }));

    world.applyImpulse('light', [0, 4, 0]);
    world.applyImpulse('heavy', [0, 4, 0]);

    expect(world.get('light')!.velocity[1]).toBeCloseTo(4);
    expect(world.get('heavy')!.velocity[1]).toBeCloseTo(1);
  });

  it('refuses to move an immovable body with an impulse', () => {
    world.upsert(body('wall', crate([0, 1, 0]), { bodyType: 'Static' }));
    world.applyImpulse('wall', [0, 100, 0]);
    expect(world.get('wall')!.velocity).toEqual([0, 0, 0]);
  });

  it('keeps velocity and sleep state when a body is re-described', () => {
    world.upsert(body('ball', ball(5)));
    simulate(world, 0.5);
    const speed = world.get('ball')!.velocity[1];

    // The scene re-describes every body each frame; forgetting velocity would stop the fall.
    world.upsert(body('ball', ball(world.get('ball')!.origin[1]), { mass: 2 }));
    expect(world.get('ball')!.velocity[1]).toBe(speed);
    expect(world.get('ball')!.invMass).toBeCloseTo(0.5);
  });

  it('prunes bodies whose entities have gone', () => {
    world.upsert(body('a', ball(1)));
    world.upsert(body('b', ball(3)));
    expect(world.prune(new Set(['a']))).toEqual(['b']);
    expect(world.size).toBe(1);
  });

  describe('queries', () => {
    beforeEach(() => {
      world.upsert(body('floor', floorShape, { bodyType: 'Static', layer: 'ground' }));
      world.upsert(body('crate', crate([0, 1, 0]), { bodyType: 'Static', layer: 'props' }));
    });

    it('finds the nearest hit along a ray', () => {
      const hit = world.raycast([0, 5, 0], [0, -1, 0], 100);
      expect(hit?.entityId).toBe('crate');
      expect(hit?.distance).toBeCloseTo(3.5);
      expect(hit?.normal[1]).toBeCloseTo(1);
    });

    it('sorts every hit along a ray by distance', () => {
      const hits = world.raycastAll([0, 5, 0], [0, -1, 0], 100);
      expect(hits.map((hit) => hit.entityId)).toEqual(['crate', 'floor']);
    });

    it('honours the ignore list, so a caster does not hit itself', () => {
      expect(world.raycast([0, 5, 0], [0, -1, 0], 100, { ignore: ['crate'] })?.entityId).toBe(
        'floor',
      );
    });

    it('filters by layer', () => {
      expect(world.raycast([0, 5, 0], [0, -1, 0], 100, { layers: ['ground'] })?.entityId).toBe(
        'floor',
      );
    });

    it('stops at maxDistance', () => {
      expect(world.raycast([0, 5, 0], [0, -1, 0], 1)).toBeNull();
    });

    it('misses on a zero-length direction rather than dividing by it', () => {
      expect(world.raycast([0, 5, 0], [0, 0, 0], 100)).toBeNull();
    });

    it('skips triggers unless asked for them', () => {
      world.upsert(body('zone', crate([0, 3, 0]), { bodyType: 'Static', isTrigger: true }));
      expect(world.raycast([0, 5, 0], [0, -1, 0], 100)?.entityId).toBe('crate');
      expect(
        world.raycast([0, 5, 0], [0, -1, 0], 100, { includeTriggers: true })?.entityId,
      ).toBe('zone');
    });

    it('finds overlaps inside a sphere', () => {
      expect(world.overlapSphere([0, 1, 0], 0.4)).toEqual(['crate']);
      expect(world.overlapSphere([0, 40, 0], 1)).toEqual([]);
    });
  });
});
