/**
 * A live index from component type to the entities carrying it.
 *
 * The scene has always been entity-plus-components; what it did not have was a way to *find*
 * things. Every system opened with `for (const entity of scene.all())` and a `components.find`,
 * which is O(entities x components) per system per frame — five systems over a 10 000-entity
 * scene walk the same 10 000 entities five times to reach the eleven that have a collider.
 *
 * This is the index that makes the question cheap. It maintains itself off the Scene's existing
 * events, so nothing has to remember to keep it in step, and it holds no component data of its
 * own: the entity objects stay the single source of truth and this is purely a lookup.
 *
 * Note it is a *type* index, not an archetype table. Real archetype ECS packs components of the
 * same shape into contiguous arrays, which buys cache locality on top of the lookup. That is a
 * rewrite of the data model — components would stop being plain objects on an entity and the
 * serializer, the Inspector and the undo stack all read them there. The lookup is where the
 * factor-of-a-thousand is; the packing is a constant factor, and ARCHITECTURE.md §16 says why
 * this engine takes the first and not the second.
 */

import type { Scene } from '../scene/Scene';
import type { EntityId } from '../scene/types';

export class ComponentIndex {
  /** type -> entities carrying at least one component of that type. */
  private byType = new Map<string, Set<EntityId>>();
  /** The reverse direction, so an entity can be un-indexed without scanning every type. */
  private byEntity = new Map<EntityId, Set<string>>();
  /**
   * Position in scene order, so a query result can be sorted back into it.
   *
   * The sets above are hash sets and iterate in insertion order, which is *not* scene order once
   * a component has been added to an old entity after a new one. Systems that write transforms
   * have to be deterministic across a save and reload, so the ordinal is what queries sort by.
   * Assigned once and kept across re-indexing: gaining a component does not move an entity.
   */
  private ordinals = new Map<EntityId, number>();
  private nextOrdinal = 0;
  /**
   * Bumped whenever the index's *shape* changes — an entity gained or lost a component type, or
   * appeared or disappeared. Query results are cached against it. Deliberately not bumped by a
   * field edit: changing a collider's radius cannot change which entities have a collider.
   */
  private revision = 0;
  private unsubscribes: (() => void)[] = [];

  constructor(private readonly scene: Scene) {
    this.rebuild();

    const { events } = scene;
    this.unsubscribes.push(
      events.on('entityAdded', ({ entity }) => this.reindex(entity.id)),
      events.on('entityRemoved', ({ removedIds }) => this.removeSubtree(removedIds)),
      // The event says an entity's components changed, not which — so that entity's row is
      // re-derived. One entity's worth of work, on an event that fires once per edit.
      events.on('componentsChanged', ({ id }) => this.reindex(id)),
      events.on('sceneReplaced', () => this.rebuild()),
    );
  }

  getRevision(): number {
    return this.revision;
  }

  /** Entities carrying `type`. The returned set is live — treat it as read-only. */
  entitiesWith(type: string): ReadonlySet<EntityId> {
    return this.byType.get(type) ?? EMPTY;
  }

  count(type: string): number {
    return this.byType.get(type)?.size ?? 0;
  }

  /** Scene-order position of an entity. Unknown ids sort last. */
  ordinalOf(id: EntityId): number {
    return this.ordinals.get(id) ?? Number.MAX_SAFE_INTEGER;
  }

  has(id: EntityId, type: string): boolean {
    return this.byType.get(type)?.has(id) ?? false;
  }

  /** Component types on an entity, deduplicated — a multi-Script entity lists `Script` once. */
  typesOf(id: EntityId): ReadonlySet<string> {
    return this.byEntity.get(id) ?? EMPTY_TYPES;
  }

  /** Every type present anywhere in the scene, with how many entities carry it. */
  census(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [type, ids] of this.byType) if (ids.size > 0) out.set(type, ids.size);
    return out;
  }

  dispose(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
    this.byType.clear();
    this.byEntity.clear();
    this.ordinals.clear();
    this.revision += 1;
  }

  // ---------------------------------------------------------------- internal

  private rebuild(): void {
    this.byType.clear();
    this.byEntity.clear();
    this.ordinals.clear();
    this.nextOrdinal = 0;
    // In scene order, so the ordinals a reloaded scene gets are the ones it had.
    for (const entity of this.scene.all()) this.index(entity.id);
    this.revision += 1;
  }

  /**
   * Re-derives one entity's row, bumping the revision only if the set of types actually changed.
   *
   * The comparison is what keeps cached queries alive across ordinary edits: dragging a slider
   * emits `componentsChanged` sixty times a second, and invalidating every query on each of them
   * would make the cache a pure cost.
   */
  private reindex(id: EntityId): void {
    const previous = this.byEntity.get(id);
    const entity = this.scene.get(id);
    if (!entity) {
      if (previous) this.unindex(id);
      return;
    }

    const next = new Set<string>();
    for (const component of entity.components) next.add(component.type);
    if (previous && sameSet(previous, next)) return;

    if (previous) this.unindex(id);
    if (!this.ordinals.has(id)) {
      this.ordinals.set(id, this.nextOrdinal);
      this.nextOrdinal += 1;
    }
    this.byEntity.set(id, next);
    for (const type of next) {
      let bucket = this.byType.get(type);
      if (!bucket) {
        bucket = new Set();
        this.byType.set(type, bucket);
      }
      bucket.add(id);
    }
    this.revision += 1;
  }

  private index(id: EntityId): void {
    const entity = this.scene.get(id);
    if (!entity) return;
    if (!this.ordinals.has(id)) {
      this.ordinals.set(id, this.nextOrdinal);
      this.nextOrdinal += 1;
    }
    const types = new Set<string>();
    for (const component of entity.components) types.add(component.type);
    this.byEntity.set(id, types);
    for (const type of types) {
      let bucket = this.byType.get(type);
      if (!bucket) {
        bucket = new Set();
        this.byType.set(type, bucket);
      }
      bucket.add(id);
    }
  }

  private unindex(id: EntityId): void {
    const types = this.byEntity.get(id);
    if (!types) return;
    for (const type of types) {
      const bucket = this.byType.get(type);
      if (!bucket) continue;
      bucket.delete(id);
      if (bucket.size === 0) this.byType.delete(type);
    }
    this.byEntity.delete(id);
  }

  /**
   * Drops a removed subtree.
   *
   * The Scene reports every id it removed, which is why `SceneEvents.entityRemoved` carries
   * `removedIds`: the children are already gone by the time this runs, so the alternative is
   * scanning our own keys for ids that no longer resolve — O(scene) on every delete.
   */
  private removeSubtree(ids: readonly EntityId[]): void {
    for (const id of ids) {
      this.unindex(id);
      this.ordinals.delete(id);
    }
    this.revision += 1;
  }
}

const EMPTY: ReadonlySet<EntityId> = new Set();
const EMPTY_TYPES: ReadonlySet<string> = new Set();

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
