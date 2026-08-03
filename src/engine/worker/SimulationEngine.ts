/**
 * The worker's own headless play session.
 *
 * This is the part of "moving physics & scripting into a Web Worker" that is, deliberately, not
 * new code: it is the same `Engine`, the same `PhysicsSystem`/`ScriptSystem`/`CharacterSystem`/
 * `NpcSystem`, wired up the same way `gameplay/systems.ts` already does, just hosted somewhere
 * other than the editor's main thread. ARCHITECTURE.md §15.1 said as much before this file
 * existed: "about 1,200 lines that read the components directly, run in a Worker without a
 * single import changing." Nothing here reimplements physics or scripting; it only reimplements
 * the plumbing around them — loading a scene in, and reporting what happened back out.
 *
 * `HardwareSystem` and `AudioSystem` are deliberately *not* installed here. Hardware transports
 * (`navigator.serial`) are main-thread-only and `HardwareOutput` bindings only need the scene
 * and game state this class already mirrors back every frame, so `HardwareSystem` keeps running
 * on the host, upstream of the input snapshot this class receives — see `WorkerSimBridge`.
 * `AudioSystem` reads camera and `AudioSource` transforms that are mirrored back every frame
 * too, so it also stays host-side, where a real `AudioContext` exists to drive. Only
 * script-triggered sound (`audio.play`, `entity.playSound`) originates here, through
 * `RelayAudioEngine`.
 */

import { NpcSystem } from '../ai/NpcSystem';
import { AssetStore } from '../assets/AssetStore';
import type { GameStateSnapshot } from '../gameplay/GameState';
import { CharacterSystem } from '../gameplay/CharacterSystem';
import type { InputSnapshot } from '../input/InputState';
import { Engine, type SceneSnapshot } from '../loop/Engine';
import { PhysicsSystem } from '../physics/PhysicsSystem';
import { Scene } from '../scene/Scene';
import type { EntityId } from '../scene/types';
import { ScriptSystem } from '../scripting/ScriptSystem';
import type { ScriptMessage } from '../scripting/ScriptSystem';
import { CHANNEL, type ClockState, type FrameMessage, type TransformUpdate } from './protocol';
import { RelayAudioEngine } from './RelayAudioEngine';
import { SceneOpCollector } from './sceneMirror';

export class SimulationEngine {
  readonly engine: Engine;
  private readonly physics: PhysicsSystem;
  private readonly scripts: ScriptSystem;
  private readonly audioRelay: RelayAudioEngine;

  private opCollector: SceneOpCollector | null = null;
  private dirtyTransforms = new Set<EntityId>();
  private consoleBuffer: ScriptMessage[] = [];
  private frameListeners: ((message: FrameMessage) => void)[] = [];
  private seq = 0;
  private unsubscribes: (() => void)[] = [];

  constructor() {
    this.audioRelay = new RelayAudioEngine();
    this.engine = new Engine(new Scene(), new AssetStore(), this.audioRelay);

    this.physics = new PhysicsSystem();
    const characters = new CharacterSystem();
    this.scripts = new ScriptSystem({ physics: this.physics, characters });
    const npcs = new NpcSystem();

    this.engine.addSystem(this.physics);
    this.engine.addSystem(this.scripts);
    this.engine.addSystem(characters);
    this.engine.addSystem(npcs);

    this.unsubscribes.push(
      this.engine.scene.events.on('transformChanged', ({ id }) => this.dirtyTransforms.add(id)),
      this.scripts.events.on('message', (message) => this.consoleBuffer.push(message)),
      this.engine.events.on('afterUpdate', () => this.emitFrame()),
    );
  }

