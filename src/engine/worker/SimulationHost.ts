/**
 * The main-thread half of the worker bridge — owns the `Worker`, and is the one place that
 * decides whether to trust what comes back from it.
 *
 * Two things this buys over running physics and scripting on the main thread, stated honestly
 * rather than oversold (see `protocol.ts`'s note on what the isolation boundary actually is):
 *
 * 1. **A hang is recoverable.** An infinite loop in a script used to hang the tab — nothing on
 *    the main thread can interrupt synchronous JavaScript on the main thread. A Worker can be
 *    `terminate()`d from the *outside*, which is a capability the main thread does not have over
 *    itself. The watchdog below is what turns "the worker stopped responding" into "the
 *    simulation restarted," instead of a session that needs a page reload.
 * 2. **A forged message can, at worst, confuse this bridge — never reach the page.** Every
 *    inbound message is parsed by `protocol.parseWorkerMessage` before a single field of it
 *    touches `engine.scene`.
 */

import type { AudioHandle } from '../audio/AudioEngine';
import type { Engine } from '../loop/Engine';
import { snapshotScene } from '../loop/Engine';
import type { ScriptMessage, ScriptSystemEvents } from '../scripting/ScriptSystem';
import { applyAudioCommands } from './RelayAudioEngine';
import { applySceneOps } from './sceneMirror';
import { CHANNEL, parseWorkerMessage, type FrameMessage, type InitMessage, type InputMessage } from './protocol';

/** The subset of the real `Worker` API this bridge needs — small enough that a test can hand in
 * a fake without standing up a browser. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface SimulationHostOptions {
  /** Defaults to spawning the real `simulationWorkerEntry.ts` module worker. Overridden by
   * every test in this file, and by anything running where `Worker` does not exist. */
  createWorker?: () => WorkerLike;
  /** How long the worker may go without a message before it is presumed hung. Default 4000ms —
   * generous relative to a real frame (a legitimate physics/script tick is bounded to well under
   * a second by `PhysicsSystem`'s own substep cap), so this is about tolerating a slow device or
   * a backgrounded tab's timer throttling, not about detecting a hang quickly. */
  hangTimeoutMs?: number;
  now?: () => number;
  /**
   * Where relayed script console messages, and host-generated notices (a watchdog restart), are
   * announced. Meant to be the *same* `ScriptSystem.events` emitter `installGameplaySystems`
   * already returns — the instance stays installed (idle) while the worker is active purely so
   * this can keep publishing through it, which is what lets the editor's existing
   * `systems.scripts.events.on('message', ...)` subscription work unchanged under worker mode.
   */
  consoleSink: { emit: (event: 'message', payload: ScriptMessage) => void };
}

