import { Emitter } from '../core/Emitter';
import { Scene } from '../scene/Scene';
import { AssetStore } from '../assets/AssetStore';
import { AudioEngine } from '../audio/AudioEngine';
import { Clock } from './Clock';
import { EcsWorld } from '../ecs/EcsWorld';
import { scheduleSystems, type SystemStage } from '../ecs/Schedule';
import { GameState } from '../gameplay/GameState';
import { HardwareBus } from '../hardware/HardwareBus';
import { InputState } from '../input/InputState';
import { FrameStats } from '../perf/FrameStats';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { bindAssetStore, refreshMaterialTextures } from '../render/material';
import type { AssetRecord, Entity, WorldSettings } from '../scene/types';
import '../components';

export type EngineMode = 'edit' | 'play';

/**
 * Ceiling on `setTimeScale`.
 *
 * Eight times real speed at the 100 ms frame cap is a 0.8 s simulation step, which is already
 * well past the point where a fast body passes through a thin one between two frames. Anything
 * higher is not fast-forward, it is a different simulation.
 */
export const MAX_TIME_SCALE = 8;

// Re-exported so a system can declare its stage without reaching into the ECS layer for a type.
export type { SystemStage };

/**
 * Exported for `gameplay/SaveGame`, which needs exactly the same "restore this scene exactly"
 * guarantee for a player's save file that Play mode needs for the Stop button — see the note on
 * `snapshotScene`.
 */
export interface SceneSnapshot {
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
export function snapshotScene(scene: Scene): SceneSnapshot {
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
  /**
   * Where in the frame this runs. Defaults to `simulate`.
   *
   * Declared on the system rather than decided by the order someone called `addSystem`, so
   * inserting a system cannot silently reorder the ones already there. See `ecs/Schedule`.
   */
  readonly stage?: SystemStage;
  /** Systems that must tick before this one, by name. Unknown names are ignored. */
  readonly after?: readonly string[];
  /** Systems that must tick after this one, by name. */
  readonly before?: readonly string[];
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
  /**
   * The clock was paused, resumed or rescaled — by the toolbar, by a script, by anything.
   *
   * An event rather than a flag the UI polls, because both ends can move it: a script that sets
   * `time.scale = 0.2` for a slow-motion kill has to leave the toolbar's readout telling the
   * truth, and a toolbar that only ever wrote would show 1x over a game running at a fifth speed.
   */
  timeChanged: { paused: boolean; timeScale: number };
  /** Emitted every frame after systems tick — the viewport renders off this. */
  afterUpdate: { dt: number };
  /** Ordering constraints the scheduler could not satisfy. The console surfaces these. */
  scheduleConflicts: { conflicts: string[] };
}

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
  /**
   * The physics world.
   *
   * Owned by the Engine rather than by the PhysicsSystem, for the same reason `input` and
   * `game` are: three separate things need it and only one of them ticks it. The
   * CharacterSystem casts against it to find the floor, scripts raycast and shove bodies
   * through it, and the PhysicsSystem is simply whoever calls `step`. A world hidden inside
   * that system would have to be reached through `engine.systems.find(...)`, which is how a
   * clean seam turns into a service locator.
   */
  readonly physics = new PhysicsWorld();
  /**
   * Web Audio, behind the same seam `physics` and `hardware` use: several things need it — the
   * `AudioSystem`, scripts through `ScriptAudio` — and none of them owns it. Sounds are session
   * state exactly the way a zombie's health is (§6's "what restored has to cover"), so every
   * voice is stopped in `setMode` along with everything else a play session accumulates.
   */
  readonly audio: AudioEngine;
  /**
   * The ECS view of the scene: the component index and the queries built on it.
   *
   * Owned here for the same reason `physics` is — several systems need it and none of them owns
   * it. It is a projection of `scene`, so it never has to be kept in step by hand: it subscribes
   * to the same events everything else does.
   */
  readonly ecs: EcsWorld;

  private systems: System[] = [];
  /** `systems` sorted by the schedule. Recomputed only when the list changes. */
  private ordered: System[] = [];
  private scheduleDirty = false;
  private mode: EngineMode = 'edit';
  private running = false;
  private readonly clock = new Clock();
  private frameHandle: number | null = null;
  /** Scene snapshot taken on entering play, restored on exit. §6 */
  private playSnapshot: SceneSnapshot | null = null;
  private unsubscribes: (() => void)[] = [];
  /** Names ticking is skipped for — see `setSystemExcluded`. */
  private excluded = new Set<string>();

