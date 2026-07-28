import { forwardFromYaw, yawTowards } from '../ai/steering';
import type { AudioBus, MusicOptions, PlayOptions } from '../audio/AudioEngine';
import { DEFAULT_PHYSICS_SETTINGS } from '../components/Physics';
import { getComponentDefinition } from '../components/registry';
import type { Engine } from '../loop/Engine';
import { findPhysics } from '../physics/PhysicsSystem';
import type { QueryOptions } from '../physics/PhysicsWorld';
import { createPrimitiveEntity, type PrimitiveKind } from '../scene/primitives';
import type { Component, EntityId, Vec3 } from '../scene/types';

/**
 * The objects a script sees. Everything here is a thin, id-based view over the Scene rather
 * than a copy: a handle survives its entity being deleted (it just stops doing anything), and
 * nothing a script holds can pin an entity in memory after the scene drops it.
 */

/** What the character controller can tell a script about a character it owns. */
export interface ScriptCharacterAccess {
  isGrounded(id: EntityId): boolean;
  verticalVelocity(id: EntityId): number;
  setVerticalVelocity(id: EntityId, value: number): void;
}

/** How one script reaches another. Implemented by the ScriptSystem, which owns the mailboxes. */
export interface ScriptMessenger {
  /** Returns how many `onMessage` hooks received it. */
  send(targetId: EntityId, name: string, payload?: unknown): number;
  broadcast(name: string, payload?: unknown): number;
}

/**
 * Everything the script API needs that is not the Engine itself.
 *
 * Bundled rather than passed as three arguments because every handle needs all of it, and
 * `new EntityHandle(engine, characters, messenger, id)` is a signature nobody can read.
 */
export interface ScriptEnv {
  engine: Engine;
  characters: ScriptCharacterAccess | null;
  messenger: ScriptMessenger;
}

/**
 * Live view of one transform channel, so `entity.position.y += 1` works.
 *
 * Writes mark the entity dirty rather than emitting immediately — a hundred agents writing x,
 * y and z would otherwise be three hundred events a frame. Scene.flushTransforms sends one per
 * entity at the end of the tick.
 */
export class Vec3View {
  constructor(
    private readonly engine: Engine,
    private readonly id: EntityId,
    private readonly channel: 'position' | 'rotation' | 'scale',
  ) {}

  private vec(): Vec3 {
    const entity = this.engine.scene.get(this.id);
    // A detached scratch vector for a dead entity: writes go nowhere, reads give zeroes,
    // and the script does not need a null check on every line.
    return entity ? entity.transform[this.channel] : [0, 0, 0];
  }

  private touch(): void {
    this.engine.scene.markTransformDirty(this.id);
  }

  get x(): number {
    return this.vec()[0];
  }
  set x(value: number) {
    this.vec()[0] = value;
    this.touch();
  }

  get y(): number {
    return this.vec()[1];
  }
  set y(value: number) {
    this.vec()[1] = value;
    this.touch();
  }

  get z(): number {
    return this.vec()[2];
  }
  set z(value: number) {
    this.vec()[2] = value;
    this.touch();
  }

  set(x: number, y: number, z: number): void {
    const v = this.vec();
    v[0] = x;
    v[1] = y;
    v[2] = z;
    this.touch();
  }

  add(x: number, y: number, z: number): void {
    const v = this.vec();
    v[0] += x;
    v[1] += y;
    v[2] += z;
    this.touch();
  }

  toArray(): Vec3 {
    return [...this.vec()];
  }

  toString(): string {
    const v = this.vec();
    return `(${v[0].toFixed(2)}, ${v[1].toFixed(2)}, ${v[2].toFixed(2)})`;
  }
}

/**
 * A script's view of one rigid body.
 *
 * Reached through `entity.body`, and null when the entity has no simulated body — which is the
 * honest answer, and better than a handle whose every method silently does nothing.
 */
