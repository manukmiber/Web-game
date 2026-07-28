/**
 * Queries: "which entities have these components".
 *
 * A query is data, not a call — `{ all: ['Collider', 'RigidBody'] }` — for the same reason the
 * component field schemas are data: it can be declared once as a module constant, cached against
 * the index's revision, and read by whoever needs to know what a system touches. A system that
 * declares its query is a system whose inputs are inspectable.
 */

import type { EntityId } from '../scene/types';
import type { ComponentIndex } from './ComponentIndex';

export interface QueryDescriptor {
  /** Every one of these must be present. */
  all?: readonly string[];
  /** At least one of these must be present. Empty or absent means no constraint. */
  any?: readonly string[];
  /** None of these may be present. */
  none?: readonly string[];
}

/** Stable string form, so a query can key a cache without being interned by the caller. */
export function queryKey(query: QueryDescriptor): string {
  const part = (types: readonly string[] | undefined) => (types ? [...types].sort().join(',') : '');
  return `${part(query.all)}/${part(query.any)}/${part(query.none)}`;
}

/**
 * Resolves a query against the index.
 *
 * The `all` term with the fewest entities drives the iteration. That choice is the whole
 * performance story: `{ all: ['Transform', 'NpcAgent'] }` in a 10 000-entity scene is either
 * eleven checks or ten thousand depending on which set you walk, and picking the smallest is
 * both trivial and always right.
 *
 * Results come back in the index's own order; `EcsWorld.ids` sorts them into scene order before
 * caching, which is where the determinism systems rely on comes from.
 */
export function resolveQuery(index: ComponentIndex, query: QueryDescriptor): EntityId[] {
  const all = query.all ?? [];
  const any = query.any ?? [];
  const none = query.none ?? [];

  // A query with no positive term would mean "every entity", which the index cannot answer
  // (it only knows entities that carry at least one component). The Scene answers that one.
  if (all.length === 0 && any.length === 0) return [];

  let driver: ReadonlySet<EntityId> | null = null;
  for (const type of all) {
    const candidates = index.entitiesWith(type);
    if (candidates.size === 0) return [];
    if (!driver || candidates.size < driver.size) driver = candidates;
  }

  if (!driver) {
    // Only an `any` term: the union of its sets, which is the smallest superset available.
    const union = new Set<EntityId>();
    for (const type of any) for (const id of index.entitiesWith(type)) union.add(id);
    driver = union;
  }

  const out: EntityId[] = [];
  for (const id of driver) {
    if (!matches(index, id, all, any, none)) continue;
    out.push(id);
  }
  return out;
}

export function matches(
  index: ComponentIndex,
  id: EntityId,
  all: readonly string[],
  any: readonly string[],
  none: readonly string[],
): boolean {
  for (const type of all) if (!index.has(id, type)) return false;
  for (const type of none) if (index.has(id, type)) return false;
  if (any.length > 0) {
    let found = false;
    for (const type of any) {
      if (index.has(id, type)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/** True when an entity satisfies a query, without resolving the whole set. */
export function entityMatches(
  index: ComponentIndex,
  id: EntityId,
  query: QueryDescriptor,
): boolean {
  const all = query.all ?? [];
  const any = query.any ?? [];
  if (all.length === 0 && any.length === 0) return false;
  return matches(index, id, all, any, query.none ?? []);
}
