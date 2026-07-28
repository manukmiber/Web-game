import { DEFAULT_PHYSICS_SETTINGS } from '../components/Physics';
import { scriptIdOf, type ScriptComponent, type ScriptPropValue } from '../components/Script';
import { Emitter } from '../core/Emitter';
import type { Engine, EngineMode, System } from '../loop/Engine';
import type { PhysicsSystem } from '../physics/PhysicsSystem';
import type { ContactEvent } from '../physics/PhysicsWorld';
import type { EntityId } from '../scene/types';
import {
  EntityHandle,
  mathf,
  ScriptClock,
  ScriptGame,
  ScriptHardware,
  ScriptPhysics,
  ScriptWorld,
  type ScriptCharacterAccess,
  type ScriptEnv,
  type ScriptMessenger,
  type TimeSource,
} from './ScriptApi';
import {
  compileScript,
  describeError,
  type ScriptCollision,
  type ScriptContext,
  type ScriptHooks,
} from './sandbox';

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

/** What the ScriptSystem needs from its neighbours. All optional; all degrade to nothing. */
export interface ScriptSystemOptions {
  /**
   * The physics system, so `fixedUpdate` fires exactly as often as the solver steps.
   *
   * A private accumulator here would drift against the solver's — same period, different
   * phase — and `fixedUpdate` would sometimes run twice between two steps and sometimes not at
   * all. Asking the system that actually stepped is the only way the two agree.
   */
  physics?: PhysicsSystem | null;
  /** The character controller, so `entity.grounded` and `entity.jump()` work on a character. */
  characters?: ScriptCharacterAccess | null;
}

interface Instance {
  key: string;
  entityId: EntityId;
  scriptId: string;
  scriptName: string;
  /** The source this instance was compiled from; a change recompiles it. */
  source: string;
  /** Identity of the props object, so a component swap rebuilds the closure over it. */
  props: Record<string, ScriptPropValue>;
  order: number;
  hooks: ScriptHooks;
  context: ScriptContext;
  clock: ScriptClock;
  started: boolean;
  /** Set after a throw. A failed script is not retried until its source changes. */
  failed: boolean;
  slowWarned: boolean;
}

/** A single script update above this is worth a one-time warning, in milliseconds. */
const SLOW_UPDATE_MS = 4;

/** How deep `scene.send` may recurse before it is treated as a loop. */
const MAX_MESSAGE_DEPTH = 8;

/**
 * Runs Script components in Play mode.
 *
 * Four rules shape it:
 *
 * 1. **One bad script must not take the frame down.** Every hook call is wrapped; a throw is
 *    reported once, the offending instance is parked, and every other script keeps running.
 *    The alternative — an exception escaping into `Engine.tick` — kills the loop, and with it
 *    the editor's viewport, for a typo in one of a hundred scripts.
 * 2. **Editing a script while it runs reloads it.** The source is compared every frame, and a
 *    changed one is destroyed and rebuilt. That is what makes the script editor usable at all:
 *    tweak, watch, tweak again, without leaving Play mode.
 * 3. **Nothing survives Play mode.** Instances, timers and pending contacts are dropped on
 *    stop, matching the scene snapshot restore — see ARCHITECTURE.md §6.
 * 4. **An entity may carry several scripts, and their order is defined.** Instances are keyed
 *    by entity *and* script id rather than by entity, and the frame runs them sorted by the
 *    `order` field. Without a defined order, a camera script and the movement script it
 *    follows would swap places depending on which component happened to be added first.
 *
 * What it cannot do is stop an infinite loop: a `while (true)` in a script hangs the tab, the
 * same way it would anywhere else on the main thread. Only moving scripts to a Worker fixes
 * that, and the note in `sandbox.ts` explains why that is the same change as real isolation.
 */
export class ScriptSystem implements System {
  readonly name = 'ScriptSystem';
  readonly runsIn: readonly EngineMode[] = ['play'];
  readonly events = new Emitter<ScriptSystemEvents>();

