import { beforeEach, describe, expect, it } from 'vitest';
import { createCharacterController } from '../components/CharacterController';
import { createNpcAgent, type NpcAgentComponent } from '../components/NpcAgent';
import { installGameplaySystems, type GameplaySystems } from '../gameplay/systems';
import { Engine } from '../loop/Engine';
import { createTransform, type Entity, type Vec3 } from '../scene/types';
import { distanceXZ, forwardFromYaw } from './steering';

const STEP = 1 / 60;

/** Explicit ids rather than generated ones, so the per-agent RNG seed is fixed. */
function agent(id: string, position: Vec3, overrides: Partial<NpcAgentComponent> = {}): Entity {
  return {
    id,
    name: id,
    parentId: null,
    transform: createTransform(position),
    components: [createNpcAgent(overrides)],
  };
}

function survivor(id: string, position: Vec3): Entity {
  return {
    id,
    name: id,
    parentId: null,
    transform: createTransform(position),
    components: [createCharacterController()],
  };
}

function run(engine: Engine, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / STEP); i += 1) engine.tick(STEP);
}

describe('NpcSystem', () => {
  let engine: Engine;
  let systems: GameplaySystems;

  beforeEach(() => {
    engine = new Engine();
    systems = installGameplaySystems(engine);
  });

  it('ignores everything in edit mode', () => {
    const zombie = agent('z1', [10, 0, 0]);
    engine.scene.add(zombie);
    engine.scene.add(survivor('p1', [0, 0, 0]));
    run(engine, 1);
    expect(zombie.transform.position[0]).toBe(10);
  });

  it('chases a hostile faction and stops at attack range', () => {
    const zombie = agent('z1', [10, 0, 0]);
    const player = survivor('p1', [0, 0, 0]);
    engine.scene.add(zombie);
    engine.scene.add(player);
    engine.setMode('play');

    run(engine, 0.5);
    expect(systems.npcs.stateOf('z1')).toBe('chase');
    expect(systems.npcs.targetOf('z1')).toBe('p1');

    run(engine, 6);
    const distance = distanceXZ(zombie.transform.position, player.transform.position);
    const attackRange = createNpcAgent({ archetype: 'Zombie' }).attackRange;
    expect(distance).toBeLessThanOrEqual(attackRange + 0.05);
    // It closes in rather than walking through: standing on the player would look absurd.
    expect(distance).toBeGreaterThan(attackRange * 0.5);
    expect(systems.npcs.stateOf('z1')).toBe('attack');
  });

  it('turns to face where it is going', () => {
    const zombie = agent('z1', [0, 0, 10]);
    engine.scene.add(zombie);
    engine.scene.add(survivor('p1', [0, 0, 0]));
    engine.setMode('play');
    run(engine, 1);

    // Forward should point back down -Z, toward the player.
    const [fx, fz] = forwardFromYaw(zombie.transform.rotation[1]);
    expect(fz).toBeLessThan(-0.95);
    expect(Math.abs(fx)).toBeLessThan(0.2);
  });

  it('attacks on its cooldown and kills what it is attacking', () => {
    const zombie = agent('z1', [1, 0, 0], { attackDamage: 25, attackInterval: 0.5 });
    engine.scene.add(zombie);
    engine.scene.add(survivor('p1', [0, 0, 0]));
    engine.setMode('play');

    const deaths: string[] = [];
    engine.game.events.on('died', ({ id }) => deaths.push(id));

    run(engine, 0.2);
    // The first swing lands immediately; the cooldown starts after it.
    expect(engine.game.get('p1')?.health).toBe(75);

    run(engine, 2.2);
    expect(engine.game.get('p1')?.health).toBe(0);
    expect(deaths).toEqual(['p1']);
    // Nothing keeps hitting a corpse.
    expect(systems.npcs.stateOf('z1')).not.toBe('attack');
  });

  it('flees from what it is afraid of', () => {
    const deer = agent('a1', [2, 0, 0], { archetype: 'Animal' });
    const zombie = agent('z1', [0, 0, 0]);
    engine.scene.add(deer);
    engine.scene.add(zombie);
    engine.setMode('play');

    run(engine, 1);
    expect(systems.npcs.stateOf('a1')).toBe('flee');
    expect(distanceXZ(deer.transform.position, zombie.transform.position)).toBeGreaterThan(2);
  });

  it('stops when killed', () => {
    const zombie = agent('z1', [8, 0, 0]);
    engine.scene.add(zombie);
    engine.scene.add(survivor('p1', [0, 0, 0]));
    engine.setMode('play');
    run(engine, 0.5);

    engine.game.damage('z1', 999);
    const restingPlace: Vec3 = [...zombie.transform.position];
    run(engine, 2);

    expect(systems.npcs.stateOf('z1')).toBe('dead');
    expect(zombie.transform.position).toEqual(restingPlace);
  });

  it('wanders, but stays within its radius of where it started', () => {
    const home: Vec3 = [4, 0, -6];
    const wanderer = agent('w1', home, { behaviour: 'Passive', wanderRadius: 5, moveSpeed: 2 });
    engine.scene.add(wanderer);
    engine.setMode('play');

    let moved = false;
    for (let i = 0; i < 60 * 60; i += 1) {
      engine.tick(STEP);
      if (distanceXZ(wanderer.transform.position, home) > 0.5) moved = true;
      expect(distanceXZ(wanderer.transform.position, home)).toBeLessThanOrEqual(5.01);
    }
    expect(moved).toBe(true);
  });

  it('stands still when its wander radius is zero', () => {
    const guard = agent('g1', [0, 0, 0], { behaviour: 'Passive', wanderRadius: 0 });
    engine.scene.add(guard);
    engine.setMode('play');
    run(engine, 3);

    expect(systems.npcs.stateOf('g1')).toBe('idle');
    expect(guard.transform.position).toEqual([0, 0, 0]);
  });

  it('ignores factions it is not hostile to', () => {
    const zombie = agent('z1', [3, 0, 0]);
    const otherZombie = agent('z2', [0, 0, 0], { wanderRadius: 0 });
    engine.scene.add(zombie);
    engine.scene.add(otherZombie);
    engine.setMode('play');
    run(engine, 1);

    expect(systems.npcs.targetOf('z1')).toBeNull();
  });

  it('is deterministic — same ids, same wander', () => {
    const positions: Vec3[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const local = new Engine();
      installGameplaySystems(local);
      const wanderer = agent('w1', [0, 0, 0], { behaviour: 'Passive', wanderRadius: 6 });
      local.scene.add(wanderer);
      local.setMode('play');
      run(local, 10);
      positions.push([...wanderer.transform.position]);
    }
    expect(positions[0]).toEqual(positions[1]);
  });

  it('forgets its state machine between play sessions', () => {
    engine.scene.add(agent('z1', [10, 0, 0]));
    engine.scene.add(survivor('p1', [0, 0, 0]));
    engine.setMode('play');
    run(engine, 0.5);
    expect(systems.npcs.stateOf('z1')).toBe('chase');

    engine.setMode('edit');
    expect(systems.npcs.stateOf('z1')).toBeNull();
  });
});
