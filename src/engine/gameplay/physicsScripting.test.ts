import { beforeEach, describe, expect, it } from 'vitest';
import { createCharacterController } from '../components/CharacterController';
import { createCollider } from '../components/Collider';
import { createRigidBody } from '../components/RigidBody';
import { createScript, type ScriptComponent } from '../components/Script';
import { Engine } from '../loop/Engine';
import { createPrimitiveEntity } from '../scene/primitives';
import type { Entity, Vec3 } from '../scene/types';
import type { ScriptMessage } from '../scripting/ScriptSystem';
import { installGameplaySystems, type GameplaySystems } from './systems';

const STEP = 1 / 60;

function scriptOf(entity: Entity): ScriptComponent {
  return entity.components.find((c): c is ScriptComponent => c.type === 'Script')!;
}

function floor(): Entity {
  const entity = createPrimitiveEntity('Plane', { name: 'Floor' });
  entity.components.push(createCollider({ shape: 'Plane' }));
  return entity;
}

/**
 * The whole play-mode stack, wired the way the editor wires it.
 *
 * These tests are deliberately integration-level. Every one of them is about two systems
 * agreeing with each other — the solver reporting a contact and the script hearing about it in
 * the same frame, `fixedUpdate` firing exactly as often as the solver stepped — and a unit test
 * of either half cannot see whether they do.
 */