export class BodyHandle {
  constructor(
    private readonly engine: Engine,
    readonly id: EntityId,
  ) {}

  private body() {
    return this.engine.physics.get(this.id);
  }

  get exists(): boolean {
    return this.engine.physics.has(this.id);
  }

  get velocity(): Vec3 {
    return [...(this.body()?.velocity ?? [0, 0, 0])];
  }

  set velocity(value: Vec3) {
    this.engine.physics.setVelocity(this.id, value);
  }

  get speed(): number {
    const v = this.body()?.velocity ?? [0, 0, 0];
    return Math.hypot(v[0], v[1], v[2]);
  }

  /** True while the solver has parked this body. Any impulse wakes it. */
  get sleeping(): boolean {
    return this.body()?.sleeping ?? false;
  }

  /** Standing on something, as decided by the contacts the solver already resolved. */
  get grounded(): boolean {
    return this.body()?.grounded ?? false;
  }

  /** What it is standing on, if anything. */
  get groundId(): EntityId | null {
    return this.body()?.groundId ?? null;
  }

  get mass(): number {
    const invMass = this.body()?.invMass ?? 0;
    return invMass > 0 ? 1 / invMass : 0;
  }

  /** An instantaneous change in momentum — a jump, an explosion, a bat. */
  impulse(x: number, y: number, z: number): void {
    this.engine.physics.applyImpulse(this.id, [x, y, z]);
  }

  /** A continuous force applied for one physics step — wind, thrust, a conveyor belt. */
  force(x: number, y: number, z: number): void {
    this.engine.physics.applyForce(this.id, [x, y, z], DEFAULT_PHYSICS_SETTINGS.fixedTimestep);
  }

  /** Moves the body without simulating the trip. Velocity is kept; contacts re-evaluate. */
  teleport(x: number, y: number, z: number): void {
    this.engine.physics.setPosition(this.id, [x, y, z]);
  }

  wake(): void {
    const body = this.body();
    if (body) this.engine.physics.wake(body);
  }
}

/** Everything a script can do to one entity. */
export class EntityHandle {
  readonly position: Vec3View;
  readonly rotation: Vec3View;
  readonly scale: Vec3View;

  private readonly engine: Engine;

  constructor(
    private readonly env: ScriptEnv,
    readonly id: EntityId,
  ) {
    this.engine = env.engine;
    this.position = new Vec3View(this.engine, id, 'position');
    this.rotation = new Vec3View(this.engine, id, 'rotation');
    this.scale = new Vec3View(this.engine, id, 'scale');
  }

  get exists(): boolean {
    return this.engine.scene.has(this.id);
  }

  get name(): string {
    return this.engine.scene.get(this.id)?.name ?? '';
  }

  set name(value: string) {
    if (this.exists) this.engine.scene.rename(this.id, value);
  }

  /** The raw component object. Mutating it is the intended way to change one from a script. */
  component<T extends Component = Component>(type: string): T | null {
    return (this.engine.scene.getComponent<T>(this.id, type) ?? null) as T | null;
  }

  /** Every component of a type — this entity's Scripts, for instance. */
  components<T extends Component = Component>(type: string): T[] {
    return this.engine.scene.getComponents<T>(this.id, type);
  }

  has(type: string): boolean {
    return this.component(type) !== null;
  }

  /**
   * Adds a component by registry type, with optional overrides — `addComponent('NpcAgent',
   * { archetype: 'Zombie' })`.
   *
   * Goes through the same registry the Inspector's "Add Component" menu uses, so a script can
   * build anything the editor can and defaults stay in one place. Returns the existing
   * component when the entity already has one and the type is single-instance; a type that
   * allows several — `Script` — always adds another.
   */
  addComponent<T extends Component = Component>(
    type: string,
    overrides: Partial<T> = {},
  ): T | null {
    if (!this.exists) return null;
    const definition = getComponentDefinition(type);
    if (!definition) return null;
    if (!definition.allowMultiple) {
      const existing = this.component<T>(type);
      if (existing) return existing;
    }
    const component = definition.create(overrides) as T;
    this.engine.scene.addComponent(this.id, component);
    return component;
  }

