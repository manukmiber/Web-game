import { forwardFromYaw, yawTowards } from '../ai/steering';
import { getComponentDefinition } from '../components/registry';
import type { Engine } from '../loop/Engine';
import { createPrimitiveEntity, type PrimitiveKind } from '../scene/primitives';
import type { Component, EntityId, Vec3 } from '../scene/types';

/**
 * The objects a script sees. Everything here is a thin, id-based view over the Scene rather
 * than a copy: a handle survives its entity being deleted (it just stops doing anything), and
 * nothing a script holds can pin an entity in memory after the scene drops it.
 */

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

/** Everything a script can do to one entity. */
export class EntityHandle {
  readonly position: Vec3View;
  readonly rotation: Vec3View;
  readonly scale: Vec3View;

  constructor(
    private readonly engine: Engine,
    readonly id: EntityId,
  ) {
    this.position = new Vec3View(engine, id, 'position');
    this.rotation = new Vec3View(engine, id, 'rotation');
    this.scale = new Vec3View(engine, id, 'scale');
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

  has(type: string): boolean {
    return this.component(type) !== null;
  }

  /**
   * Adds a component by registry type, with optional overrides — `addComponent('NpcAgent',
   * { archetype: 'Zombie' })`.
   *
   * Goes through the same registry the Inspector's "Add Component" menu uses, so a script can
   * build anything the editor can and defaults stay in one place. Returns the existing
   * component if the entity already has one of that type; components are one-per-type.
   */
  addComponent<T extends Component = Component>(
    type: string,
    overrides: Partial<T> = {},
  ): T | null {
    if (!this.exists) return null;
    const existing = this.component<T>(type);
    if (existing) return existing;
    const definition = getComponentDefinition(type);
    if (!definition) return null;
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
    return parentId ? new EntityHandle(this.engine, parentId) : null;
  }

  children(): EntityHandle[] {
    return this.engine.scene
      .childrenOf(this.id)
      .map((childId) => new EntityHandle(this.engine, childId));
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
  constructor(private readonly engine: Engine) {}

  get count(): number {
    return this.engine.scene.size;
  }

  find(name: string): EntityHandle | null {
    const entity = this.engine.scene.all().find((e) => e.name === name);
    return entity ? new EntityHandle(this.engine, entity.id) : null;
  }

  findAll(name: string): EntityHandle[] {
    return this.engine.scene
      .all()
      .filter((e) => e.name === name)
      .map((e) => new EntityHandle(this.engine, e.id));
  }

  byId(id: EntityId): EntityHandle | null {
    return this.engine.scene.has(id) ? new EntityHandle(this.engine, id) : null;
  }

  withComponent(type: string): EntityHandle[] {
    return this.engine.scene
      .all()
      .filter((e) => e.components.some((c) => c.type === type))
      .map((e) => new EntityHandle(this.engine, e.id));
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
    return new EntityHandle(this.engine, entity.id);
  }
}

/** Shared clock, replaced wholesale each tick by the ScriptSystem. */
export interface ScriptTime {
  /** Seconds since the previous frame. */
  dt: number;
  /** Seconds since Play mode started. */
  elapsed: number;
  /** Frames since Play mode started. */
  frame: number;
}

export interface ScriptConsole {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

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
