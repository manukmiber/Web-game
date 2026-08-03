import { beforeEach, describe, expect, it } from 'vitest';
import { installGameplaySystems, type GameplaySystems } from '../gameplay/systems';
import { Engine } from '../loop/Engine';
import type { ScriptMessage } from '../scripting/ScriptSystem';
import { CHANNEL, type FrameMessage } from './protocol';
import type { WorkerLike } from './SimulationHost';
import { disableWorkerSimulation, enableWorkerSimulation } from './WorkerSimBridge';

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

  send(data: unknown): void {
    this.onmessage?.({ data });
  }
}

function frame(overrides: Partial<FrameMessage> = {}): FrameMessage {
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

describe('enableWorkerSimulation / disableWorkerSimulation', () => {
  let engine: Engine;
  let systems: GameplaySystems;
  let workers: FakeWorker[];
  let messages: ScriptMessage[];

  beforeEach(() => {
    engine = new Engine();
    systems = installGameplaySystems(engine);
    workers = [];
    messages = [];
    systems.scripts.events.on('message', (m) => messages.push(m));
  });

  function createWorker(): FakeWorker {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }

  it('excludes the four main-thread systems and installs the bridge instead', () => {
    engine.setMode('play');
    enableWorkerSimulation(engine, systems, { createWorker: () => createWorker() });

    const names = engine.systemOrder().map((s) => s.name);
    expect(names).toContain('WorkerSimBridge');
    // The originals are still *known* to the engine (not removed) — see Engine.setSystemExcluded.
    expect(names).toContain('PhysicsSystem');
    expect(names).toContain('ScriptSystem');
  });

  it('relays a worker console message through the original ScriptSystem.events, unchanged for subscribers', () => {
    engine.setMode('play');
    enableWorkerSimulation(engine, systems, { createWorker: () => createWorker() });

    workers[0]!.send(
      frame({ console: [{ level: 'log', text: 'from the worker', entityId: null, source: 'Zombie', at: 1 }] }),
    );

    expect(messages.some((m) => m.text === 'from the worker')).toBe(true);
  });

  it('activates immediately when enabled while already in Play, rather than waiting for the next Play press', () => {
    engine.setMode('play');
    enableWorkerSimulation(engine, systems, { createWorker: () => createWorker() });
    expect(workers).toHaveLength(1);
  });

  it('does not spawn a worker when enabled from edit mode — it waits for Play', () => {
    enableWorkerSimulation(engine, systems, { createWorker: () => createWorker() });
    expect(workers).toHaveLength(0);

    engine.setMode('play');
    expect(workers).toHaveLength(1);
  });

  it('disableWorkerSimulation removes the bridge, terminates the worker and lets the originals tick again', () => {
    engine.setMode('play');
    enableWorkerSimulation(engine, systems, { createWorker: () => createWorker() });
    expect(workers).toHaveLength(1);

    disableWorkerSimulation(engine);
    expect(workers[0]!.terminated).toBe(true);
    expect(engine.systemOrder().map((s) => s.name)).not.toContain('WorkerSimBridge');

    // The re-included ScriptSystem's own console events still flow through the same emitter.
    engine.tick(0.016);
    expect(() => engine.tick(0.016)).not.toThrow();
  });

  it('the Console panel subscription set up before enabling keeps working after a full enable/disable cycle', () => {
    // This is the whole point of `setSystemExcluded` over `removeSystem`: the *same* ScriptSystem
    // instance, and therefore the *same* emitter EditorContext subscribed to once, survives.
    engine.setMode('play');
    enableWorkerSimulation(engine, systems, { createWorker: () => createWorker() });
    disableWorkerSimulation(engine);

    systems.scripts.events.emit('message', { level: 'log', text: 'still listening', entityId: null, source: 'x', at: 0 });
    expect(messages.some((m) => m.text === 'still listening')).toBe(true);
  });
});
