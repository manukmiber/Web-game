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

  describe('time', () => {
    it('reads the engine clock through `time`', () => {
      const entity = scripted(
        `function update() {
           props.scale = time.scale;
           props.paused = time.paused;
           props.smooth = time.smoothDt;
         }`,
        { scale: 0, paused: false, smooth: 0 },
      );
      engine.scene.add(entity);
      engine.setMode('play');
      engine.setTimeScale(0.5);
      engine.tick(STEP);

      expect(scriptOf(entity).props.scale).toBe(0.5);
      expect(scriptOf(entity).props.paused).toBe(false);
    });

    it('lets a script drop into slow motion and come back', () => {
      const entity = scripted(
        `function update() {
           if (time.frame === 1) time.scale = 0.25;
           if (time.frame === 3) time.scale = 1;
         }`,
      );
      engine.scene.add(entity);
      engine.setMode('play');

      engine.tick(STEP);
      expect(engine.getTimeScale()).toBe(0.25);
      engine.tick(STEP);
      engine.tick(STEP);
      expect(engine.getTimeScale()).toBe(1);
    });

    it('lets a script pause the world, and still runs while it is paused', () => {
      const entity = scripted(
        `function update() {
           props.ticks += 1;
           if (props.ticks === 1) time.paused = true;
           if (props.ticks === 3) time.paused = false;
         }`,
        { ticks: 0 },
      );
      engine.scene.add(entity);
      engine.setMode('play');

      engine.tick(STEP);
      expect(engine.paused).toBe(true);
      // A paused world still ticks its scripts — that is what makes a pause menu possible.
      engine.tick(0);
      engine.tick(0);
      expect(engine.paused).toBe(false);
      expect(scriptOf(entity).props.ticks).toBe(3);
    });

    it('clamps a scale a script should not have asked for', () => {
      const entity = scripted('function update() { if (time.frame === 1) time.scale = -4; }');
      engine.scene.add(entity);
      engine.setMode('play');
      engine.tick(STEP);

      // Backwards time would run the solver through collision responses that assume otherwise.
      expect(engine.getTimeScale()).toBe(0);
    });

    it('leaves the editor at real speed when a play session ends slowed or paused', () => {
      engine.scene.add(scripted('function start() { time.scale = 0.1; time.paused = true; }'));
      engine.setMode('play');
      engine.tick(STEP);
      expect(engine.paused).toBe(true);

      engine.setMode('edit');
      expect(engine.paused).toBe(false);
      expect(engine.getTimeScale()).toBe(1);
    });
  });
});

/**
 * The v0.7.5 additions: several scripts on one entity, the new hooks, and the two things that
 * make several scripts worth having — a defined running order and a way to talk to each other.
 */