  private instances = new Map<string, Instance>();
  /** Instances in execution order, rebuilt whenever the set or an `order` field changes. */
  private ordered: Instance[] = [];
  private time: TimeSource = freshTime();
  private physics: PhysicsSystem | null;
  private characters: ScriptCharacterAccess | null;
  private env: ScriptEnv | null = null;
  /** Contacts the physics system reported this frame, waiting to be delivered. */
  private pendingContacts: { kind: 'enter' | 'stay'; event: ContactEvent }[] = [];
  private pendingExits: { a: EntityId; b: EntityId; trigger: boolean }[] = [];
  private unsubscribes: (() => void)[] = [];
  private messageDepth = 0;

  constructor(options: ScriptSystemOptions = {}) {
    this.physics = options.physics ?? null;
    this.characters = options.characters ?? null;
    this.subscribeToPhysics();
  }

  /**
   * Wires up the neighbours after construction.
   *
   * `installGameplaySystems` has to build all of them before it can hand any one to another,
   * so the dependency arrives here rather than through the constructor.
   */
  connect(options: ScriptSystemOptions): void {
    if (options.physics !== undefined) {
      this.physics = options.physics;
      this.subscribeToPhysics();
    }
    if (options.characters !== undefined) this.characters = options.characters;
    // The environment closes over both, so it has to be rebuilt.
    this.env = null;
  }

  update(dt: number, engine: Engine): void {
    this.time.dt = dt;
    this.time.elapsed += dt;
    this.time.frame += 1;

    const env = this.environment(engine);
    this.syncInstances(engine, env);

    // Contacts first. The physics system ran earlier in the frame (see `installGameplaySystems`
    // for why), so a script hears about a landing before its own `update` and can react in the
    // same frame rather than the next one.
    this.dispatchContacts();

    const steps = this.physics?.getDiagnostics().steps ?? 0;
    for (let step = 0; step < steps; step += 1) {
      for (const instance of this.ordered) {
        if (instance.failed || !instance.hooks.fixedUpdate) continue;
        this.call(instance, 'fixedUpdate', () => instance.hooks.fixedUpdate?.(this.time.fixedDt));
      }
    }

    for (const instance of this.ordered) {
      if (instance.failed) continue;
      if (!instance.started) {
        instance.started = true;
        if (!this.call(instance, 'start', () => instance.hooks.start?.())) continue;
      }
      if (!instance.hooks.update) continue;

      const began = now();
      this.call(instance, 'update', () => instance.hooks.update?.(dt));
      const spent = now() - began;
      if (spent > SLOW_UPDATE_MS && !instance.slowWarned) {
        instance.slowWarned = true;
        this.emit('warn', instance, `update took ${spent.toFixed(1)} ms this frame`);
      }
    }

    // Timers tick after `update`, so a callback scheduled this frame with `after(0)` runs on
    // the next one rather than immediately — which is what "after" has to mean to be useful.
    for (const instance of this.ordered) {
      if (instance.failed) continue;
      this.call(instance, 'timer', () => instance.clock.tick(dt));
    }

    for (const instance of this.ordered) {
      if (instance.failed || !instance.hooks.lateUpdate) continue;
      this.call(instance, 'lateUpdate', () => instance.hooks.lateUpdate?.(dt));
    }
  }

  /** Called by the Engine on every mode change, so a play session always starts clean. */
  reset(): void {
    for (const instance of this.instances.values()) this.destroyInstance(instance);
    this.instances.clear();
    this.ordered = [];
    this.pendingContacts = [];
    this.pendingExits = [];
    this.env = null;
    this.time = freshTime();
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    this.reset();
    this.events.clear();
  }

  /** Diagnostics for the editor: how many script instances are live right now. */
  get instanceCount(): number {
    return this.instances.size;
  }

  /** Timers waiting to fire across every instance. A runaway `every()` shows up here. */
  get timerCount(): number {
    let total = 0;
    for (const instance of this.instances.values()) total += instance.clock.pending;
    return total;
  }

  // ---------------------------------------------------------------- messaging

