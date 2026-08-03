/**
 * Wires `SimulationHost` into the Engine's normal system schedule, and the two functions that
 * turn worker simulation on and off.
 *
 * Turning it on does not remove `PhysicsSystem`/`ScriptSystem`/`CharacterSystem`/`NpcSystem` —
 * it *excludes* them (`Engine.setSystemExcluded`, not `removeSystem`). `removeSystem` disposes
 * a system, and `ScriptSystem.dispose()` clears its `events` emitter; this bridge deliberately
 * keeps publishing worker-relayed console messages through that same, still-subscribed emitter
 * (see `SimulationHost`'s `consoleSink`), so the editor's Console panel needs no change at all
 * to keep working under either mode. Turning worker simulation back off un-excludes the
 * originals rather than constructing new ones, for the same reason.
 */

import type { GameplaySystems } from '../gameplay/systems';
import type { Engine, EngineMode, System, SystemStage } from '../loop/Engine';
import { SimulationHost, type SimulationHostOptions } from './SimulationHost';

const WORKER_MANAGED_SYSTEMS = ['PhysicsSystem', 'ScriptSystem', 'CharacterSystem', 'NpcSystem'] as const;

export class WorkerSimBridge implements System {
  readonly name = 'WorkerSimBridge';
  readonly runsIn: readonly EngineMode[] = ['play'];
  /** Where `PhysicsSystem` used to run — the systems it stands in for are `simulate`/`script`/
   * `resolve`, but a single stage is enough: this system's own `update` does no gameplay work
   * itself, only sends this frame's input and applies whatever the worker already sent back. */
  readonly stage: SystemStage = 'simulate';

  constructor(private readonly host: SimulationHost) {}

  update(_dt: number, engine: Engine): void {
    this.host.tick(engine);
  }

  /** Fires on every mode change, in both directions — the same hook the systems it stands in
   * for use to start and stop a play session. */
  reset(engine: Engine): void {
    if (engine.getMode() === 'play') this.host.activate(engine);
    else this.host.deactivate();
  }

  dispose(): void {
    this.host.dispose();
  }
}

/**
 * Hands `PhysicsSystem`/`ScriptSystem`/`CharacterSystem`/`NpcSystem`'s work to a simulation
 * Worker. Safe to call from either mode: if the engine is already in Play, the bridge starts
 * immediately rather than waiting for the next Play press, since `addSystem` alone does not
 * fire `reset()` — only `Engine.setMode` does.
 */
export function enableWorkerSimulation(
  engine: Engine,
  systems: GameplaySystems,
  options: Omit<SimulationHostOptions, 'consoleSink'> = {},
): WorkerSimBridge {
  for (const name of WORKER_MANAGED_SYSTEMS) engine.setSystemExcluded(name, true);
  const host = new SimulationHost({ ...options, consoleSink: systems.scripts.events });
  const bridge = new WorkerSimBridge(host);
  engine.addSystem(bridge);
  if (engine.getMode() === 'play') host.activate(engine);
  return bridge;
}

/**
 * Reverts to running physics and scripting on the main thread. The four original system
 * instances need no explicit re-sync: each already rebuilds its own state from the current
 * scene on its first `update` after being un-excluded (`PhysicsSystem.syncBodies`,
 * `ScriptSystem.syncInstances`), which is exactly the "everything here is new" pass either one
 * already runs the first time it sees an entity — the same behaviour a fresh Play press gets.
 */
export function disableWorkerSimulation(engine: Engine): void {
  engine.removeSystem('WorkerSimBridge');
  for (const name of WORKER_MANAGED_SYSTEMS) engine.setSystemExcluded(name, false);
}
