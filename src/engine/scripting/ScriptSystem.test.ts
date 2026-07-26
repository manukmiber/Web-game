import { beforeEach, describe, expect, it } from 'vitest';
import { createScript, type ScriptComponent } from '../components/Script';
import { Engine } from '../loop/Engine';
import { createPrimitiveEntity } from '../scene/primitives';
import type { Entity } from '../scene/types';
import { ScriptSystem, type ScriptMessage } from './ScriptSystem';

const STEP = 1 / 60;

function scripted(source: string, props: Record<string, number | string | boolean> = {}): Entity {
  const entity = createPrimitiveEntity('Box', { name: 'Scripted' });
  entity.components.push(createScript({ name: 'Test', source, props }));
  return entity;
}

function scriptOf(entity: Entity): ScriptComponent {
  return entity.components.find((c): c is ScriptComponent => c.type === 'Script')!;
}

describe('ScriptSystem', () => {
  let engine: Engine;
  let system: ScriptSystem;
  let messages: ScriptMessage[];

  beforeEach(() => {
    engine = new Engine();
    system = new ScriptSystem();
    engine.addSystem(system);
    messages = [];
    system.events.on('message', (message) => messages.push(message));
  });

  it('does not run in edit mode', () => {
    const entity = scripted('function update() { props.ticks += 1; }', { ticks: 0 });
    engine.scene.add(entity);
    engine.tick(STEP);
    expect(scriptOf(entity).props.ticks).toBe(0);
  });

  it('calls start once and update every frame', () => {
    const entity = scripted(
      `function start() { props.starts += 1; }
       function update(dt) { props.ticks += 1; props.elapsed += dt; }`,
      { starts: 0, ticks: 0, elapsed: 0 },
    );
    engine.scene.add(entity);
    engine.setMode('play');

    engine.tick(STEP);
    engine.tick(STEP);
    engine.tick(STEP);

    const props = scriptOf(entity).props;
    expect(props.starts).toBe(1);
    expect(props.ticks).toBe(3);
    expect(props.elapsed).toBeCloseTo(STEP * 3);
  });

  it('gives a script control of its own entity', () => {
    const entity = scripted('function update(dt) { entity.position.y += 2 * dt; }');
    engine.scene.add(entity);
    engine.setMode('play');

    for (let i = 0; i < 30; i += 1) engine.tick(STEP);
    expect(entity.transform.position[1]).toBeCloseTo(1, 5);
  });

  it('batches a script\'s transform writes into one event per frame', () => {
    const entity = scripted(
      'function update(dt) { entity.position.x += dt; entity.position.y += dt; entity.position.z += dt; }',
    );
    engine.scene.add(entity);
    engine.setMode('play');

    let events = 0;
    engine.scene.events.on('transformChanged', () => (events += 1));
    engine.tick(STEP);
    engine.tick(STEP);

    // Three writes a frame, two frames — but the renderer only needs to hear twice.
    expect(events).toBe(2);
  });

  it('parks a script that throws and keeps the others running', () => {
    const broken = scripted('function update() { throw new Error("boom"); }');
    const healthy = scripted('function update() { props.ticks += 1; }', { ticks: 0 });
    engine.scene.add(broken);
    engine.scene.add(healthy);
    engine.setMode('play');

    engine.tick(STEP);
    engine.tick(STEP);

    expect(messages.filter((m) => m.level === 'error')).toHaveLength(1);
    expect(messages[0]!.text).toMatch(/boom/);
    expect(messages[0]!.entityId).toBe(broken.id);
    // The healthy script ran on both frames, including the one where its neighbour threw.
    expect(scriptOf(healthy).props.ticks).toBe(2);
  });

  it('reports a script that will not compile, once', () => {
    engine.scene.add(scripted('function update( {'));
    engine.setMode('play');
    engine.tick(STEP);
    engine.tick(STEP);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.level).toBe('error');
    expect(messages[0]!.text).toMatch(/SyntaxError/);
  });

  it('reloads a script when its source changes, so editing mid-play works', () => {
    const entity = scripted('function update() { props.a += 1; }', { a: 0, b: 0 });
    engine.scene.add(entity);
    engine.setMode('play');
    engine.tick(STEP);

    scriptOf(entity).source = 'function update() { props.b += 1; }';
    engine.tick(STEP);
    engine.tick(STEP);

    expect(scriptOf(entity).props.a).toBe(1);
    expect(scriptOf(entity).props.b).toBe(2);
  });

  it('stops and destroys a script that is disabled', () => {
    const entity = scripted(
      `function update() { props.ticks += 1; }
       function destroy() { console.log('destroyed'); }`,
      { ticks: 0 },
    );
    engine.scene.add(entity);
    engine.setMode('play');
    engine.tick(STEP);

    scriptOf(entity).enabled = false;
    engine.tick(STEP);

    expect(scriptOf(entity).props.ticks).toBe(1);
    expect(messages.map((m) => m.text)).toContain('destroyed');
    expect(system.instanceCount).toBe(0);
  });

  it('destroys the instance when the entity goes away', () => {
    const entity = scripted('function destroy() { console.log("gone"); }');
    engine.scene.add(entity);
    engine.setMode('play');
    engine.tick(STEP);

    engine.scene.remove(entity.id);
    engine.tick(STEP);

    expect(messages.map((m) => m.text)).toContain('gone');
    expect(system.instanceCount).toBe(0);
  });

  it('routes console output through the message stream with its script name', () => {
    engine.scene.add(scripted('function start() { console.warn("watch out", 42); }'));
    engine.setMode('play');
    engine.tick(STEP);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ level: 'warn', source: 'Test', text: 'watch out 42' });
  });

  it('lets a script spawn and find entities', () => {
    engine.scene.add(
      scripted(`
        function start() {
          const box = scene.spawn('Box', { name: 'Spawned', position: [3, 0, 0] });
          props.found = scene.find('Spawned') !== null;
          props.distance = entity.distanceTo(box);
        }
      `),
    );
    engine.setMode('play');
    engine.tick(STEP);

    expect(engine.scene.all().some((e) => e.name === 'Spawned')).toBe(true);
    const script = engine.scene.all().find((e) => e.name === 'Scripted')!;
    expect(scriptOf(script).props.found).toBe(true);
    expect(scriptOf(script).props.distance).toBeCloseTo(3);
  });

  it('lets a script build a working NPC, not just a mesh', () => {
    engine.scene.add(
      scripted(`
        function start() {
          const zombie = scene.spawn('Capsule', { name: 'Spawned', position: [5, 0, 0] });
          zombie.addComponent('NpcAgent', { archetype: 'Zombie' });
          props.faction = zombie.component('NpcAgent').faction;
          // One per type: asking twice hands back the same component.
          props.same = zombie.addComponent('NpcAgent') === zombie.component('NpcAgent');
        }
      `),
    );
    engine.setMode('play');
    engine.tick(STEP);

    const spawned = engine.scene.all().find((e) => e.name === 'Spawned')!;
    expect(spawned.components.map((c) => c.type)).toContain('NpcAgent');
    const script = engine.scene.all().find((e) => e.name === 'Scripted')!;
    expect(scriptOf(script).props.faction).toBe('undead');
    expect(scriptOf(script).props.same).toBe(true);
  });

  it('drops every instance on leaving play mode', () => {
    engine.scene.add(scripted('function update() { props.ticks += 1; }', { ticks: 0 }));
    engine.setMode('play');
    engine.tick(STEP);
    expect(system.instanceCount).toBe(1);

    engine.setMode('edit');
    expect(system.instanceCount).toBe(0);
  });

  it('restores the scene a play session mutated', () => {
    const entity = scripted('function update(dt) { entity.position.x += 1; }');
    engine.scene.add(entity);

    engine.setMode('play');
    engine.tick(STEP);
    engine.tick(STEP);
    expect(engine.scene.expect(entity.id).transform.position[0]).toBe(2);

    engine.setMode('edit');
    expect(engine.scene.expect(entity.id).transform.position[0]).toBe(0);
  });
});