describe('ScriptSystem, several scripts per entity', () => {
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

  /** An entity carrying several Script components, in the order given. */
  function multi(...scripts: Partial<ScriptComponent>[]): Entity {
    const entity = createPrimitiveEntity('Box', { name: 'Multi' });
    for (const script of scripts) entity.components.push(createScript(script));
    return entity;
  }

  it('runs every script on the entity, each with its own state', () => {
    const entity = multi(
      { name: 'A', source: 'let n = 0; function update() { n += 1; props.a = n; }', props: { a: 0 } },
      { name: 'B', source: 'let n = 0; function update() { n += 10; props.b = n; }', props: { b: 0 } },
    );
    engine.scene.add(entity);
    engine.setMode('play');
    engine.tick(STEP);
    engine.tick(STEP);

    const scripts = entity.components.filter((c): c is ScriptComponent => c.type === 'Script');
    expect(scripts[0]!.props.a).toBe(2);
    expect(scripts[1]!.props.b).toBe(20);
    expect(system.instanceCount).toBe(2);
  });

  it('runs them in `order`, not in the order they were added', () => {
    const entity = multi(
      { name: 'Late', order: 10, source: 'function update() { game.set("log", game.get("log", "") + "L"); }' },
      { name: 'Early', order: -10, source: 'function update() { game.set("log", game.get("log", "") + "E"); }' },
    );
    engine.scene.add(entity);
    engine.setMode('play');
    engine.tick(STEP);

    expect(engine.game.getVar('log')).toBe('EL');
  });

  it('re-sorts when an order field changes mid-play', () => {
    const entity = multi(
      { name: 'A', order: 0, source: 'function update() { game.set("log", game.get("log", "") + "A"); }' },
      { name: 'B', order: 1, source: 'function update() { game.set("log", game.get("log", "") + "B"); }' },
    );
    engine.scene.add(entity);
    engine.setMode('play');
    engine.tick(STEP);
    expect(engine.game.getVar('log')).toBe('AB');

    const scripts = entity.components.filter((c): c is ScriptComponent => c.type === 'Script');
    scripts[1]!.order = -1;
    engine.game.setVar('log', '');
    engine.tick(STEP);
    expect(engine.game.getVar('log')).toBe('BA');
  });

  it('parks one broken script and keeps its neighbour on the same entity running', () => {
    const entity = multi(
      { name: 'Broken', source: 'function update() { throw new Error("boom"); }' },
      { name: 'Fine', source: 'function update() { props.ticks += 1; }', props: { ticks: 0 } },
    );
    engine.scene.add(entity);
    engine.setMode('play');
    engine.tick(STEP);
    engine.tick(STEP);

    const scripts = entity.components.filter((c): c is ScriptComponent => c.type === 'Script');
    expect(scripts[1]!.props.ticks).toBe(2);
    expect(messages.filter((m) => m.level === 'error')).toHaveLength(1);
  });

  it('keeps the surviving script running when its neighbour is removed', () => {
    const entity = multi(
      { name: 'Doomed', source: 'function destroy() { console.log("gone"); }' },
      { name: 'Survivor', source: 'function update() { props.ticks += 1; }', props: { ticks: 0 } },
    );
    engine.scene.add(entity);
    engine.setMode('play');
    engine.tick(STEP);

    // Remove the *first* Script. Keyed by entity alone, this used to hand the survivor's
    // running instance to the wrong component.
    const index = entity.components.findIndex((c) => c.type === 'Script');
    engine.scene.removeComponentAt(entity.id, index);
    engine.tick(STEP);

    expect(messages.map((m) => m.text)).toContain('gone');
    expect(system.instanceCount).toBe(1);
    const survivor = entity.components.find((c): c is ScriptComponent => c.type === 'Script')!;
    expect(survivor.name).toBe('Survivor');
    expect(survivor.props.ticks).toBe(2);
  });

  it('delivers a message to every script on the target', () => {
    const entity = multi(
      { name: 'Sender', source: 'function update() { if (time.frame === 1) scene.send(entity, "ping", 7); }' },
      { name: 'Listener', source: 'function onMessage(name, payload) { props.got = name + ":" + payload; }', props: { got: '' } },
    );
    engine.scene.add(entity);
    engine.setMode('play');
    engine.tick(STEP);

    const scripts = entity.components.filter((c): c is ScriptComponent => c.type === 'Script');
    expect(scripts[1]!.props.got).toBe('ping:7');
  });

  it('broadcasts to every script in the scene', () => {
    const sender = multi({
      name: 'Sender',
      source: 'function update() { if (time.frame === 1) props.reached = scene.broadcast("wave"); }',
      props: { reached: 0 },
    });
    engine.scene.add(sender);
    const listener = multi({
      name: 'Listener',
      source: 'function onMessage(name) { props.heard = name; }',
      props: { heard: '' },
    });
    engine.scene.add(listener);
    engine.setMode('play');
    engine.tick(STEP);

    expect(scriptOf(listener).props.heard).toBe('wave');
    expect(scriptOf(sender).props.reached).toBe(1);
  });

  it('survives two scripts that answer each other, rather than blowing the stack', () => {
    const entity = multi(
      {
        name: 'Ping',
        source: `
          function update() { if (time.frame === 1) scene.send(entity, 'ping'); }
          function onMessage(name) { if (name === 'pong') { props.depth += 1; scene.send(entity, 'ping'); } }
        `,
        props: { depth: 0 },
      },
      {
        name: 'Pong',
        source: `function onMessage(name) { if (name === 'ping') scene.send(entity, 'pong'); }`,
      },
    );
    engine.scene.add(entity);
    engine.setMode('play');
    engine.tick(STEP);

    // Bounded by the depth guard rather than by the JavaScript stack.
    const depth = scriptOf(entity).props.depth as number;
    expect(depth).toBeGreaterThan(0);
    expect(depth).toBeLessThan(10);
  });

  it('runs lateUpdate after every update, which is what a follow camera needs', () => {
    const entity = multi(
      { name: 'Mover', source: 'function update() { game.set("log", game.get("log", "") + "u"); }' },
      { name: 'Camera', source: 'function lateUpdate() { game.set("log", game.get("log", "") + "L"); }' },
    );
    engine.scene.add(entity);
    engine.setMode('play');
    engine.tick(STEP);
    expect(engine.game.getVar('log')).toBe('uL');
  });

  it('fires a one-shot timer once, and a repeating one on schedule', () => {
    const entity = multi({
      name: 'Timers',
      source: `
        function start() {
          time.after(0.1, function () { props.once += 1; });
          time.every(0.05, function () { props.repeat += 1; });
        }
      `,
      props: { once: 0, repeat: 0 },
    });
    engine.scene.add(entity);
    engine.setMode('play');

    for (let i = 0; i < 30; i += 1) engine.tick(STEP);

    expect(scriptOf(entity).props.once).toBe(1);
    // Half a second of 50 ms intervals, give or take a step.
    expect(scriptOf(entity).props.repeat).toBeGreaterThanOrEqual(8);
    expect(scriptOf(entity).props.repeat).toBeLessThanOrEqual(11);
  });

  it('cancels a timer on request, and drops the rest when play stops', () => {
    const entity = multi({
      name: 'Timers',
      source: `
        let handle = 0;
        function start() { handle = time.every(0.05, function () { props.ticks += 1; }); }
        function update() { if (time.elapsed > 0.2) time.cancel(handle); }
      `,
      props: { ticks: 0 },
    });
    engine.scene.add(entity);
    engine.setMode('play');
    for (let i = 0; i < 30; i += 1) engine.tick(STEP);

    const cancelled = scriptOf(entity).props.ticks as number;
    for (let i = 0; i < 30; i += 1) engine.tick(STEP);
    expect(scriptOf(entity).props.ticks).toBe(cancelled);

    engine.setMode('edit');
    expect(system.timerCount).toBe(0);
  });

  it('parks a script whose timer callback throws, not the frame', () => {
    const entity = multi({
      name: 'Bad Timer',
      source: 'function start() { time.after(0.05, function () { throw new Error("late boom"); }); }',
    });
    engine.scene.add(entity);
    engine.setMode('play');
    for (let i = 0; i < 10; i += 1) engine.tick(STEP);

    expect(messages.some((m) => m.level === 'error' && /late boom/.test(m.text))).toBe(true);
  });

  it('exposes the maths helpers, so scripts do not each rewrite lerp', () => {
    const entity = multi({
      name: 'Maths',
      source: `
        function start() {
          props.lerp = mathf.lerp(0, 10, 0.5);
          props.clamped = mathf.clamp(15, 0, 10);
          props.angle = mathf.lerpAngle(350, 10, 0.5);
        }
      `,
      props: { lerp: 0, clamped: 0, angle: 0 },
    });
    engine.scene.add(entity);
    engine.setMode('play');
    engine.tick(STEP);

    const props = scriptOf(entity).props;
    expect(props.lerp).toBe(5);
    expect(props.clamped).toBe(10);
    // The short way round through 0, not the long way through 180.
    expect(props.angle).toBeCloseTo(0);
  });
});
