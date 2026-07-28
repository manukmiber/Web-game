import { beforeEach, describe, expect, it } from 'vitest';
import { createCharacterController } from '../components/CharacterController';
import { Engine } from '../loop/Engine';
import { createTransform, type Entity, type Vec3 } from '../scene/types';
import { CharacterSystem } from './CharacterSystem';

const STEP = 1 / 60;

function player(position: Vec3 = [0, 0, 0], yaw = 0): Entity {
  const entity: Entity = {
    id: 'player',
    name: 'Player',
    parentId: null,
    transform: createTransform(position),
    components: [createCharacterController()],
  };
  entity.transform.rotation[1] = yaw;
  return entity;
}

function run(engine: Engine, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / STEP); i += 1) engine.tick(STEP);
}

/** Runs for `seconds` and reports the highest the entity got — the apex of a jump arc. */
function highestOver(engine: Engine, entity: Entity, seconds: number): number {
  let peak = entity.transform.position[1];
  for (let i = 0; i < Math.round(seconds / STEP); i += 1) {
    engine.tick(STEP);
    peak = Math.max(peak, entity.transform.position[1]);
  }
  return peak;
}

describe('CharacterSystem', () => {
  let engine: Engine;

  beforeEach(() => {
    engine = new Engine();
    engine.addSystem(new CharacterSystem());
  });

  it('walks forward along -Z, the engine\'s forward', () => {
    const entity = player();
    engine.scene.add(entity);
    engine.setMode('play');
    engine.input.setKey('KeyW', true);

    run(engine, 1);
    expect(entity.transform.position[2]).toBeCloseTo(-4, 1);
    expect(entity.transform.position[0]).toBeCloseTo(0, 5);
  });

  it('walks forward relative to where it is facing', () => {
    const entity = player([0, 0, 0], 90);
    engine.scene.add(entity);
    engine.setMode('play');
    engine.input.setKey('KeyW', true);

    run(engine, 1);
    // Yaw 90° points along -X.
    expect(entity.transform.position[0]).toBeCloseTo(-4, 1);
    expect(entity.transform.position[2]).toBeCloseTo(0, 5);
  });

  it('turns with the arrow keys', () => {
    const entity = player();
    engine.scene.add(entity);
    engine.setMode('play');
    engine.input.setKey('ArrowLeft', true);

    run(engine, 1);
    expect(entity.transform.rotation[1]).toBeCloseTo(140, 0);
  });

  it('does not let diagonal movement outrun straight movement', () => {
    const straight = new Engine();
    straight.addSystem(new CharacterSystem());
    const a = player();
    straight.scene.add(a);
    straight.setMode('play');
    straight.input.setKey('KeyW', true);
    run(straight, 1);

    const entity = player();
    engine.scene.add(entity);
    engine.setMode('play');
    engine.input.setKey('KeyW', true);
    engine.input.setKey('KeyD', true);
    run(engine, 1);

    const diagonal = Math.hypot(entity.transform.position[0], entity.transform.position[2]);
    const forward = Math.hypot(a.transform.position[0], a.transform.position[2]);
    expect(diagonal).toBeCloseTo(forward, 5);
  });

  it('sprints while shift is held', () => {
    const entity = player();
    engine.scene.add(entity);
    engine.setMode('play');
    engine.input.setKey('KeyW', true);
    engine.input.setKey('ShiftLeft', true);

    run(engine, 1);
    const controller = createCharacterController();
    expect(Math.abs(entity.transform.position[2])).toBeCloseTo(
      controller.moveSpeed * controller.sprintMultiplier,
      1,
    );
  });

  it('falls under gravity and settles on its ground height', () => {
    const entity = player([0, 12, 0]);
    engine.scene.add(entity);
    engine.setMode('play');

    // One frame is a fall, not a teleport: before v0.7.5 this snapped straight to the ground.
    engine.tick(STEP);
    expect(entity.transform.position[1]).toBeLessThan(12);
    expect(entity.transform.position[1]).toBeGreaterThan(11);

    // A scene with no colliders still has the ground-height floor to land on.
    run(engine, 3);
    expect(entity.transform.position[1]).toBe(0);
  });

  it('pins straight to its ground height when gravity is off', () => {
    const entity = player([0, 12, 0]);
    entity.components = [createCharacterController({ useGravity: false })];
    engine.scene.add(entity);
    engine.setMode('play');

    engine.tick(STEP);
    expect(entity.transform.position[1]).toBe(0);
  });

  it('jumps on Space and comes back down', () => {
    const entity = player();
    engine.scene.add(entity);
    engine.setMode('play');

    engine.input.setKey('Space', true);
    engine.tick(STEP);
    expect(entity.transform.position[1]).toBeGreaterThan(0);

    engine.input.setKey('Space', false);
    const peak = highestOver(engine, entity, 2);
    // v²/2g with the defaults is about 1.1 m; the check is that it is a jump, not a hop or a
    // launch, and that it lands again rather than drifting.
    expect(peak).toBeGreaterThan(0.5);
    expect(peak).toBeLessThan(3);
    expect(entity.transform.position[1]).toBe(0);
  });

  it('registers itself so NPCs have something to react to', () => {
    engine.scene.add(player());
    engine.setMode('play');
    engine.tick(STEP);

    const actor = engine.game.get('player');
    expect(actor).toMatchObject({ faction: 'survivor', health: 100, alive: true });
  });

  it('emits nothing when standing still', () => {
    const entity = player();
    engine.scene.add(entity);
    engine.setMode('play');
    engine.tick(STEP);

    let events = 0;
    engine.scene.events.on('transformChanged', () => (events += 1));
    run(engine, 1);
    expect(events).toBe(0);
    expect(entity.transform.position).toEqual([0, 0, 0]);
  });
});
