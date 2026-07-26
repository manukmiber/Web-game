import { Emitter } from '../core/Emitter';
import type { EntityId } from '../scene/types';

export interface ActorState {
  id: EntityId;
  faction: string;
  health: number;
  maxHealth: number;
  alive: boolean;
}

export interface GameStateEvents {
  damaged: { id: EntityId; amount: number; health: number; sourceId: EntityId | null };
  healed: { id: EntityId; amount: number; health: number };
  died: { id: EntityId; sourceId: EntityId | null };
  /** Fired when the whole registry is dropped — entering or leaving Play mode. */
  reset: Record<string, never>;
}

/**
 * Runtime gameplay state: who is alive, how hurt they are, and a scratch pad scripts can share.
 *
 * Kept out of the scene data on purpose. ARCHITECTURE.md §6 says leaving Play mode restores
 * the scene exactly as it was, so anything a play session mutates has to live somewhere the
 * snapshot does not cover — otherwise the restore is a lie, and the first symptom is a scene
 * file that quietly remembers a zombie was at 12 health when you last pressed stop.
 *
 * It also gives the NpcSystem, the CharacterSystem and user scripts one place to agree on
 * damage, rather than three private health maps that drift apart.
 */
export class GameState {
  readonly events = new Emitter<GameStateEvents>();

  private actors = new Map<EntityId, ActorState>();
  /** Free-form shared variables for scripts: score, wave number, whether the gate is open. */
  private vars = new Map<string, unknown>();

  register(id: EntityId, faction: string, maxHealth: number): ActorState {
    const existing = this.actors.get(id);
    if (existing) {
      existing.faction = faction;
      existing.maxHealth = maxHealth;
      return existing;
    }
    const actor: ActorState = { id, faction, health: maxHealth, maxHealth, alive: true };
    this.actors.set(id, actor);
    return actor;
  }

  unregister(id: EntityId): void {
    this.actors.delete(id);
  }

  get(id: EntityId): ActorState | undefined {
    return this.actors.get(id);
  }

  list(): ActorState[] {
    return [...this.actors.values()];
  }

  isAlive(id: EntityId): boolean {
    return this.actors.get(id)?.alive ?? false;
  }

  /**
   * Applies damage and reports it. Returns the health left, or -1 for an unregistered entity.
   *
   * `died` fires exactly once per actor: the alive flag is cleared before the event, so a
   * listener that damages something else in response cannot re-enter and kill it twice.
   */
  damage(id: EntityId, amount: number, sourceId: EntityId | null = null): number {
    const actor = this.actors.get(id);
    if (!actor || !actor.alive || amount <= 0) return actor?.health ?? -1;
    actor.health = Math.max(0, actor.health - amount);
    this.events.emit('damaged', { id, amount, health: actor.health, sourceId });
    if (actor.health === 0) {
      actor.alive = false;
      this.events.emit('died', { id, sourceId });
    }
    return actor.health;
  }

  heal(id: EntityId, amount: number): number {
    const actor = this.actors.get(id);
    if (!actor || !actor.alive || amount <= 0) return actor?.health ?? -1;
    actor.health = Math.min(actor.maxHealth, actor.health + amount);
    this.events.emit('healed', { id, amount, health: actor.health });
    return actor.health;
  }

  // ------------------------------------------------------------- script vars

  getVar<T = unknown>(key: string, fallback?: T): T {
    return this.vars.has(key) ? (this.vars.get(key) as T) : (fallback as T);
  }

  setVar(key: string, value: unknown): void {
    this.vars.set(key, value);
  }

  reset(): void {
    this.actors.clear();
    this.vars.clear();
    this.events.emit('reset', {});
  }
}