  removeComponent(type: string): boolean {
    if (!this.exists) return false;
    return this.engine.scene.removeComponent(this.id, type) !== undefined;
  }

  parent(): EntityHandle | null {
    const parentId = this.engine.scene.get(this.id)?.parentId ?? null;
    return parentId ? new EntityHandle(this.env, parentId) : null;
  }

  children(): EntityHandle[] {
    return this.engine.scene
      .childrenOf(this.id)
      .map((childId) => new EntityHandle(this.env, childId));
  }

  /** Unit forward vector, following the engine's -Z convention. */
  forward(): Vec3 {
    const [x, z] = forwardFromYaw(this.rotation.y);
    return [x, 0, z];
  }

  /** Turns to face a world point, instantly. Yaw only — agents don't pitch. */
  lookAt(x: number, z: number): void {
    const p = this.position;
    this.rotation.y = yawTowards(x - p.x, z - p.z);
  }

  moveForward(distance: number): void {
    const [fx, fz] = forwardFromYaw(this.rotation.y);
    this.position.add(fx * distance, 0, fz * distance);
  }

  distanceTo(other: EntityHandle | Vec3): number {
    const p = this.position;
    const target = Array.isArray(other) ? other : other.position.toArray();
    return Math.hypot(p.x - target[0], p.y - target[1], p.z - target[2]);
  }

  /** Ground-plane distance — usually what a gameplay check actually wants. */
  distanceXZTo(other: EntityHandle | Vec3): number {
    const p = this.position;
    const target = Array.isArray(other) ? other : other.position.toArray();
    return Math.hypot(p.x - target[0], p.z - target[2]);
  }

  // ------------------------------------------------------------------ physics

  /** The rigid body on this entity, or null when nothing is simulating it. */
  get body(): BodyHandle | null {
    return this.engine.physics.has(this.id) ? new BodyHandle(this.engine, this.id) : null;
  }

  /**
   * Standing on something.
   *
   * Answers for both kinds of mover: a rigid body reports what the solver's contacts found, and
   * a character controller reports what its own depenetration pass found. A script asking "can
   * I jump" should not have to know which one it is attached to.
   *
   * It is the state of the **last completed step**, not of this instant. Scripts run before the
   * character controller moves (see `installGameplaySystems`), so a script that has just pushed
   * a character into the air still reads `grounded` as true until the next frame — the same
   * one-frame contract Unity's `isGrounded` has, and for the same reason.
   */
  get grounded(): boolean {
    if (this.env.characters?.isGrounded(this.id)) return true;
    return this.engine.physics.get(this.id)?.grounded ?? false;
  }

  /** Launches a character controller upward; falls through to an impulse on a rigid body. */
  jump(speed: number): void {
    if (this.env.characters && this.has('CharacterController')) {
      this.env.characters.setVerticalVelocity(this.id, speed);
      return;
    }
    const body = this.body;
    if (body) body.impulse(0, speed * (body.mass || 1), 0);
  }

  // ----------------------------------------------------------------- messages

  /** Delivers `onMessage(name, payload, senderId)` to every script on this entity. */
  send(name: string, payload?: unknown): number {
    return this.env.messenger.send(this.id, name, payload);
  }

  // ---------------------------------------------------------------- gameplay

  get health(): number {
    return this.engine.game.get(this.id)?.health ?? 0;
  }

  get alive(): boolean {
    return this.engine.game.isAlive(this.id);
  }

  damage(amount: number, sourceId: EntityId | null = null): number {
    return this.engine.game.damage(this.id, amount, sourceId);
  }

  heal(amount: number): number {
    return this.engine.game.heal(this.id, amount);
  }

  // ------------------------------------------------------------------- audio

