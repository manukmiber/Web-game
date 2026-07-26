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

  it('stays pinned to its ground height', () => {
    const entity = player([0, 12, 0]);
    engine.scene.add(entity);
    engine.setMode('play');

    engine.tick(STEP);
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