function defaultCreateWorker(): WorkerLike {
  return new Worker(new URL('./simulationWorkerEntry.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

export class SimulationHost {
  private readonly createWorker: () => WorkerLike;
  private readonly hangTimeoutMs: number;
  private readonly now: () => number;
  private readonly consoleSink: SimulationHostOptions['consoleSink'];

  private worker: WorkerLike | null = null;
  private lastSeenAt = 0;
  /** The audio voices this play session has started, keyed by the relay's local id — see
   * `RelayAudioEngine`/`applyAudioCommands`. Reset on every (re)activation. */
  private audioVoices = new Map<number, AudioHandle>();

  constructor(options: SimulationHostOptions) {
    this.createWorker = options.createWorker ?? defaultCreateWorker;
    this.hangTimeoutMs = options.hangTimeoutMs ?? 4000;
    this.now = options.now ?? (() => performance.now());
    this.consoleSink = options.consoleSink;
  }

  get active(): boolean {
    return this.worker !== null;
  }

  /** Spawns the worker and sends it a snapshot of `engine`'s current scene and game state. */
  activate(engine: Engine): void {
    this.spawn(engine);
  }

  deactivate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.audioVoices.clear();
  }

  /**
   * Called once per host frame. Sends this frame's input/clock snapshot and checks the
   * watchdog — applying anything the worker sent back happens as it arrives, in `handleMessage`,
   * not here; see that method's doc comment for why that is still frame-consistent.
   */
  tick(engine: Engine): void {
    if (!this.worker) return;
    if (this.now() - this.lastSeenAt > this.hangTimeoutMs) {
      this.restart(
        engine,
        `Simulation worker did not respond for over ${(this.hangTimeoutMs / 1000).toFixed(1)}s ` +
          '(likely an infinite loop in a script) — restarting the simulation.',
      );
      return;
    }
    const message: InputMessage = {
      channel: CHANNEL,
      type: 'input',
      input: engine.input.toSnapshot(),
      clock: { paused: engine.paused, timeScale: engine.getTimeScale() },
    };
    this.worker.postMessage(message);
  }

  dispose(): void {
    this.deactivate();
  }

  // ---------------------------------------------------------------- internal

  private spawn(engine: Engine): void {
    const worker = this.createWorker();
    this.worker = worker;
    this.lastSeenAt = this.now();
    this.audioVoices.clear();

    worker.onmessage = (event) => {
      // A message from a worker this host has since replaced — a restart racing an in-flight
      // reply. Discarding it here, by identity, is what makes the watchdog itself immune to
      // being fooled by an echo from the very worker it just gave up on.
      if (this.worker !== worker) return;
      this.handleMessage(engine, event.data);
    };
    worker.onerror = () => {
      if (this.worker !== worker) return;
      this.restart(engine, 'Simulation worker crashed and was restarted.');
    };

    const init: InitMessage = {
      channel: CHANNEL,
      type: 'init',
      scene: snapshotScene(engine.scene),
      game: engine.game.toJSON(),
    };
    worker.postMessage(init);
  }

  private restart(engine: Engine, reason: string): void {
    this.worker?.terminate();
    this.worker = null;
    this.report('error', reason);
    this.spawn(engine);
  }

  /**
   * Applied as each frame arrives rather than batched until the next `tick()`. That sounds like
   * it risks the inconsistent-mid-frame reads ARCHITECTURE.md §12.3 warns hardware input away
   * from, but the two are not the same shape of problem: a message handler can only ever run
   * *between* two synchronous `Engine.tick()` calls, never inside one (JavaScript's run-to-
   * completion guarantee), so every system in a given host frame still sees one consistent
   * scene — just whichever consistent scene was current when that frame's `tick()` began. And
   * applying immediately, rather than coalescing until the next host frame, is what keeps every
   * op, console line and audio command from an intermediate worker frame (if the worker ever
   * gets ahead of the host's own frame rate) from being silently dropped in favour of only the
   * latest one.
   */
  private handleMessage(engine: Engine, data: unknown): void {
    const message = parseWorkerMessage(data);
    if (!message) return;
    this.lastSeenAt = this.now();

    if (message.type === 'fatal') {
      this.restart(engine, `Simulation worker reported an internal error and was restarted: ${message.message}`);
      return;
    }

    this.applyFrame(engine, message);
  }

  private applyFrame(engine: Engine, message: FrameMessage): void {
    applySceneOps(engine.scene, message.ops);

    for (const update of message.transforms) {
      const entity = engine.scene.get(update.id);
      if (!entity) continue;
      entity.transform.position = update.position;
      entity.transform.rotation = update.rotation;
      entity.transform.scale = update.scale;
      engine.scene.markTransformDirty(update.id);
    }

    // Defense-in-depth alongside `protocol.isGameStateSnapshot`: a validator gap here has no
    // per-element isolation the way `applySceneOps`/`applyAudioCommands` give the ops and audio
    // arrays, so a `game` this host's own validator failed to fully reject would otherwise throw
    // out of `onmessage` uncaught and skip every step after it in this frame (clock sync, audio,
    // console) rather than degrading to "this tick's game-state update did not apply."
    try {
      engine.game.syncFrom(message.game);
    } catch (error) {
      console.warn('[SimulationHost] dropped a malformed game-state snapshot:', error);
    }

    if (message.clock.paused !== engine.paused) engine.setPaused(message.clock.paused);
    if (message.clock.timeScale !== engine.getTimeScale()) engine.setTimeScale(message.clock.timeScale);

    applyAudioCommands(engine.audio, message.audio, this.audioVoices);

    for (const entry of message.console) this.consoleSink.emit('message', entry);
  }

  private report(level: ScriptMessage['level'], text: string): void {
    this.consoleSink.emit('message', { level, text, entityId: null, source: 'Simulation', at: 0 });
  }
}

/** Re-exported so a consumer only needs one import for the whole worker-events surface. */
export type { ScriptSystemEvents };
