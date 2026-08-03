import { beforeEach, describe, expect, it } from 'vitest';
import { AssetStore } from '../assets/AssetStore';
import { AudioEngine } from '../audio/AudioEngine';
import { Engine } from '../loop/Engine';
import { Scene } from '../scene/Scene';
import { createTransform } from '../scene/types';
import type { ScriptMessage } from '../scripting/ScriptSystem';
import { CHANNEL, type FrameMessage } from './protocol';
import { SimulationHost, type WorkerLike } from './SimulationHost';

class FakeWorker implements WorkerLike {
  posted: unknown[] = [];
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Test-only: simulate the worker replying. */
  send(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** Test-only: simulate an uncaught exception escaping the worker. */
  crash(): void {
    this.onerror?.({});
  }
}

function emptyFrame(overrides: Partial<FrameMessage> = {}): FrameMessage {
  return {
    channel: CHANNEL,
    type: 'frame',
    seq: 1,
    transforms: [],
    ops: [],
    console: [],
    audio: [],
    game: { actors: [], vars: [] },
    clock: { paused: false, timeScale: 1 },
    diagnostics: { bodies: 0, steps: 1, throttled: false, scriptInstances: 0, scriptTimers: 0 },
    ...overrides,
  };
}

describe('SimulationHost', () => {
  let engine: Engine;
  let workers: FakeWorker[];
  let consoleMessages: ScriptMessage[];
  let host: SimulationHost;
  let now: number;

  beforeEach(() => {
    engine = new Engine(new Scene(), new AssetStore(), new AudioEngine(() => {
      throw new Error('no audio in tests');
    }));
    workers = [];
    consoleMessages = [];
    now = 0;
    host = new SimulationHost({
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      now: () => now,
      hangTimeoutMs: 1000,
      consoleSink: { emit: (_event, payload) => consoleMessages.push(payload) },
    });
  });

  it('sends an init message with the current scene and game state on activate', () => {
    engine.scene.add({ id: 'e1', name: 'Box', parentId: null, transform: createTransform(), components: [] });
    host.activate(engine);

    expect(workers).toHaveLength(1);
    const init = workers[0]!.posted[0] as { type: string; scene: { entities: { id: string }[] } };
    expect(init.type).toBe('init');
    expect(init.scene.entities.map((e) => e.id)).toEqual(['e1']);
  });

  it('applies transforms, ops, console, audio and game state from a valid frame', () => {
    engine.scene.add({ id: 'e1', name: 'Box', parentId: null, transform: createTransform(), components: [] });
    host.activate(engine);
    const worker = workers[0]!;

    worker.send(
      emptyFrame({
        transforms: [{ id: 'e1', position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] }],
        ops: [{ op: 'rename', id: 'e1', name: 'Renamed' }],
        console: [{ level: 'log', text: 'hi', entityId: 'e1', source: 'Script', at: 1 }],
        audio: [{ method: 'play', voiceId: 1, args: ['sfx.mp3', {}] }],
        game: { actors: [{ id: 'e1', faction: 'x', health: 5, maxHealth: 10, alive: true }], vars: [] },
      }),
    );

    engine.scene.flushTransforms();
    expect(engine.scene.get('e1')?.transform.position).toEqual([1, 2, 3]);
    expect(engine.scene.get('e1')?.name).toBe('Renamed');
    expect(consoleMessages.some((m) => m.text === 'hi')).toBe(true);
    expect(engine.game.get('e1')?.health).toBe(5);
  });

  it('does not announce "Game loaded" on every frame — GameState.syncFrom stays quiet', () => {
    host.activate(engine);
    let restores = 0;
    engine.game.events.on('restored', () => (restores += 1));

    workers[0]!.send(emptyFrame());
    workers[0]!.send(emptyFrame({ seq: 2 }));
    expect(restores).toBe(0);
  });

  it('applies the worker-reported clock (a script setting time.scale) to the host engine', () => {
    host.activate(engine);
    workers[0]!.send(emptyFrame({ clock: { paused: true, timeScale: 0.25 } }));

    expect(engine.paused).toBe(true);
    expect(engine.getTimeScale()).toBeCloseTo(0.25);
  });

  it('rejects a malformed or forged message without applying anything or throwing', () => {
    engine.scene.add({ id: 'e1', name: 'Box', parentId: null, transform: createTransform(), components: [] });
    host.activate(engine);
    const worker = workers[0]!;

    expect(() => worker.send({ channel: CHANNEL, type: 'frame', seq: 'not-a-number' })).not.toThrow();
    expect(() => worker.send({ channel: 'some-other-channel', type: 'frame' })).not.toThrow();
    expect(() => worker.send('just a string')).not.toThrow();

    expect(engine.scene.get('e1')?.name).toBe('Box');
    expect(consoleMessages).toEqual([]);
  });

  it('restarts the worker on a "fatal" message and reports it through the console sink', () => {
    host.activate(engine);
    const first = workers[0]!;

    first.send({ channel: CHANNEL, type: 'fatal', message: 'kaboom' });

    expect(first.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(consoleMessages.some((m) => m.level === 'error' && m.text.includes('kaboom'))).toBe(true);
  });

  it('restarts the worker immediately on onerror, without waiting for the watchdog', () => {
    host.activate(engine);
    const first = workers[0]!;

    first.crash();

    expect(first.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(consoleMessages.some((m) => m.level === 'error')).toBe(true);
  });

  it('ignores a late message from a worker it has already replaced', () => {
    host.activate(engine);
    const first = workers[0]!;
    first.crash(); // triggers a restart — `first` is no longer the active worker
    consoleMessages.length = 0;

    // The old, terminated worker still fires a message somehow (a real Worker would not, but a
    // test double proves the identity guard rather than trusting the platform to enforce it).
    first.send(emptyFrame({ console: [{ level: 'error', text: 'stale', entityId: null, source: 'x', at: 0 }] }));

    expect(consoleMessages).toEqual([]);
  });

  it('watchdog: restarts after the timeout with no response, and the restart clears it', () => {
    host.activate(engine);
    expect(workers).toHaveLength(1);

    now += 1500; // past the 1000ms hangTimeoutMs with no reply
    host.tick(engine);

    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(consoleMessages.some((m) => m.level === 'error' && /infinite loop/.test(m.text))).toBe(true);

    // The fresh worker gets a full timeout window of its own, not whatever was left of the last one.
    now += 500;
    host.tick(engine);
    expect(workers).toHaveLength(2);
  });

  it('a reply resets the watchdog clock', () => {
    host.activate(engine);
    now += 900;
    workers[0]!.send(emptyFrame());
    now += 900; // would have tripped a 1000ms timeout measured from activation, not from the reply
    host.tick(engine);
    expect(workers).toHaveLength(1);
  });

  it('deactivate terminates the worker and stops sending it input', () => {
    host.activate(engine);
    host.deactivate();
    expect(workers[0]!.terminated).toBe(true);

    host.tick(engine);
    expect(workers).toHaveLength(1); // tick() is a no-op once inactive
  });

  it('tick() sends the current input snapshot every call while active', () => {
    host.activate(engine);
    engine.input.setKey('KeyW', true);
    host.tick(engine);

    const inputMessages = workers[0]!.posted.filter((m) => (m as { type: string }).type === 'input');
    expect(inputMessages).toHaveLength(1);
    expect((inputMessages[0] as { input: { down: string[] } }).input.down).toContain('KeyW');
  });
});
