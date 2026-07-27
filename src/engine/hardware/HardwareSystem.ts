import type { HardwareInputComponent } from '../components/HardwareInput';
import type { HardwareOutputComponent } from '../components/HardwareOutput';
import { Emitter } from '../core/Emitter';
import type { Engine, EngineMode, System } from '../loop/Engine';
import type { EntityId } from '../scene/types';
import {
  normalizeInput,
  parseInputBindings,
  parseOutputBindings,
  shapeOutput,
  type InputBinding,
  type OutputBinding,
} from './bindings';

/** Compiled bindings, kept until the component's text changes. */
interface Compiled<T> {
  source: string;
  bindings: T[];
  errors: string[];
  /** Reported once per unique text, not once per frame. */
  reported: boolean;
}

export interface HardwareSystemEvents {
  /** A bad binding line, reported once per unique binding text rather than once per frame. */
  problem: { entityId: EntityId; text: string };
}

/**
 * Applies `HardwareInput` and `HardwareOutput` in Play mode.
 *
 * Inbound data is *not* read here — `Engine.tick` pumps the bus at the top of every frame, so
 * the device panel shows live values while the editor sits in edit mode and this system only
 * has to decide what the bindings mean. That split is deliberate: watching a channel move
 * while you calibrate it is an editing task, and pressing Play to see whether a pot is wired
 * up would be a miserable loop.
 *
 * Runs before the script, character and NPC systems (see `installGameplaySystems`), so a
 * physical button pressed between two frames is visible to everything in the *same* frame it
 * arrives — the same one-frame argument that orders scripts before movement.
 */
export class HardwareSystem implements System {
  readonly name = 'HardwareSystem';
  readonly runsIn: readonly EngineMode[] = ['play'];
  readonly events = new Emitter<HardwareSystemEvents>();

  private readonly inputs = new Map<EntityId, Compiled<InputBinding>>();
  private readonly outputs = new Map<EntityId, Compiled<OutputBinding>>();
  /** Smoothed axis values, keyed by entity + axis name. */
  private readonly smoothed = new Map<string, number>();
  /** Last write time per entity + channel, for the per-binding rate limit. */
  private readonly lastWrite = new Map<string, number>();
  /** Axes this system wrote last frame, so releasing a stick zeroes them rather than latching. */
  private ownedAxes = new Set<string>();
  /** Keys this system held down last frame, for the same reason. */
  private ownedKeys = new Set<string>();
  private elapsed = 0;
  /**
   * Channels written during the session, zeroed on stop when `resetOnStop` is set.
   *
   * The *resolved* reference is stored, not the component's device plus the binding's channel:
   * a binding that already names its board (`uno:D13`) on a component that also has one would
   * otherwise be rebuilt as `uno:uno:D13`, and the zeroing write would go nowhere.
   */
  private readonly touched = new Map<string, string>();

  update(dt: number, engine: Engine): void {
    this.elapsed += dt;
    const axes = new Set<string>();
    const keys = new Set<string>();

    for (const entity of engine.scene.all()) {
      for (const component of entity.components) {
        if (component.type === 'HardwareInput') {
          this.applyInput(engine, entity.id, component as HardwareInputComponent, axes, keys);
        } else if (component.type === 'HardwareOutput') {
          this.applyOutput(engine, entity.id, component as HardwareOutputComponent);
        }
      }
    }

    // An axis or key whose binding was removed, or whose device went away, must fall back to
    // released. Otherwise the last value a disconnected stick reported steers the character
    // forever, and a button that was down when the USB cable came out stays down.
    for (const axis of this.ownedAxes) if (!axes.has(axis)) engine.input.setAxis(axis, 0);
    for (const key of this.ownedKeys) if (!keys.has(key)) engine.input.setKey(key, false);
    this.ownedAxes = axes;
    this.ownedKeys = keys;
  }

  /**
   * Called on every mode change. Drops compiled bindings and smoothing, and — the part that
   * matters on a desk rather than in memory — zeroes the outputs a session lit up.
   */
  reset(engine: Engine): void {
    for (const reference of this.touched.values()) engine.hardware.write(reference, 0, true);
    this.touched.clear();
    for (const axis of this.ownedAxes) engine.input.setAxis(axis, 0);
    for (const key of this.ownedKeys) engine.input.setKey(key, false);
    this.ownedAxes = new Set();
    this.ownedKeys = new Set();
    this.inputs.clear();
    this.outputs.clear();
    this.smoothed.clear();
    this.lastWrite.clear();
    this.elapsed = 0;
  }