  /**
   * Loads a scene and starts a play session from it. Called exactly once per instance: a fresh
   * `SimulationEngine` is what a new Worker gives you, and `SimulationHost` spawns a fresh
   * Worker for every Play press and every watchdog recovery alike, rather than trying to cycle
   * one worker's `Engine` back through `setMode('edit')` and into `'play'` again — `setMode` is
   * a no-op when the mode does not change, so reusing one would need to leave 'play' first, and
   * a fresh process is simpler than reproducing that dance correctly.
   *
   * Subscribing `SceneOpCollector` *after* the load matters even though it can only run once:
   * `Scene.load` emits one `sceneReplaced`, not a flood of `entityAdded`, so the collector must
   * not be listening while it happens, or the first frame would open with a spurious "everything
   * was just added" op log.
   *
   * Deliberately does *not* call `engine.start()` — that needs `requestAnimationFrame`, which
   * only exists once the entry point has polyfilled it (`simulationWorkerEntry.ts`). Keeping
   * this class ignorant of that is what lets a test drive frames by hand with `engine.tick(dt)`,
   * the same way `Engine.test.ts` already does for the main-thread engine.
   */
  init(scene: SceneSnapshot, game: GameStateSnapshot): void {
    this.engine.scene.load(scene);
    // `setMode('play')` unconditionally calls `game.reset()` as part of "what does entering
    // Play mode undo" (Engine.setMode) — loading game state has to happen after, or it is wiped
    // the instant it lands.
    this.engine.setMode('play');
    this.engine.game.fromJSON(game);
    this.opCollector = new SceneOpCollector(this.engine.scene);
    this.dirtyTransforms.clear();
    this.consoleBuffer = [];
    this.seq = 0;
  }

  /**
   * Applies a snapshot of the host's input and clock state, received asynchronously — see
   * `InputState.applySnapshot` for how press/release edges survive the trip.
   *
   * Clock state only calls through to the engine when it actually changed, the same guard
   * `Engine.setPaused`/`setTimeScale` apply internally — redundant here, but it avoids emitting
   * a `timeChanged` a script never asked for on every single input message.
   */
  applyInput(input: InputSnapshot, clock: ClockState): void {
    this.engine.input.applySnapshot(input);
    if (clock.paused !== this.engine.paused) this.engine.setPaused(clock.paused);
    if (clock.timeScale !== this.engine.getTimeScale()) this.engine.setTimeScale(clock.timeScale);
  }

  /** Called once per completed tick, with this tick's outbound message. */
  onFrame(listener: (message: FrameMessage) => void): () => void {
    this.frameListeners.push(listener);
    return () => {
      const index = this.frameListeners.indexOf(listener);
      if (index !== -1) this.frameListeners.splice(index, 1);
    };
  }

  dispose(): void {
    this.opCollector?.dispose();
    this.opCollector = null;
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
    this.frameListeners = [];
    this.engine.dispose();
  }

  private emitFrame(): void {
    const transforms: TransformUpdate[] = [];
    for (const id of this.dirtyTransforms) {
      const entity = this.engine.scene.get(id);
      if (!entity) continue;
      transforms.push({
        id,
        position: [...entity.transform.position],
        rotation: [...entity.transform.rotation],
        scale: [...entity.transform.scale],
      });
    }
    this.dirtyTransforms.clear();

    const ops = this.opCollector?.drain() ?? [];
    const consoleMessages = this.consoleBuffer;
    this.consoleBuffer = [];
    const audio = this.audioRelay.drain();
    const diagnostics = this.physics.getDiagnostics();

    this.seq += 1;
    const message: FrameMessage = {
      channel: CHANNEL,
      type: 'frame',
      seq: this.seq,
      transforms,
      ops,
      console: consoleMessages,
      audio,
      game: this.engine.game.toJSON(),
      clock: { paused: this.engine.paused, timeScale: this.engine.getTimeScale() },
      diagnostics: {
        bodies: diagnostics.bodies,
        steps: diagnostics.steps,
        throttled: diagnostics.throttled,
        scriptInstances: this.scripts.instanceCount,
        scriptTimers: this.scripts.timerCount,
      },
    };
    for (const listener of [...this.frameListeners]) listener(message);
  }
}