  /** A one-shot sound at this entity's current position — a hit, a footstep, a pickup chime. */
  playSound(clip: string, options: Omit<PlayOptions, 'position'> = {}): void {
    this.engine.audio.play(clip, { ...options, position: this.position.toArray() });
  }

  destroy(): void {
    if (this.exists) this.engine.scene.remove(this.id);
  }

  toString(): string {
    return `<${this.name || this.id}>`;
  }
}

export interface SpawnOptions {
  name?: string;
  position?: Vec3;
  color?: string;
  parentId?: EntityId | null;
}

/** Scene-level queries and spawning, exposed to scripts as `scene`. */
export class ScriptWorld {
  private readonly engine: Engine;

  constructor(private readonly env: ScriptEnv) {
    this.engine = env.engine;
  }

  get count(): number {
    return this.engine.scene.size;
  }

  find(name: string): EntityHandle | null {
    const entity = this.engine.scene.all().find((e) => e.name === name);
    return entity ? new EntityHandle(this.env, entity.id) : null;
  }

  findAll(name: string): EntityHandle[] {
    return this.engine.scene
      .all()
      .filter((e) => e.name === name)
      .map((e) => new EntityHandle(this.env, e.id));
  }

  byId(id: EntityId): EntityHandle | null {
    return this.engine.scene.has(id) ? new EntityHandle(this.env, id) : null;
  }

  withComponent(type: string): EntityHandle[] {
    return this.engine.scene
      .all()
      .filter((e) => e.components.some((c) => c.type === type))
      .map((e) => new EntityHandle(this.env, e.id));
  }