  constructor(scene = new Scene(), assets = new AssetStore(), audio = new AudioEngine()) {
    this.scene = scene;
    this.assets = assets;
    this.audio = audio;
    this.ecs = new EcsWorld(scene);
    bindAssetStore(assets);
    /**
     * Textures decode asynchronously; materials are built once and cached.
     *
     * Without this, a material built while its image was still in flight stayed untextured for
     * the rest of the session — the texture appeared only if something happened to change the
     * material's cache key afterwards, which reads as "textures work sometimes".
     */
    this.unsubscribes.push(
      assets.events.on('textureLoaded', ({ id }) => refreshMaterialTextures(id)),
    );
  }

  getMode(): EngineMode {
    return this.mode;
  }

  addSystem(system: System): void {
    this.systems.push(system);
    this.scheduleDirty = true;
  }

  removeSystem(name: string): void {
    const index = this.systems.findIndex((s) => s.name === name);
    if (index === -1) return;
    this.systems[index]!.dispose?.();
    this.systems.splice(index, 1);
    this.scheduleDirty = true;
  }

  /**
   * Skips a system's `update` without removing it — unlike `removeSystem`, the instance is
   * neither disposed nor dropped from `systemOrder()`.
   *
   * For a host that wants to temporarily hand a system's job to something else, the way
   * `worker/WorkerSimBridge.ts` hands `PhysicsSystem`/`ScriptSystem`/`CharacterSystem`/
   * `NpcSystem`'s work to a simulation Worker. `removeSystem` is the wrong tool for that: it
   * calls `dispose()`, and `ScriptSystem.dispose()` clears its `events` emitter — which still
   * has subscribers (the editor's Console panel) that must keep working if worker mode is later
   * turned back off. An excluded system keeps existing, keeps its listeners, and — because
   * `FrameStats` already reports zero for a section that stopped running (§9.7) — the
   * Performance panel shows exactly what actually happened with no change needed there either.
   */
  setSystemExcluded(name: string, excluded: boolean): void {
    if (excluded) this.excluded.add(name);
    else this.excluded.delete(name);
  }

  /**
   * The order systems will tick in, resolved from their stages and dependencies.
   *
   * Exposed because a computed order that cannot be inspected is worse than a hand-written one:
   * the Performance panel lists the systems in the order they ran, and "why is my system before
   * physics" has to be answerable.
   */
  systemOrder(): readonly System[] {
    this.reschedule();
    return this.ordered;
  }

  private reschedule(): void {
    if (!this.scheduleDirty && this.ordered.length === this.systems.length) return;
    this.scheduleDirty = false;
    const { order, conflicts } = scheduleSystems(this.systems);
    this.ordered = order;
    if (conflicts.length > 0) this.events.emit('scheduleConflicts', { conflicts });
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
    this.clock.reset(performance.now());
    const frame = (now: number) => {
      if (!this.running) return;
      // Two deltas out of one timestamp: what the world advances by, and how long the frame
      // really took. They are the same number until something pauses, scales or stalls — and
      // those are exactly the moments a frame counter must not be reading simulated time.
      const dt = this.clock.tick(now);
      this.tick(dt, this.clock.rawDelta);
      this.frameHandle = requestAnimationFrame(frame);
    };
    this.frameHandle = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  }

  /**
   * Freezes the frame clock without stopping the loop — `tick` keeps being called with dt 0,
   * so rendering and the hardware pump stay live while gameplay time stands still. Distinct
   * from `stop`, which also cancels the `requestAnimationFrame` chain.
   *
   * That distinction is the whole reason this is not just "stop the loop": a paused game still
   * has to draw, still has to answer the gizmos, and still has to show a live frame rate — the
   * frame counter reads real elapsed time (`Clock.rawDelta`) precisely so it keeps working here.
   */
  pause(): void {
    if (this.clock.isPaused) return;
    this.clock.pause();
    this.events.emit('timeChanged', { paused: true, timeScale: this.clock.timeScale });
  }

  resume(): void {
    if (!this.clock.isPaused) return;
    this.clock.resume(performance.now());
    this.events.emit('timeChanged', { paused: false, timeScale: this.clock.timeScale });
  }

  setPaused(paused: boolean): void {
    if (paused) this.pause();
    else this.resume();
  }

