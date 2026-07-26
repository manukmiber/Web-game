import { Emitter } from '../core/Emitter';
import { Scene } from '../scene/Scene';
import { AssetStore } from '../assets/AssetStore';
import { bindAssetStore } from '../render/material';
import { sceneFromJSON, sceneToJSON } from '../serialization/serialize';
import '../components';

export type EngineMode = 'edit' | 'play';

export interface System {
  readonly name: string;
  /** Which modes this system ticks in. A RenderSystem runs in both; a ScriptSystem only in play. */
  readonly runsIn: readonly EngineMode[];
  /** dt in seconds. */
  update(dt: number, engine: Engine): void;
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

  private systems: System[] = [];
  private mode: EngineMode = 'edit';
  private running = false;
  private lastTime = 0;
  private frameHandle: number | null = null;
  /** Scene snapshot taken on entering play, restored on exit. §6 */
  private playSnapshot: string | null = null;

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
    for (const system of this.systems) {
      if (system.runsIn.includes(this.mode)) system.update(dt, this);
    }
    this.events.emit('afterUpdate', { dt });
  }

  /**
   * Play mode snapshots the scene so runtime mutations (a zombie walking, a crop growing) are
   * discarded on exit — the same guarantee Unity gives. Phase 1 has no systems that mutate,
   * so this is groundwork; it is here now because retrofitting it after gameplay systems
   * exist means auditing every one of them for what they touched.
   */
  setMode(mode: EngineMode): void {
    if (mode === this.mode) return;
    if (mode === 'play') {
      this.playSnapshot = sceneToJSON(this.scene, false);
    } else if (this.playSnapshot) {
      sceneFromJSON(this.scene, this.playSnapshot);
      this.playSnapshot = null;
    }
    this.mode = mode;
    this.events.emit('modeChanged', { mode });
  }

  dispose(): void {
    this.stop();
    for (const system of this.systems) system.dispose?.();
    this.systems = [];
    this.assets.disposeAll();
    this.events.clear();
  }
}
