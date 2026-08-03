import { beforeEach, describe, expect, it } from 'vitest';
import { createCollider } from '../components/Collider';
import { createRigidBody } from '../components/RigidBody';
import { createScript } from '../components/Script';
import type { SceneSnapshot } from '../loop/Engine';
import { createPrimitiveEntity } from '../scene/primitives';
import type { Entity, Vec3 } from '../scene/types';
import type { FrameMessage } from './protocol';
import { SimulationEngine } from './SimulationEngine';

const STEP = 1 / 60;

function floor(): Entity {
  const entity = createPrimitiveEntity('Plane', { name: 'Floor' });
  entity.components.push(createCollider({ shape: 'Plane' }));
  return entity;
}

function crate(position: Vec3, source?: string): Entity {
  const entity = createPrimitiveEntity('Box', { name: 'Crate', position });
  entity.components.push(createCollider({ shape: 'Box', size: [1, 1, 1] }), createRigidBody());
  if (source) entity.components.push(createScript({ name: 'Behaviour', source }));
  return entity;
}

function snapshot(entities: Entity[]): SceneSnapshot {
  return { name: 'Test', world: { chunkSize: 256 }, entities, assets: [] };
}

describe('SimulationEngine', () => {
  let sim: SimulationEngine;
  let frames: FrameMessage[];

  beforeEach(() => {
    sim = new SimulationEngine();
    frames = [];
    sim.onFrame((message) => frames.push(message));
  });

  function run(seconds: number): void {
    for (let i = 0; i < Math.round(seconds / STEP); i += 1) sim.engine.tick(STEP);
  }

  it('actually steps physics and reports the falling body\'s new transform each tick', () => {
    sim.init(snapshot([floor(), crate([0, 3, 0])]), { actors: [], vars: [] });
    run(1);

    expect(frames.length).toBeGreaterThan(0);
    const crateId = sim.engine.scene.all().find((e) => e.name === 'Crate')!.id;
    const lastMoved = [...frames].reverse().find((f) => f.transforms.some((t) => t.id === crateId));
    expect(lastMoved).toBeDefined();
    const finalY = lastMoved!.transforms.find((t) => t.id === crateId)!.position[1];
    // It started at y=3 and a Box collider is 1m tall resting on the floor at y=0 — it must have fallen.
    expect(finalY).toBeLessThan(3);
    expect(finalY).toBeGreaterThan(0);
  });

  it('runs a script and surfaces its console output as a frame message', () => {
    sim.init(
      snapshot([crate([0, 0, 0], "function start() { console.log('hello from the worker'); }")]),
      { actors: [], vars: [] },
    );
    run(0.1);

    const logged = frames.flatMap((f) => f.console).find((m) => m.text.includes('hello from the worker'));
    expect(logged).toBeDefined();
    expect(logged!.level).toBe('log');
  });

  it('mirrors a script-spawned entity as an "add" op', () => {
    sim.init(
      snapshot([crate([0, 0, 0], "function start() { scene.spawn('Sphere', { name: 'Spawned' }); }")]),
      { actors: [], vars: [] },
    );
    run(0.1);

    const addOp = frames.flatMap((f) => f.ops).find((op) => op.op === 'add' && op.entity.name === 'Spawned');
    expect(addOp).toBeDefined();
  });

  it('mirrors entity.destroy() as a "remove" op', () => {
    const target = crate([0, 0, 0]);
    sim.init(
      snapshot([
        target,
        crate([2, 0, 0], `function start() { scene.byId('${target.id}').destroy(); }`),
      ]),
      { actors: [], vars: [] },
    );
    run(0.1);

    const removeOp = frames.flatMap((f) => f.ops).find((op) => op.op === 'remove' && op.id === target.id);
    expect(removeOp).toBeDefined();
  });

  it('relays audio.play() as a command rather than losing it', () => {
    sim.init(
      snapshot([crate([0, 0, 0], "function start() { audio.play('sfx/hit.mp3', { volume: 0.5 }); }")]),
      { actors: [], vars: [] },
    );
    run(0.1);

    const playCommand = frames.flatMap((f) => f.audio).find((c) => c.method === 'play');
    expect(playCommand).toBeDefined();
    expect(playCommand!.args[0]).toBe('sfx/hit.mp3');
  });

  it('carries game state (damage) forward in every frame', () => {
    const target = crate([0, 0, 0], 'function start() { game.damage(entity.id, 5); }');
    sim.init(snapshot([target]), {
      actors: [{ id: target.id, faction: 'none', health: 10, maxHealth: 10, alive: true }],
      vars: [],
    });
    run(0.1);

    const withDamage = frames.find((f) => f.game.actors.some((a) => a.health < a.maxHealth));
    expect(withDamage).toBeDefined();
  });
});