  /**
   * Delivers a message to every script on one entity, synchronously.
   *
   * Synchronous rather than queued, because the useful case is a request as much as a
   * notification — "you were hit, are you dead now" — and a queued reply arrives a frame late.
   * The depth guard is what makes that safe: two scripts that answer each other would otherwise
   * recurse until the stack gives out, and a blown stack in a script has to park the script,
   * not the editor.
   */
  private deliver(
    targetId: EntityId,
    name: string,
    payload: unknown,
    senderId: EntityId | null,
  ): number {
    if (this.messageDepth >= MAX_MESSAGE_DEPTH) return 0;
    this.messageDepth += 1;
    let delivered = 0;
    try {
      for (const instance of this.ordered) {
        if (instance.entityId !== targetId || instance.failed || !instance.hooks.onMessage) {
          continue;
        }
        this.call(instance, 'onMessage', () => instance.hooks.onMessage?.(name, payload, senderId));
        delivered += 1;
      }
    } finally {
      this.messageDepth -= 1;
    }
    return delivered;
  }

  // ---------------------------------------------------------------- internal

  private environment(engine: Engine): ScriptEnv {
    if (this.env && this.env.engine === engine) return this.env;
    const messenger: ScriptMessenger = {
      send: (targetId, name, payload) => this.deliver(targetId, name, payload, null),
      broadcast: (name, payload) => {
        let delivered = 0;
        for (const id of new Set(this.ordered.map((instance) => instance.entityId))) {
          delivered += this.deliver(id, name, payload, null);
        }
        return delivered;
      },
    };
    this.env = { engine, characters: this.characters, messenger };
    return this.env;
  }

  private subscribeToPhysics(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    const physics = this.physics;
    if (!physics) return;
    this.unsubscribes.push(
      physics.events.on('collisionEnter', (event) =>
        this.pendingContacts.push({ kind: 'enter', event }),
      ),
      physics.events.on('collisionStay', (event) =>
        this.pendingContacts.push({ kind: 'stay', event }),
      ),
      physics.events.on('collisionExit', (event) => this.pendingExits.push(event)),
    );
  }

  /**
   * Creates, reloads and destroys instances to match the scene, then re-sorts them.
   *
   * Keyed by `entityId:scriptId` rather than by entity: several scripts on one object each keep
   * their own compiled hooks, timers and error state, and deleting the first must not hand its
   * running instance to the second.
   */
  private syncInstances(engine: Engine, env: ScriptEnv): void {
    const live = new Set<string>();
    let structureChanged = false;

    for (const entity of engine.scene.all()) {
      const scripts = entity.components.filter((c): c is ScriptComponent => c.type === 'Script');
      for (const [index, script] of scripts.entries()) {
        const key = `${entity.id}:${scriptIdOf(script, entity.id, index)}`;

        const existing = this.instances.get(key);
        if (existing && (existing.source !== script.source || existing.props !== script.props)) {
          this.destroyInstance(existing);
          this.instances.delete(key);
          structureChanged = true;
        }

        if (!script.enabled) {
          const stale = this.instances.get(key);
          if (stale) {
            this.destroyInstance(stale);
            this.instances.delete(key);
            structureChanged = true;
          }
          continue;
        }

        live.add(key);
        const instance = this.instances.get(key);
        if (!instance) {
          this.createInstance(env, entity.id, key, script);
          structureChanged = true;
          continue;
        }
        if (instance.order !== (script.order ?? 0)) {
          instance.order = script.order ?? 0;
          structureChanged = true;
        }
        instance.scriptName = script.name || 'Script';
      }
    }

    // Entities deleted, or Script components removed, since the last frame.
    for (const [key, instance] of [...this.instances]) {
      if (live.has(key)) continue;
      this.destroyInstance(instance);
      this.instances.delete(key);
      structureChanged = true;
    }

    if (structureChanged) this.reorder();
  }

  /** Sorted by `order`; ties keep insertion order, which `Array.sort` guarantees. */
  private reorder(): void {
    this.ordered = [...this.instances.values()].sort((a, b) => a.order - b.order);
  }