describe('physics and scripting together', () => {
  let engine: Engine;
  let systems: GameplaySystems;
  let messages: ScriptMessage[];

  beforeEach(() => {
    engine = new Engine();
    systems = installGameplaySystems(engine);
    messages = [];
    systems.scripts.events.on('message', (message) => messages.push(message));
  });

  function run(seconds: number): void {
    for (let i = 0; i < Math.round(seconds / STEP); i += 1) engine.tick(STEP);
  }

  function crate(position: Vec3, script?: Partial<ScriptComponent>): Entity {
    const entity = createPrimitiveEntity('Box', { name: 'Crate', position });
    entity.components.push(
      createCollider({ shape: 'Box', size: [1, 1, 1] }),
      createRigidBody(),
    );
    if (script) entity.components.push(createScript(script));
    return entity;
  }

  it('delivers onCollisionEnter to the script on the landing body', () => {
    engine.scene.add(floor());
    const box = crate([0, 3, 0], {
      name: 'Impact',
      source: `
        function onCollisionEnter(hit) {
          props.hits += 1;
          props.speed = hit.impactSpeed;
          props.up = hit.normal[1];
        }
      `,
      props: { hits: 0, speed: 0, up: 0 },
    });
    engine.scene.add(box);
    engine.setMode('play');

    run(2);

    const props = scriptOf(box).props;
    expect(props.hits).toBe(1);
    // Falling from 2.5 m reaches about 7 m/s.
    expect(props.speed as number).toBeGreaterThan(5);
    // The normal points from this entity towards what it hit, so landing on a floor points down.
    expect(props.up as number).toBeLessThan(-0.9);
  });

  it('delivers onCollisionExit when the pair separates', () => {
    engine.scene.add(floor());
    const box = crate([0, 0.6, 0], {
      name: 'Bouncer',
      source: `
        function onCollisionEnter() { props.entered += 1; entity.body.impulse(0, 8, 0); }
        function onCollisionExit() { props.exited += 1; }
      `,
      props: { entered: 0, exited: 0 },
    });
    engine.scene.add(box);
    engine.setMode('play');

    run(1.5);

    expect(scriptOf(box).props.entered as number).toBeGreaterThanOrEqual(1);
    expect(scriptOf(box).props.exited as number).toBeGreaterThanOrEqual(1);
  });

  it('fires onTriggerEnter for a sensor volume and lets the body through', () => {
    const zone = createPrimitiveEntity('Box', { name: 'Zone', position: [0, 1, 0] });
    zone.components.push(
      createCollider({ shape: 'Box', size: [4, 2, 4], isTrigger: true }),
      createScript({
        name: 'Trigger',
        source: 'function onTriggerEnter(hit) { props.entered += 1; props.other = hit.otherId; }',
        props: { entered: 0, other: '' },
      }),
    );
    engine.scene.add(zone);
    const box = crate([0, 6, 0]);
    engine.scene.add(box);
    engine.setMode('play');

    run(3);

    expect(scriptOf(zone).props.entered).toBe(1);
    expect(scriptOf(zone).props.other).toBe(box.id);
    expect(box.transform.position[1]).toBeLessThan(-1);
  });

  it('fires fixedUpdate exactly as often as the solver stepped', () => {
    const box = crate([0, 20, 0], {
      name: 'Counter',
      source: `
        function fixedUpdate(dt) { props.steps += 1; props.dt = dt; }
        function update() { props.frames += 1; }
      `,
      props: { steps: 0, frames: 0, dt: 0 },
    });
    engine.scene.add(box);
    engine.setMode('play');

    // Thirty frames at exactly one step each.
    for (let i = 0; i < 30; i += 1) engine.tick(STEP);
    expect(scriptOf(box).props.steps).toBe(30);
    expect(scriptOf(box).props.frames).toBe(30);
    expect(scriptOf(box).props.dt).toBeCloseTo(STEP, 5);

    // One long frame runs several steps but only one update — which is the entire reason the
    // two hooks exist separately.
    engine.tick(STEP * 3);
    expect(scriptOf(box).props.steps).toBe(33);
    expect(scriptOf(box).props.frames).toBe(31);
  });

  it('lets a script shove a body about through entity.body', () => {
    engine.scene.add(floor());
    const box = crate([0, 0.5, 0], {
      name: 'Jumper',
      source: `
        function start() { entity.body.impulse(0, 6, 0); }
        function update() { props.speed = entity.body.speed; props.grounded = entity.grounded; }
      `,
      props: { speed: 0, grounded: false },
    });
    engine.scene.add(box);
    engine.setMode('play');

    engine.tick(STEP);
    expect(scriptOf(box).props.speed as number).toBeGreaterThan(4);

    run(0.4);
    expect(box.transform.position[1]).toBeGreaterThan(1);
  });

  it('gives a script the physics queries', () => {
    engine.scene.add(floor());
    const probe = createPrimitiveEntity('Box', { name: 'Probe', position: [0, 5, 0] });
    probe.components.push(
      createScript({
        name: 'Probe',
        source: `
          function start() {
            const hit = physics.groundBelow([0, 5, 0], 100);
            props.found = hit !== null;
            props.distance = hit ? hit.distance : -1;
            props.gravity = physics.gravity[1];
            props.nearby = physics.overlapSphere([0, 0, 0], 2).length;
          }
        `,
        props: { found: false, distance: 0, gravity: 0, nearby: 0 },
      }),
    );
    engine.scene.add(probe);
    engine.setMode('play');
    engine.tick(STEP);

    const props = scriptOf(probe).props;
    expect(props.found).toBe(true);
    expect(props.distance).toBeCloseTo(5);
    expect(props.gravity).toBeCloseTo(-9.81);
    expect(props.nearby).toBe(1);
  });

  it('pushes bodies away from an explosion, falling off with distance', () => {
    engine.scene.add(floor());
    const near = crate([1, 0.5, 0]);
    // Well outside the blast radius, and far enough that the crate thrown by it cannot reach
    // and shove it — which is what a 6 m gap turned out to allow.
    const far = crate([14, 0.5, 0]);
    near.name = 'Near';
    far.name = 'Far';
    engine.scene.add(near);
    engine.scene.add(far);

    const charge = createPrimitiveEntity('Box', { name: 'Charge', position: [0, 0.5, 0] });
    charge.components.push(
      createScript({
        name: 'Bomb',
        source: 'function start() { props.moved = physics.explode([0, 0.5, 0], 5, 20); }',
        props: { moved: 0 },
      }),
    );
    engine.scene.add(charge);
    engine.setMode('play');

    engine.tick(STEP);
    expect(scriptOf(charge).props.moved).toBe(1);

    run(0.5);
    // The near crate was thrown; the one outside the radius stayed put.
    expect(near.transform.position[0]).toBeGreaterThan(1.5);
    expect(far.transform.position[0]).toBeCloseTo(14, 1);
  });

  it('tells a character script whether it is standing on anything, and jumps it', () => {
    engine.scene.add(floor());
    const player = createPrimitiveEntity('Capsule', { name: 'Player', position: [0, 0.9, 0] });
    player.components.push(
      createCharacterController({ groundHeight: 0.9 }),
      createScript({
        name: 'Jumper',
        source: `
          function update() {
            props.grounded = entity.grounded;
            if (entity.grounded && !props.jumped) { entity.jump(8); props.jumped = true; }
          }
        `,
        props: { grounded: false, jumped: false },
      }),
    );
    engine.scene.add(player);
    engine.setMode('play');

    // Two ticks, not one: scripts run before the character controller (see
    // `installGameplaySystems`), so `grounded` is what the last completed character step found —
    // and on the very first frame there has not been one.
    engine.tick(STEP);
    engine.tick(STEP);
    expect(scriptOf(player).props.grounded).toBe(true);

    run(0.3);
    expect(player.transform.position[1]).toBeGreaterThan(1.5);
  });

  it('reports no error from any of it', () => {
    expect(messages.filter((m) => m.level === 'error')).toEqual([]);
  });

  it('drops physics contacts on leaving play, so a restart is clean', () => {
    engine.scene.add(floor());
    engine.scene.add(crate([0, 2, 0]));
    engine.setMode('play');
    run(1);
    expect(engine.physics.size).toBe(2);

    engine.setMode('edit');
    expect(engine.physics.size).toBe(0);
    expect(systems.scripts.instanceCount).toBe(0);
  });
});
