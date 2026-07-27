import { Emitter } from '../core/Emitter';
import { Scene } from '../scene/Scene';
import { AssetStore } from '../assets/AssetStore';
import { GameState } from '../gameplay/GameState';
import { HardwareBus } from '../hardware/HardwareBus';
import { InputState } from '../input/InputState';
import { FrameStats } from '../perf/FrameStats';
import { bindAssetStore } from '../render/material';
import type { AssetRecord, Entity, WorldSettings } from '../scene/types';
import '../components';

export type EngineMode = 'edit' | 'play';

interface SceneSnapshot {
  name: string;
  world: WorldSettings;
  entities: Entity[];
  assets: AssetRecord[];
}

/**
 * Deep copy of the scene, for Play mode's restore.
 *
 * A structural clone rather than a JSON round trip through the serializer, which is what this
 * used to be. Two reasons, both learned by watching it: the chunked format buckets entities by
 * world position and writes the buckets in key order, so an entity at a negative coordinate
 * came back in a different place in the Hierarchy every time you pressed stop — "the scene is
 * restored exactly as it was" has to mean exactly. And a 25 km world should not stringify
 * itself every time someone taps Play.
 */
function snapshotScene(scene: Scene): SceneSnapshot {
  return {
    name: scene.name,
    world: { ...scene.world },
    entities: scene.all().map((entity) => structuredClone(entity)),
    assets: scene.listAssets().map((asset) => ({ ...asset })),
  };
}

export interface System {
  readonly name: string;
  /** Which modes this system ticks in. A RenderSystem runs in both; a ScriptSystem only in play. */
  readonly runsIn: readonly EngineMode[];
  /** dt in seconds. */
  update(dt: number, engine: Engine): void;
  /**
   * Called on every mode change, after the scene has been snapshotted or restored.
   *
   * This is where a gameplay system drops the state it accumulated during a play session —
   * script instances, agent state machines. Without it, stopping and starting Play would
   * resume a half-finished simulation over a freshly restored scene.
   */
  reset?(engine: Engine): void;
  dispose?(): void;
}

interface EngineEvents {
  modeChanged: { mode: EngineMode };
  /** Emitted every frame after systems tick — the viewport renders off this. */
  afterUpdate: { dt: number };
}

/** Guards against a huge dt after a tab has been backgrounded. */
const MAX_FRAME_DELTA = 0.1;

/**
 * The engine loop, shared by the editor and (Phase 3) the game runtime.
 *
 * The mode flag is the whole Play-mode seam described in ARCHITECTURE.md §6: entering play
 * does not swap renderers or scene graphs, it just changes which systems tick. That is why
 * `runsIn` lives on the system rather than being an if-statement in here — adding a
 * ScriptSystem or PhysicsSystem later requires no change to this file.
 */
export class Engine {
  readonly events = new Emitter<EngineEvents>();
  readonly scene: Scene;
  readonly assets: AssetStore;
  /**
   * Frame measurement. Owned here rather than by the renderer because only the loop knows
   * where a frame begins and ends — the render call is one part of it, not the whole.
   */
  readonly stats = new FrameStats();
  /** Key and pointer state, written by whoever hosts the canvas and read by systems. */
  readonly input = new InputState();
  /** Runtime gameplay state — health, factions, script variables. Cleared on every mode change. */
  readonly game = new GameState();
  /**
   * Attached boards and their channels. Beside `input` rather than inside it because hardware
   * is bidirectional and input is not — but pumped on the same schedule, for the same reason.
   *
   * Devices survive Play and Stop: which board is plugged in is a property of the desk, not of
   * the scene, and closing a serial port the user opened by hand because they pressed Stop
   * would be its own kind of rude.
   */
  readonly hardware = new HardwareBus();

  private systems: System[] = [];
  private mode: EngineMode = 'edit';
  private running = false;
  private lastTime = 0;
  private frameHandle: number | null = null;
  /** Scene snapshot taken on entering play, restored on exit. §6 */
  private playSnapshot: SceneSnapshot | null = null;

  constructor(scene = new Scene(), assets = new AssetStore()) {
    this.scene = scene;
    this.assets = assets;
    bindAssetStore(assets);
  }

  getMode(): EngineMode {
    return this.mode;
  }

  addSystem(system: System): void {
    this.systems.push(system);
  }

  removeSystem(name: string): void {
    const index = this.systems.findIndex((s) => s.name === name);
    if (index === -1) return;
    this.systems[index]!.dispose?.();
    this.systems.splice(index, 1);
  }

  /**
   * Drives the frame loop on the main thread. This is the one part of the engine that is
   * inherently main-thread — requestAnimationFrame has no worker equivalent — and it is fine:
   * what §9.5 needs to move off-thread is the work systems do (chunk generation, physics,
   * pathfinding), not the clock that ticks them.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const frame = (now: number) => {
      if (!this.running) return;
      const dt = Math.min((now - this.lastTime) / 1000, MAX_FRAME_DELTA);
      this.lastTime = now;
      this.tick(dt);
      this.frameHandle = requestAnimationFrame(frame);
    };
    this.frameHandle = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  }

  tick(dt: number): void {
    this.stats.beginFrame();
    // Serial arrives whenever the USB stack feels like it. Applying it here, once, is what
    // gives a frame one consistent view of the rig instead of a stick that moves mid-tick —
    // the same contract `InputState` keeps for the keyboard. Pumped in edit mode too, so the
    // hardware panel shows live channel values while a pot is being calibrated.
    this.hardware.pump();
    for (const system of this.systems) {
      if (system.runsIn.includes(this.mode)) system.update(dt, this);
    }
    // Systems mutate transforms in place and mark them dirty; this is where those become one
    // event per entity, after every system has had its say and before anything renders.
    this.scene.flushTransforms();
    // Rendering happens inside this emit, so it is inside the measured window.
    this.events.emit('afterUpdate', { dt });
    this.stats.endFrame();
    this.stats.record(dt);
    // Edges (`wasPressed`) last exactly one tick, so this has to be after the systems ran.
    this.input.endFrame();
    this.hardware.endFrame();
  }

  /**
   * Play mode snapshots the scene so runtime mutations (a zombie walking, a crop growing) are
   * discarded on exit — the same guarantee Unity gives.
   *
   * The scene is only half of it. Everything a play session accumulates outside the scene —
   * health, script instances, agent state machines, held keys — is dropped here too, in one
   * place, so "what does stopping actually undo?" has a single answer rather than one per
   * system.
   */
  setMode(mode: EngineMode): void {
    if (mode === this.mode) return;
    if (mode === 'play') {
      this.playSnapshot = snapshotScene(this.scene);
    } else if (this.playSnapshot) {
      this.scene.load(this.playSnapshot);
      this.playSnapshot = null;
    }
    this.mode = mode;
    this.game.reset();
    this.input.clear();
    // Buffered lines and edges go; the connections stay. Before the systems reset, so a
    // system zeroing its outputs writes to a device that has forgotten what it last sent.
    this.hardware.reset();
    for (const system of this.systems) system.reset?.(this);
    this.events.emit('modeChanged', { mode });
  }

  dispose(): void {
    this.stop();
    for (const system of this.systems) system.dispose?.();
    this.systems = [];
    this.assets.disposeAll();
    this.hardware.dispose();
    this.events.clear();
  }
}