  /** Nearest entity carrying `type`, excluding `from` itself. Ground-plane distance. */
  nearest(from: EntityHandle, type: string, maxDistance = Infinity): EntityHandle | null {
    let best: EntityHandle | null = null;
    let bestDistance = maxDistance;
    for (const candidate of this.withComponent(type)) {
      if (candidate.id === from.id) continue;
      const distance = from.distanceXZTo(candidate);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  /**
   * Creates a primitive at runtime — spawners, projectiles, dropped loot.
   *
   * Entities spawned in Play mode vanish on stop along with everything else the session did,
   * because the snapshot taken on entering play is restored wholesale (§6).
   */
  spawn(kind: PrimitiveKind, options: SpawnOptions = {}): EntityHandle {
    const entity = createPrimitiveEntity(kind, {
      name: options.name ?? kind,
      position: options.position ?? [0, 0, 0],
      parentId: options.parentId ?? null,
      ...(options.color ? { color: options.color } : {}),
    });
    this.engine.scene.add(entity);
    return new EntityHandle(this.env, entity.id);
  }

  /**
   * Delivers a message to every script on one entity.
   *
   * This is the seam that makes several scripts on one object useful rather than merely
   * possible: a health behaviour can announce `died` without knowing that a loot-drop behaviour
   * and a sound behaviour are listening, and either can be deleted without touching the other.
   */
  send(target: EntityHandle | EntityId, name: string, payload?: unknown): number {
    return this.env.messenger.send(idOf(target), name, payload);
  }

  /** Delivers to every script in the scene. The wave-started, game-over kind of event. */
  broadcast(name: string, payload?: unknown): number {
    return this.env.messenger.broadcast(name, payload);
  }
}

export interface ScriptRayHit {
  entity: EntityHandle;
  entityId: EntityId;
  distance: number;
  point: Vec3;
  normal: Vec3;
}

/**
 * The physics world, exposed to scripts as `physics`.
 *
 * Every query here is safe in a scene with no colliders: casts miss, overlaps come back empty.
 * A script that shoots should work in a blank scene — it just should not hit anything.
 */
export class ScriptPhysics {
  private readonly engine: Engine;

  constructor(private readonly env: ScriptEnv) {
    this.engine = env.engine;
  }

  /** The scene's gravity vector, or the default when the scene has no Physics component. */
  get gravity(): Vec3 {
    return [...(findPhysics(this.engine.scene)?.gravity ?? DEFAULT_PHYSICS_SETTINGS.gravity)];
  }

  /** Bodies the solver is tracking. Useful as a "has anything got a collider yet" check. */
  get bodyCount(): number {
    return this.engine.physics.size;
  }

  /**
   * `'3D'` or `'2D'`.
   *
   * Exposed so a behaviour that is meaningful in only one of them can say so, but note how
   * little script code needs it: velocities, impulses and query directions are projected into
   * the plane by the world itself, so a script that shoves a body sideways works unchanged in
   * both. See `physics/dimension`.
   */
  get mode(): '2D' | '3D' {
    return this.engine.physics.getDimensionality().mode;
  }

  /** Which plane a 2D scene simulates in — `'XY'` for a side-scroller, `'XZ'` for top-down. */
  get plane(): 'XY' | 'XZ' {
    return this.engine.physics.getDimensionality().plane;
  }

  /**
   * Nearest thing along a ray.
   *
   * `options.ignore` is almost always the caster: a ray fired from inside a character's own
   * collider hits that collider at distance zero, every single time.
   */
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance = 1000,
    options: QueryOptions = {},
  ): ScriptRayHit | null {
    const hit = this.engine.physics.raycast(origin, direction, maxDistance, options);
    return hit ? this.toHit(hit) : null;
  }

  /** Everything along a ray, nearest first. */
  raycastAll(
    origin: Vec3,
    direction: Vec3,
    maxDistance = 1000,
    options: QueryOptions = {},
  ): ScriptRayHit[] {
    return this.engine.physics
      .raycastAll(origin, direction, maxDistance, options)
      .map((hit) => this.toHit(hit));
  }

  /** Everything inside a sphere — a blast radius, an aggro check, a pickup range. */
  overlapSphere(center: Vec3, radius: number, options: QueryOptions = {}): EntityHandle[] {
    return this.engine.physics
      .overlapSphere(center, radius, options)
      .map((id) => new EntityHandle(this.env, id));
  }

  /** Straight down from a point, for "what is under this" without owning a controller. */
  groundBelow(origin: Vec3, maxDistance = 100, options: QueryOptions = {}): ScriptRayHit | null {
    return this.raycast(origin, [0, -1, 0], maxDistance, options);
  }

  /**
   * Pushes every dynamic body near a point away from it, falling off with distance.
   *
   * Here rather than left to scripts because the falloff is the part that is easy to get wrong:
   * a linear one makes distant objects twitch, and an inverse-square one sends anything near
   * the centre into orbit. Linear in the remaining fraction of the radius is the shape that
   * reads as an explosion. Returns how many bodies were moved.
   */
  explode(center: Vec3, radius: number, strength: number, options: QueryOptions = {}): number {
    let affected = 0;
    for (const id of this.engine.physics.overlapSphere(center, radius, options)) {
      const body = this.engine.physics.get(id);
      if (!body || body.invMass === 0) continue;
      const dx = body.origin[0] - center[0];
      const dy = body.origin[1] - center[1];
      const dz = body.origin[2] - center[2];
      const distance = Math.hypot(dx, dy, dz);
      const falloff = radius > 0 ? Math.max(0, 1 - distance / radius) : 1;
      if (falloff <= 0) continue;
      if (distance > 1e-6) {
        const factor = (strength * falloff) / distance;
        this.engine.physics.applyImpulse(id, [dx * factor, dy * factor, dz * factor]);
      } else {
        // Standing exactly on the charge: straight up, rather than dividing by zero.
        this.engine.physics.applyImpulse(id, [0, strength * falloff, 0]);
      }
      affected += 1;
    }
    return affected;
  }

  private toHit(hit: {
    entityId: EntityId;
    distance: number;
    point: Vec3;
    normal: Vec3;
  }): ScriptRayHit {
    return {
      entity: new EntityHandle(this.env, hit.entityId),
      entityId: hit.entityId,
      distance: hit.distance,
      point: [...hit.point],
      normal: [...hit.normal],
    };
  }
}

/** Shared clock values, written once per tick by the ScriptSystem. */
export interface TimeSource {
  /** Seconds since the previous frame. */
  dt: number;
  /** Seconds since Play mode started. */
  elapsed: number;
  /** Frames since Play mode started. */
  frame: number;
  /** The physics step, for anything that needs to match `fixedUpdate`. */
  fixedDt: number;
}

interface Timer {
  id: number;
  remaining: number;
  /** Null for a one-shot; seconds for a repeat. */
  interval: number | null;
  run: () => void;
  cancelled: boolean;
}

/**
 * `time` — the clock, plus per-script timers.
 *
 * Timers exist because the obvious alternative does not: `setTimeout` is shadowed inside the
 * sandbox, deliberately, since a callback that outlives Play mode is a script mutating a scene
 * that is no longer running. These are owned by the script instance, ticked by the
 * ScriptSystem, and dropped with it — which is the behaviour people wanted from `setTimeout`
 * and would not have got.
 */
export class ScriptClock {
  private timers: Timer[] = [];
  private nextId = 1;

