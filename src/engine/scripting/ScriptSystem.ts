import type { ScriptComponent, ScriptPropValue } from '../components/Script';
import { Emitter } from '../core/Emitter';
import type { Engine, EngineMode, System } from '../loop/Engine';
import type { EntityId } from '../scene/types';
import {
  EntityHandle,
  ScriptGame,
  ScriptHardware,
  ScriptWorld,
  type ScriptTime,
} from './ScriptApi';
import { compileScript, describeError, type ScriptContext, type ScriptHooks } from './sandbox';

export interface ScriptMessage {
  level: 'log' | 'warn' | 'error';
  text: string;
  entityId: EntityId | null;
  /** The Script component's name, for "Zombie AI: ..." prefixes in the console. */
  source: string;
  /** Seconds since Play mode started. */
  at: number;
}

export interface ScriptSystemEvents {
  message: ScriptMessage;
}

interface Instance {
  entityId: EntityId;
  scriptName: string;
  /** The source this instance was compiled from; a change recompiles it. */
  source: string;
  /** Identity of the props object, so a component swap rebuilds the closure over it. */
  props: Record<string, ScriptPropValue>;
  hooks: ScriptHooks;
  context: ScriptContext;
  started: boolean;
  /** Set after a throw. A failed script is not retried until its source changes. */
  failed: boolean;
  slowWarned: boolean;
}

/** A single script update above this is worth a one-time warning, in milliseconds. */
const SLOW_UPDATE_MS = 4;

/**
 * Runs Script components in Play mode.
 *
 * Three rules shape it:
 *
 * 1. **One bad script must not take the frame down.** Every hook call is wrapped; a throw is
 *    reported once, the offending instance is parked, and every other script keeps running.
 *    The alternative — an exception escaping into `Engine.tick` — kills the loop, and with it
 *    the editor's viewport, for a typo in one of a hundred scripts.
 * 2. **Editing a script while it runs reloads it.** The source is compared every frame, and a
 *    changed one is destroyed and rebuilt. That is what makes the script editor usable at all:
 *    tweak, watch, tweak again, without leaving Play mode.
 * 3. **Nothing survives Play mode.** Instances are dropped on stop, matching the scene
 *    snapshot restore — see ARCHITECTURE.md §6.
 *
 * What it cannot do is stop an infinite loop: a `while (true)` in a script hangs the tab, the
 * same way it would anywhere else on the main thread. Only moving scripts to a Worker fixes
 * that, and the note in `sandbox.ts` explains why that is the same change as real isolation.
 */
export class ScriptSystem implements System {
  readonly name = 'ScriptSystem';
  readonly runsIn: readonly EngineMode[] = ['play'];
  readonly events = new Emitter<ScriptSystemEvents>();

  private instances = new Map<EntityId, Instance>();
  private time: ScriptTime = { dt: 0, elapsed: 0, frame: 0 };

  update(dt: number, engine: Engine): void {
    this.time.dt = dt;
    this.time.elapsed += dt;
    this.time.frame += 1;

    const live = new Set<EntityId>();

    for (const entity of engine.scene.all()) {
      const script = entity.components.find((c): c is ScriptComponent => c.type === 'Script');
      if (!script) continue;

      const existing = this.instances.get(entity.id);
      if (existing && (existing.source !== script.source || existing.props !== script.props)) {
        this.destroyInstance(existing);
        this.instances.delete(entity.id);
      }
      if (!script.enabled) {
        const stale = this.instances.get(entity.id);
        if (stale) {
          this.destroyInstance(stale);
          this.instances.delete(entity.id);
        }
        continue;
      }

      live.add(entity.id);
      const instance = this.instances.get(entity.id) ?? this.createInstance(engine, entity.id, script);
      if (!instance || instance.failed) continue;

      if (!instance.started) {
        instance.started = true;
        if (!this.call(instance, 'start', () => instance.hooks.start?.())) continue;
      }
      if (!instance.hooks.update) continue;

      const began = performance.now();
      this.call(instance, 'update', () => instance.hooks.update?.(dt));
      const spent = performance.now() - began;
      if (spent > SLOW_UPDATE_MS && !instance.slowWarned) {
        instance.slowWarned = true;
        this.emit('warn', instance, `update took ${spent.toFixed(1)} ms this frame`);
      }
    }

    // Entities deleted, or Script components removed, since the last frame.
    for (const [id, instance] of [...this.instances]) {
      if (live.has(id)) continue;
      this.destroyInstance(instance);
      this.instances.delete(id);
    }
  }

  /** Called by the Engine on every mode change, so a play session always starts clean. */
  reset(): void {
    for (const instance of this.instances.values()) this.destroyInstance(instance);
    this.instances.clear();
    this.time = { dt: 0, elapsed: 0, frame: 0 };
  }

  dispose(): void {
    this.reset();
    this.events.clear();
  }

  /** Diagnostics for the editor: how many script instances are live right now. */
  get instanceCount(): number {
    return this.instances.size;
  }

  // ---------------------------------------------------------------- internal

  private createInstance(
    engine: Engine,
    entityId: EntityId,
    script: ScriptComponent,
  ): Instance | null {
    const compiled = compileScript(script.source);
    const scriptName = script.name || 'Script';

    const instance: Instance = {
      entityId,
      scriptName,
      source: script.source,
      props: script.props,
      hooks: {},
      context: {
        entity: new EntityHandle(engine, entityId),
        scene: new ScriptWorld(engine),
        input: engine.input,
        time: this.time,
        props: script.props,
        game: new ScriptGame(engine),
        hardware: new ScriptHardware(engine),
        console: {
          log: (...args) => this.emit('log', instance, format(args)),
          warn: (...args) => this.emit('warn', instance, format(args)),
          error: (...args) => this.emit('error', instance, format(args)),
        },
      },
      started: false,
      failed: false,
      slowWarned: false,
    };
    this.instances.set(entityId, instance);

    if (!compiled.ok) {
      instance.failed = true;
      this.emit('error', instance, compiled.error);
      return instance;
    }

    try {
      instance.hooks = compiled.factory(instance.context);
    } catch (error) {
      instance.failed = true;
      this.emit('error', instance, describeError(error));
    }
    return instance;
  }

  private destroyInstance(instance: Instance): void {
    if (instance.failed || !instance.started) return;
    this.call(instance, 'destroy', () => instance.hooks.destroy?.());
  }

  /** Runs one hook. Returns false if it threw, in which case the instance is parked. */
  private call(instance: Instance, hook: string, run: () => void): boolean {
    try {
      run();
      return true;
    } catch (error) {
      instance.failed = true;
      this.emit('error', instance, `${hook}(): ${describeError(error)}`);
      return false;
    }
  }

  private emit(level: ScriptMessage['level'], instance: Instance, text: string): void {
    this.events.emit('message', {
      level,
      text,
      entityId: instance.entityId,
      source: instance.scriptName,
      at: this.time.elapsed,
    });
  }
}

function format(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return arg.message;
      try {
        return JSON.stringify(arg) ?? String(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}