  private createInstance(
    env: ScriptEnv,
    entityId: EntityId,
    key: string,
    script: ScriptComponent,
  ): Instance {
    const compiled = compileScript(script.source);
    const clock = new ScriptClock(this.time);

    const instance: Instance = {
      key,
      entityId,
      scriptId: key.slice(entityId.length + 1),
      scriptName: script.name || 'Script',
      source: script.source,
      props: script.props,
      order: script.order ?? 0,
      hooks: {},
      clock,
      context: {
        entity: new EntityHandle(env, entityId),
        scene: new ScriptWorld(env),
        input: env.engine.input,
        time: clock,
        props: script.props,
        game: new ScriptGame(env.engine),
        physics: new ScriptPhysics(env),
        hardware: new ScriptHardware(env.engine),
        mathf,
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
    this.instances.set(key, instance);

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
    instance.clock.clear();
    if (instance.failed || !instance.started) return;
    this.call(instance, 'destroy', () => instance.hooks.destroy?.());
  }

  /**
   * Hands this frame's contacts to the scripts on both sides.
   *
   * Both sides, each with the normal pointing away from them: a script should never have to
   * work out whether its entity happened to be `a` or `b` in the solver's pair ordering, which
   * is an implementation detail of a sort routine it cannot see.
   */
  private dispatchContacts(): void {
    if (this.pendingContacts.length === 0 && this.pendingExits.length === 0) return;

    const contacts = this.pendingContacts;
    const exits = this.pendingExits;
    this.pendingContacts = [];
    this.pendingExits = [];

    for (const { kind, event } of contacts) {
      if (event.trigger) {
        // Only the entering edge is reported for triggers. "Still inside the trigger" is a
        // question a script can answer with an overlap query, and firing it every frame turns
        // every checkpoint into sixty events a second.
        if (kind !== 'enter') continue;
        this.toHooks(event.a, 'onTriggerEnter', collisionFor(event, false));
        this.toHooks(event.b, 'onTriggerEnter', collisionFor(event, true));
        continue;
      }
      const hook = kind === 'enter' ? 'onCollisionEnter' : 'onCollisionStay';
      this.toHooks(event.a, hook, collisionFor(event, false));
      this.toHooks(event.b, hook, collisionFor(event, true));
    }

    for (const exit of exits) {
      const hook = exit.trigger ? 'onTriggerExit' : 'onCollisionExit';
      this.toExitHooks(exit.a, hook, exit.b);
      this.toExitHooks(exit.b, hook, exit.a);
    }
  }

  private toHooks(
    entityId: EntityId,
    hook: 'onCollisionEnter' | 'onCollisionStay' | 'onTriggerEnter',
    collision: ScriptCollision,
  ): void {
    for (const instance of this.ordered) {
      if (instance.entityId !== entityId || instance.failed) continue;
      const fn = instance.hooks[hook];
      if (!fn) continue;
      this.call(instance, hook, () => fn(collision));
    }
  }

  private toExitHooks(
    entityId: EntityId,
    hook: 'onCollisionExit' | 'onTriggerExit',
    otherId: EntityId,
  ): void {
    for (const instance of this.ordered) {
      if (instance.entityId !== entityId || instance.failed) continue;
      const fn = instance.hooks[hook];
      if (!fn) continue;
      this.call(instance, hook, () => fn(otherId));
    }
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

function freshTime(): TimeSource {
  return { dt: 0, elapsed: 0, frame: 0, fixedDt: DEFAULT_PHYSICS_SETTINGS.fixedTimestep };
}

/** The contact as the entity on one side of it experiences it. */
function collisionFor(event: ContactEvent, flipped: boolean): ScriptCollision {
  return {
    otherId: flipped ? event.a : event.b,
    normal: flipped
      ? [-event.normal[0], -event.normal[1], -event.normal[2]]
      : [event.normal[0], event.normal[1], event.normal[2]],
    point: [event.point[0], event.point[1], event.point[2]],
    depth: event.depth,
    impactSpeed: event.impactSpeed,
  };
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

/** `performance` is absent in some hosts the engine is meant to run in; `Date` never is. */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