  constructor(private readonly source: TimeSource) {}

  get dt(): number {
    return this.source.dt;
  }

  get elapsed(): number {
    return this.source.elapsed;
  }

  get frame(): number {
    return this.source.frame;
  }

  get fixedDt(): number {
    return this.source.fixedDt;
  }

  /** Runs `run` once, `seconds` from now. Returns a handle for `cancel`. */
  after(seconds: number, run: () => void): number {
    return this.schedule(seconds, null, run);
  }

  /** Runs `run` every `seconds`, starting one interval from now. */
  every(seconds: number, run: () => void): number {
    return this.schedule(seconds, Math.max(1e-3, seconds), run);
  }

  cancel(handle: number): void {
    const timer = this.timers.find((t) => t.id === handle);
    if (timer) timer.cancelled = true;
  }

  get pending(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }

  /**
   * Advances every timer. Called by the ScriptSystem inside its error guard, so a throwing
   * callback parks the script rather than the frame.
   *
   * The due list is collected before anything runs: a callback that schedules another timer
   * must not have it fire in the same tick, or `every(0.001)` would spin forever inside one
   * frame rather than merely being a bad idea.
   */
  tick(dt: number): void {
    if (this.timers.length === 0) return;

    const due: Timer[] = [];
    for (const timer of this.timers) {
      if (timer.cancelled) continue;
      timer.remaining -= dt;
      if (timer.remaining <= 0) due.push(timer);
    }

    for (const timer of due) {
      if (timer.cancelled) continue;
      if (timer.interval === null) timer.cancelled = true;
      else timer.remaining += timer.interval;
      timer.run();
    }

    this.timers = this.timers.filter((t) => !t.cancelled);
  }

  /** Drops every timer. Called when the instance is destroyed. */
  clear(): void {
    this.timers = [];
  }

  private schedule(seconds: number, interval: number | null, run: () => void): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.push({ id, remaining: Math.max(0, seconds), interval, run, cancelled: false });
    return id;
  }
}