  dispose(): void {
    this.inputs.clear();
    this.outputs.clear();
    this.events.clear();
  }

  // ---------------------------------------------------------------- internal

  private applyInput(
    engine: Engine,
    entityId: EntityId,
    component: HardwareInputComponent,
    axes: Set<string>,
    keys: Set<string>,
  ): void {
    if (component.enabled === false) return;
    const compiled = this.compile(this.inputs, entityId, component.bindings ?? '', parseInputBindings);

    for (const binding of compiled.bindings) {
      const reference = qualify(binding.channel, component.device);
      const device = engine.hardware.resolve(reference);
      if (!device) continue;

      const raw = engine.hardware.raw(reference);
      const value = normalizeInput(raw, binding);

      if (binding.target.kind === 'key') {
        // A key from an analog channel needs a threshold; a digital one crosses 0.5 anyway.
        // `setKey` owns the edges, so held/pressed/released behave exactly as on a keyboard.
        engine.input.setKey(binding.target.key, Math.abs(value) >= binding.threshold);
        keys.add(binding.target.key);
        continue;
      }

      const name = binding.target.name;
      const smoothing = clamp(component.smoothing ?? 0, 0, 0.95);
      const key = `${entityId}:${name}`;
      const previous = this.smoothed.get(key) ?? 0;
      const next = smoothing > 0 ? previous + (value - previous) * (1 - smoothing) : value;
      this.smoothed.set(key, next);

      // Several bindings may drive one axis (two boards, or a stick plus a pedal); the largest
      // magnitude wins rather than the last one parsed, so order in the list does not matter.
      const current = axes.has(name) ? engine.input.getAxis(name) : 0;
      engine.input.setAxis(name, Math.abs(next) >= Math.abs(current) ? next : current);
      axes.add(name);
    }

    this.report(entityId, compiled);
  }

  private applyOutput(engine: Engine, entityId: EntityId, component: HardwareOutputComponent): void {
    if (component.enabled === false) return;
    const compiled = this.compile(
      this.outputs,
      entityId,
      component.bindings ?? '',
      parseOutputBindings,
    );

    for (const binding of compiled.bindings) {
      const key = `${entityId}:${binding.channel}`;
      const interval = 1 / binding.rateHz;
      const last = this.lastWrite.get(key) ?? -Infinity;
      if (this.elapsed - last < interval) continue;
      this.lastWrite.set(key, this.elapsed);

      const value = shapeOutput(this.readSource(engine, entityId, binding), binding);
      const reference = qualify(binding.channel, component.device);
      if (engine.hardware.write(reference, value) && component.resetOnStop !== false) {
        this.touched.set(key, reference);
      }
    }

    this.report(entityId, compiled);
  }

  private readSource(engine: Engine, entityId: EntityId, binding: OutputBinding): number {
    const source = binding.source;
    switch (source.kind) {
      case 'const':
        return source.value;
      case 'health':
        return engine.game.get(entityId)?.health ?? 0;
      case 'health01': {
        const record = engine.game.get(entityId);
        if (!record || record.maxHealth <= 0) return 0;
        return record.health / record.maxHealth;
      }
      case 'alive':
        return engine.game.isAlive(entityId) ? 1 : 0;
      case 'axis':
        return engine.input.getAxis(source.name);
      case 'var': {
        const value = engine.game.getVar(source.name);
        if (typeof value === 'number') return value;
        if (typeof value === 'boolean') return value ? 1 : 0;
        return 0;
      }
    }
  }

  private compile<T>(
    cache: Map<EntityId, Compiled<T>>,
    entityId: EntityId,
    source: string,
    parse: (text: string) => { bindings: T[]; errors: string[] },
  ): Compiled<T> {
    const existing = cache.get(entityId);
    if (existing && existing.source === source) return existing;

    const parsed = parse(source);
    const compiled: Compiled<T> = { source, ...parsed, reported: false };
    cache.set(entityId, compiled);
    return compiled;
  }

  /** Errors are collected once per unique binding text — not once per frame. */
  private report<T>(entityId: EntityId, compiled: Compiled<T>): void {
    if (compiled.reported || compiled.errors.length === 0) return;
    compiled.reported = true;
    for (const text of compiled.errors) this.events.emit('problem', { entityId, text });
  }
}

/** `A0` with a component-level device becomes `uno:A0`; an already-qualified reference wins. */
function qualify(channel: string, device: string | undefined): string {
  if (!device || channel.includes(':')) return channel;
  return `${device}:${channel}`;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