  get paused(): boolean {
    return this.clock.isPaused;
  }

  /**
   * Scales every non-paused dt — 0.5 for slow motion, 2 for fast-forward. 1 is real time.
   *
   * Clamped rather than trusted, because the two values outside the range are both traps: a
   * negative scale runs the solver backwards through collision responses that assume time moves
   * forward, and a very large one multiplies the frame cap into a single step big enough to
   * tunnel a body through a wall. Zero is allowed and means exactly what pausing means, so a
   * script can hold time still without reaching for a second concept.
   */
  setTimeScale(scale: number): void {
    const clamped = Number.isFinite(scale) ? Math.min(Math.max(scale, 0), MAX_TIME_SCALE) : 1;
    if (clamped === this.clock.timeScale) return;
    this.clock.timeScale = clamped;
    this.events.emit('timeChanged', { paused: this.clock.isPaused, timeScale: clamped });
  }

  getTimeScale(): number {
    return this.clock.timeScale;
  }

  /** The last frame's dt with jitter smoothed out — see `Clock` — for consumers like a camera that would rather not see it raw. */
  get smoothDelta(): number {
    return this.clock.smoothDelta;
  }

  /**
   * One frame: pump the devices, run the systems, flush transforms, render, measure.
   *
   * `realDt` is the wall-clock length of the frame and defaults to `dt`, which is right for
   * every caller that drives the loop by hand (tests, a headless host) where the two cannot
   * differ. The `requestAnimationFrame` loop passes both, because there they routinely do —
   * see `Clock.rawDelta`.
   */
  tick(dt: number, realDt: number = dt): void {
    this.stats.beginFrame();
    // Serial arrives whenever the USB stack feels like it. Applying it here, once, is what
    // gives a frame one consistent view of the rig instead of a stick that moves mid-tick —
    // the same contract `InputState` keeps for the keyboard. Pumped in edit mode too, so the
    // hardware panel shows live channel values while a pot is being calibrated.
    this.hardware.pump();
    // Timed individually rather than as a block. "The frame costs 14 ms" is a fact you can do
    // nothing with; "11 of the 14 are in the PhysicsSystem" tells you what to fix, and it is
    // the difference between the performance panel being a readout and being an instrument.
    this.reschedule();
    for (const system of this.ordered) {
      if (!system.runsIn.includes(this.mode) || this.excluded.has(system.name)) continue;
      this.stats.beginSection(system.name);
      system.update(dt, this);
      this.stats.endSection(system.name);
    }
    // Systems mutate transforms in place and mark them dirty; this is where those become one
    // event per entity, after every system has had its say and before anything renders.
    this.scene.flushTransforms();
    // Rendering happens inside this emit, so it is inside the measured window.
    this.events.emit('afterUpdate', { dt });
    this.stats.endFrame();
    // The real elapsed time, not `dt`: the counter reports what the machine did, and the whole
    // value of a 1% low is that it sees the frames the simulation's own clamp hides.
    this.stats.record(realDt);
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
    // Pause and time scale are session state in exactly the way health and held keys are: a
    // script that dropped into slow motion for a death animation, or a play session left paused
    // on the last frame someone looked at, must not follow the editor back into edit mode. That
    // is how you end up dragging a gizmo through treacle and filing it as a rendering bug.
    this.resume();
    this.setTimeScale(1);
    // Bodies describe entities that are about to be restored from the snapshot, so every one of
    // them is stale — including their velocities, which are the clearest example of state a
    // play session accumulates outside the scene.
    this.physics.clear();
    // Buffered lines and edges go; the connections stay. Before the systems reset, so a
    // system zeroing its outputs writes to a device that has forgotten what it last sent.
    this.hardware.reset();
    // Every voice — autoplay ambience, a script's one-shot, the music track — dies here, before
    // `AudioSystem.reset` forgets which entities it was tracking. Leaving a sound playing across
    // Stop would be the audio equivalent of the zombie-at-12-health bug `GameState` guards against.
    this.audio.stopAll();
    for (const system of this.systems) system.reset?.(this);
    this.events.emit('modeChanged', { mode });
  }

  dispose(): void {
    this.stop();
    for (const system of this.systems) system.dispose?.();
    this.systems = [];
    this.ordered = [];
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
    this.ecs.dispose();
    this.assets.disposeAll();
    this.hardware.dispose();
    this.audio.dispose();
    this.events.clear();
  }
}