export interface ScriptConsole {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * `mathf` — the arithmetic every gameplay script writes, and nobody should write twice.
 *
 * A frozen plain object rather than a class: there is no state, and freezing it means one
 * script cannot redefine `lerp` for every other script that shares the module.
 */
export const mathf = Object.freeze({
  clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
  },
  clamp01(value: number): number {
    return value < 0 ? 0 : value > 1 ? 1 : value;
  },
  lerp(a: number, b: number, t: number): number {
    return a + (b - a) * mathf.clamp01(t);
  },
  /** Position of `value` between `a` and `b` — the inverse of `lerp`. */
  inverseLerp(a: number, b: number, value: number): number {
    return a === b ? 0 : mathf.clamp01((value - a) / (b - a));
  },
  /** Remaps a value from one range onto another. */
  remap(value: number, fromA: number, fromB: number, toA: number, toB: number): number {
    return mathf.lerp(toA, toB, mathf.inverseLerp(fromA, fromB, value));
  },
  /**
   * Frame-rate independent approach — the fix for the `x += (target - x) * 0.1` everyone
   * writes, which converges twice as fast at 120 fps as at 60 and so makes a camera feel
   * different on different machines.
   */
  damp(current: number, target: number, smoothing: number, dt: number): number {
    return target + (current - target) * Math.exp(-smoothing * dt);
  },
  /** Moves toward a target by at most `maxDelta`, stopping exactly on it. */
  moveTowards(current: number, target: number, maxDelta: number): number {
    const delta = target - current;
    if (Math.abs(delta) <= maxDelta) return target;
    return current + Math.sign(delta) * maxDelta;
  },
  smoothstep(edge0: number, edge1: number, value: number): number {
    const t = mathf.inverseLerp(edge0, edge1, value);
    return t * t * (3 - 2 * t);
  },
  /** Folds an angle in degrees into (-180, 180]. */
  wrapAngle(degrees: number): number {
    let angle = degrees % 360;
    if (angle > 180) angle -= 360;
    if (angle <= -180) angle += 360;
    return angle;
  },
  /** Shortest signed rotation from one angle to another, in degrees. */
  angleDelta(from: number, to: number): number {
    return mathf.wrapAngle(to - from);
  },
  /** Interpolates angles the short way round, so 350° to 10° goes forward rather than back. */
  lerpAngle(a: number, b: number, t: number): number {
    return mathf.wrapAngle(a + mathf.angleDelta(a, b) * mathf.clamp01(t));
  },
  random(min = 0, max = 1): number {
    return min + Math.random() * (max - min);
  },
  randomInt(min: number, max: number): number {
    return Math.floor(min + Math.random() * (max - min + 1));
  },
  /** A random unit vector in the XZ plane — the wander direction every spawner needs. */
  randomDirection(): Vec3 {
    const angle = Math.random() * Math.PI * 2;
    return [Math.cos(angle), 0, Math.sin(angle)];
  },
  distance(a: Vec3, b: Vec3): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  },
  /** Ground-plane distance, which is what most gameplay checks actually mean. */
  distanceXZ(a: Vec3, b: Vec3): number {
    return Math.hypot(a[0] - b[0], a[2] - b[2]);
  },
});

export type ScriptMath = typeof mathf;

/** Gameplay state, exposed to scripts as `game`. */
export class ScriptGame {
  constructor(private readonly engine: Engine) {}

  get(key: string, fallback?: unknown): unknown {
    return this.engine.game.getVar(key, fallback);
  }

  set(key: string, value: unknown): void {
    this.engine.game.setVar(key, value);
  }

  health(target: EntityHandle | EntityId): number {
    return this.engine.game.get(idOf(target))?.health ?? 0;
  }

  maxHealth(target: EntityHandle | EntityId): number {
    return this.engine.game.get(idOf(target))?.maxHealth ?? 0;
  }

  isAlive(target: EntityHandle | EntityId): boolean {
    return this.engine.game.isAlive(idOf(target));
  }

  damage(target: EntityHandle | EntityId, amount: number, source?: EntityHandle | EntityId): number {
    return this.engine.game.damage(idOf(target), amount, source ? idOf(source) : null);
  }

  heal(target: EntityHandle | EntityId, amount: number): number {
    return this.engine.game.heal(idOf(target), amount);
  }
}

function idOf(target: EntityHandle | EntityId): EntityId {
  return typeof target === 'string' ? target : target.id;
}

