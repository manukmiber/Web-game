import { describe, expect, it } from 'vitest';
import type { SystemStage } from '../ecs/Schedule';
import { createCollider } from '../components/Collider';
import { createPrimitiveEntity } from '../scene/primitives';
import { Engine, type EngineMode, type System } from './Engine';

class Recorder implements System {
  ticks = 0;
  resets = 0;

  constructor(
    readonly name: string,
    readonly runsIn: readonly EngineMode[],
    readonly stage?: SystemStage,
    readonly after?: readonly string[],
  ) {}

  update(): void {
    this.ticks += 1;
  }

  reset(): void {
    this.resets += 1;
  }
}

/** Records the order it ran in rather than a count. */
class Sequenced implements System {
  constructor(
    readonly name: string,
    readonly log: string[],
    readonly stage?: SystemStage,
    readonly after?: readonly string[],
  ) {}

  readonly runsIn: readonly EngineMode[] = ['edit', 'play'];

  update(): void {
    this.log.push(this.name);
  }
}

describe('Engine', () => {
  it('ticks a system only in the modes it declares', () => {
    const engine = new Engine();
    const always = new Recorder('always', ['edit', 'play']);
    const gameplay = new Recorder('gameplay', ['play']);
    engine.addSystem(always);
    engine.addSystem(gameplay);

    engine.tick(0.016);
    expect(always.ticks).toBe(1);
    expect(gameplay.ticks).toBe(0);

    engine.setMode('play');
    engine.tick(0.016);
    expect(always.ticks).toBe(2);
    expect(gameplay.ticks).toBe(1);
  });

  it('resets every system on each mode change, in both directions', () => {
    const engine = new Engine();
    const system = new Recorder('gameplay', ['play']);
    engine.addSystem(system);

    engine.setMode('play');
    expect(system.resets).toBe(1);
    engine.setMode('edit');
    expect(system.resets).toBe(2);
    // Setting the mode it is already in changes nothing.
    engine.setMode('edit');
    expect(system.resets).toBe(2);
  });

  it('drops held keys and gameplay state when the mode changes', () => {
    const engine = new Engine();
    engine.setMode('play');
    engine.input.setKey('KeyW', true);
    engine.game.register('e1', 'survivor', 10);

    engine.setMode('edit');
    expect(engine.input.isDown('w')).toBe(false);
    expect(engine.game.list()).toEqual([]);
  });

  it('clears input edges once per tick, after systems have seen them', () => {
    const engine = new Engine();
    let sawPress = false;
    engine.addSystem({
      name: 'watcher',
      runsIn: ['edit', 'play'],
      update: (_dt, e) => {
        if (e.input.wasPressed('space')) sawPress = true;
      },
    });

    engine.input.setKey('Space', true);
    engine.tick(0.016);
    expect(sawPress).toBe(true);

    sawPress = false;
    engine.tick(0.016);
    expect(sawPress).toBe(false);
  });

  it('announces in-place transform edits once per entity per frame', () => {
    const engine = new Engine();
    const entity = createPrimitiveEntity('Box');
    engine.scene.add(entity);

    let events = 0;
    engine.scene.events.on('transformChanged', () => (events += 1));
    engine.addSystem({
      name: 'mover',
      runsIn: ['edit', 'play'],
      update: (dt, e) => {
        const transform = e.scene.expect(entity.id).transform;
        transform.position[0] += dt;
        transform.position[1] += dt;
        e.scene.markTransformDirty(entity.id);
        e.scene.markTransformDirty(entity.id);
      },
    });

    engine.tick(0.016);
    engine.tick(0.016);
    expect(events).toBe(2);
  });

  it('restores a play session exactly, hierarchy order included', () => {
    const engine = new Engine();
    // Two entities in different chunks. The save format buckets by chunk and writes the
    // buckets in key order, so a JSON round trip would bring these back the other way around.
    const near = createPrimitiveEntity('Box', { name: 'Near', position: [0, 0, 0] });
    const far = createPrimitiveEntity('Box', { name: 'Far', position: [-300, 0, -300] });
    engine.scene.add(near);
    engine.scene.add(far);
    const order = engine.scene.all().map((entity) => entity.name);

    engine.setMode('play');
    engine.scene.expect(near.id).transform.position[0] = 42;
    engine.scene.add(createPrimitiveEntity('Box', { name: 'Spawned' }));
    engine.setMode('edit');

    expect(engine.scene.all().map((entity) => entity.name)).toEqual(order);
    expect(engine.scene.expect(near.id).transform.position[0]).toBe(0);
  });

  it('does not announce a transform for an entity deleted in the same frame', () => {
    const engine = new Engine();
    const entity = createPrimitiveEntity('Box');
    engine.scene.add(entity);

    let events = 0;
    engine.scene.markTransformDirty(entity.id);
    engine.scene.remove(entity.id);
    engine.scene.events.on('transformChanged', () => (events += 1));
    engine.tick(0.016);

    expect(events).toBe(0);
  });
});

describe('system scheduling', () => {
  it('ticks systems in stage order, not the order they were added', () => {
    const engine = new Engine();
    const log: string[] = [];
    engine.addSystem(new Sequenced('present', log, 'present'));
    engine.addSystem(new Sequenced('input', log, 'input'));
    engine.addSystem(new Sequenced('simulate', log, 'simulate'));

    engine.tick(0.016);

    expect(log).toEqual(['input', 'simulate', 'present']);
  });

  it('honours a declared dependency between systems in the same stage', () => {
    const engine = new Engine();
    const log: string[] = [];
    engine.addSystem(new Sequenced('npcs', log, 'resolve', ['characters']));
    engine.addSystem(new Sequenced('characters', log, 'resolve'));

    engine.tick(0.016);

    expect(log).toEqual(['characters', 'npcs']);
  });

  it('re-sorts when a system is added or removed mid-session', () => {
    const engine = new Engine();
    const log: string[] = [];
    engine.addSystem(new Sequenced('simulate', log, 'simulate'));
    engine.tick(0.016);

    engine.addSystem(new Sequenced('input', log, 'input'));
    log.length = 0;
    engine.tick(0.016);
    expect(log).toEqual(['input', 'simulate']);

    engine.removeSystem('input');
    log.length = 0;
    engine.tick(0.016);
    expect(log).toEqual(['simulate']);
  });

  it('exposes the resolved order, and reports contradictions', () => {
    const engine = new Engine();
    const conflicts: string[][] = [];
    engine.events.on('scheduleConflicts', (event) => conflicts.push(event.conflicts));
    engine.addSystem(new Recorder('a', ['edit'], 'simulate', ['b']));
    engine.addSystem(new Recorder('b', ['edit'], 'simulate', ['a']));

    // Reported rather than thrown: a mis-ordered system must not become a blank viewport.
    expect(engine.systemOrder().map((s) => s.name).sort()).toEqual(['a', 'b']);
    expect(conflicts[0]?.[0]).toContain('cycle');
  });
});

describe('the ECS view', () => {
  it('indexes the scene the engine was given', () => {
    const engine = new Engine();
    const entity = createPrimitiveEntity('Box', { name: 'Crate' });
    engine.scene.add(entity);
    expect(engine.ecs.any('Collider')).toBe(false);

    engine.scene.addComponent(entity.id, createCollider());

    expect(engine.ecs.with('Collider').map((e) => e.name)).toEqual(['Crate']);
  });
});
