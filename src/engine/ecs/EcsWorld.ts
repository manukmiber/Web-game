/**
 * The ECS view of the scene.
 *
 * Not a second data store — the Scene still owns every entity and every component, and this is a
 * façade over it: an index (`ComponentIndex`), a query cache, and the handful of accessors that
 * systems actually want. The reason it is a separate object rather than more methods on Scene is
 * ARCHITECTURE.md §2: the Scene is the serialisable data model and has to stay free of runtime
 * machinery, and a query cache that has to be invalidated is exactly that.
 *
 * The three shapes a system ever needs:
 *
 * ```ts
 * for (const entity of world.entities(COLLIDERS)) { ... }          // iterate
 * world.each(COLLIDERS, (entity, collider) => { ... }, 'Collider') // iterate with a component
 * const settings = world.firstComponent<PhysicsComponent>('Physics') // the scene-wide singleton
 * ```
 */

import type { Scene } from '../scene/Scene';
import type { Component, Entity, EntityId } from '../scene/types';
import { ComponentIndex } from './ComponentIndex';
import { queryKey, resolveQuery, entityMatches, type QueryDescriptor } from './Query';

interface CachedResult {
  revision: number;
  ids: EntityId[];
}

export class EcsWorld {
  readonly index: ComponentIndex;

  private cache = new Map<string, CachedResult>();

  constructor(readonly scene: Scene) {
    this.index = new ComponentIndex(scene);
  }

  /**
   * Ids matching a query, in scene order, cached until the index's shape changes.
   *
   * Sorted rather than left in the index's own order, which follows insertion into a hash set: a
   * system that writes transforms has to visit entities in the same order across a save and
   * reload, or a scene that depends on ordering (siblings resolving a tie, scripts of equal
   * `order`) changes behaviour for no visible reason. The sort is paid once per invalidation, not
   * per frame.
   *
   * The array is returned directly rather than copied, so callers must not mutate it. Copying
   * would undo most of what the cache buys: the whole point is that five systems asking the same
   * question in one frame allocate nothing.
   */
  ids(query: QueryDescriptor): readonly EntityId[] {
    const key = queryKey(query);
    const revision = this.index.getRevision();
    const cached = this.cache.get(key);
    if (cached && cached.revision === revision) return cached.ids;
    const ids = resolveQuery(this.index, query);
    ids.sort((a, b) => this.index.ordinalOf(a) - this.index.ordinalOf(b));
    this.cache.set(key, { revision, ids });
    return ids;
  }

  /** Matching entities, in scene order. Skips ids the scene has since dropped. */
  entities(query: QueryDescriptor): Entity[] {
    const out: Entity[] = [];
    for (const id of this.ids(query)) {
      const entity = this.scene.get(id);
      if (entity) out.push(entity);
    }
    return out;
  }

  /**
   * Runs `fn` for every match, handing over the component of `withType` when one is named.
   *
   * Resolving the component here rather than in the caller is what removes the
   * `components.find(c => c.type === 'Collider')` that used to open every system — and with it
   * the cast that always came next.
   */
  each<T extends Component = Component>(
    query: QueryDescriptor,
    fn: (entity: Entity, component: T) => void,
    withType?: string,
  ): void {
    const type = withType ?? query.all?.[0];
    for (const id of this.ids(query)) {
      const entity = this.scene.get(id);
      if (!entity) continue;
      const component = type
        ? (entity.components.find((c) => c.type === type) as T | undefined)
        : (undefined as T | undefined);
      // A query naming a type cannot match an entity without it, so a miss here means the index
      // is stale — skip rather than hand a system `undefined` it never checks for.
      if (type && !component) continue;
      fn(entity, component as T);
    }
  }

  /** Entities carrying `type`, the common single-term case, without building a descriptor. */
  with(type: string): Entity[] {
    return this.entities({ all: [type] });
  }

  /**
   * The first component of a type in scene order, and the entity carrying it.
   *
   * Scene-wide singletons — `Physics`, `Environment` — are components on an entity by deliberate
   * design (see `EnvironmentComponent`), and "the first one wins" is their resolution rule.
   * Ordering by the scene rather than by the index is what makes that rule stable: the index is
   * a hash set and its iteration order follows insertion, so a scene reload could otherwise pick
   * a different Physics component than the one before it.
   */
  first<T extends Component = Component>(type: string): { entity: Entity; component: T } | null {
    const ids = this.index.entitiesWith(type);
    if (ids.size === 0) return null;
    for (const entity of this.scene.all()) {
      if (!ids.has(entity.id)) continue;
      const component = entity.components.find((c) => c.type === type) as T | undefined;
      if (component) return { entity, component };
    }
    return null;
  }

  firstComponent<T extends Component = Component>(type: string): T | null {
    return this.first<T>(type)?.component ?? null;
  }

  /** Whether any entity carries `type`. O(1), unlike the scan it replaces. */
  any(type: string): boolean {
    return this.index.count(type) > 0;
  }

  count(type: string): number {
    return this.index.count(type);
  }

  matches(id: EntityId, query: QueryDescriptor): boolean {
    return entityMatches(this.index, id, query);
  }

  /** Component types present in the scene and how many entities carry each. */
  census(): Map<string, number> {
    return this.index.census();
  }

  dispose(): void {
    this.index.dispose();
    this.cache.clear();
  }
}