/**
 * Attached boards, exposed to scripts as `hardware`.
 *
 * Bindings on a `HardwareInput` component cover the common case — a button *is* a key, a stick
 * *is* an axis — and this is for everything they cannot express: a rotary encoder that means
 * "next weapon", a lamp that should blink twice when a wave starts, a rig that needs a command
 * this protocol does not model. Reads are frame-consistent (`Engine.tick` pumps once, before
 * any system runs) and writes are dropped when the value has not changed, so `write` in
 * `update` is not the mistake it looks like.
 *
 * Every method is safe with nothing plugged in: reads return 0 or false, writes return false.
 * A scene that uses hardware must still be playable without it, or the rig becomes a
 * requirement for opening the project.
 */
export class ScriptHardware {
  constructor(private readonly engine: Engine) {}

  /** True while at least one device has an open link. */
  get connected(): boolean {
    return this.engine.hardware.connected;
  }

  /** Ids of every attached device, for `hardware.write(id + ':D13', 1)`. */
  devices(): string[] {
    return this.engine.hardware.list().map((device) => device.id);
  }

  /** Exactly what the board sent: 512, not 0.5. */
  raw(channel: string): number {
    return this.engine.hardware.raw(channel);
  }

  /** 0..1 against the channel's assumed range — 10-bit for `A*`, 0/1 for everything else. */
  value(channel: string): number {
    return this.engine.hardware.value(channel);
  }

  isDown(channel: string): boolean {
    return this.engine.hardware.isDown(channel);
  }

  wasPressed(channel: string): boolean {
    return this.engine.hardware.wasPressed(channel);
  }

  wasReleased(channel: string): boolean {
    return this.engine.hardware.wasReleased(channel);
  }

  /** Returns false when nothing took it: no device, closed link, or the value is unchanged. */
  write(channel: string, value: number): boolean {
    return this.engine.hardware.write(channel, value);
  }

  /** A raw protocol line, for firmware commands the channel model does not cover. */
  send(line: string, deviceId?: string): boolean {
    return this.engine.hardware.send(line, deviceId);
  }

  /** Named analog axis, whether it came from a binding or from another script. */
  axis(name: string): number {
    return this.engine.input.getAxis(name);
  }
}

/**
 * Web Audio, exposed to scripts as `audio`.
 *
 * Every method is safe with nothing loaded and nothing plugged in — the same contract
 * `ScriptHardware` keeps: a scene played headless, or before a clip has finished decoding, just
 * plays no sound rather than throwing. `entity.playSound` covers the common "at this object's
 * position" case; this is for everything else — UI feedback with no entity behind it, and music.
 */
export class ScriptAudio {
  constructor(private readonly engine: Engine) {}

  /** A one-shot or looping sound. `options.position` makes it spatial; omit it for a 2D sound. */
  play(clip: string, options: PlayOptions = {}): void {
    this.engine.audio.play(clip, options);
  }

  /** Replaces whatever is on the music bus, crossfading over `options.fadeSeconds`. */
  music(clip: string, options: MusicOptions = {}): void {
    this.engine.audio.playMusic(clip, options);
  }

  stopMusic(fadeSeconds = 0): void {
    this.engine.audio.stopMusic(fadeSeconds);
  }

  /** Every playing sound, gone — a scene transition, a game-over screen. */
  stopAll(): void {
    this.engine.audio.stopAll();
  }

  busVolume(bus: AudioBus): number {
    return this.engine.audio.getBusVolume(bus);
  }

  setBusVolume(bus: AudioBus, volume: number): void {
    this.engine.audio.setBusVolume(bus, volume);
  }

  get masterVolume(): number {
    return this.engine.audio.getMasterVolume();
  }

  set masterVolume(value: number) {
    this.engine.audio.setMasterVolume(value);
  }

  get muted(): boolean {
    return this.engine.audio.isMuted();
  }

  set muted(value: boolean) {
    this.engine.audio.setMuted(value);
  }
}
