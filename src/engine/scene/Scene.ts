import { Emitter } from '../core/Emitter';
import {
  type AssetRecord,
  type Component,
  type Entity,
  type EntityId,
  type Transform,
  type Vec3,
  type WorldSettings,
  DEFAULT_CHUNK_SIZE,
  chunkKeyFor,
  cloneTransform,
} from './types';

export interface SceneEvents {
  entityAdded: { entity: Entity };
  /**
   * `id` is the root of what was removed; `removedIds` is the whole subtree, deepest last.
   *
   * The subtree is reported rather than left to be re-derived because by the time a listener
   * runs, the children are already gone from the scene — anything keeping a per-entity table
   * (the render bridge, the component index) would have to scan its own keys to find out which
   * ones no longer resolve, which is O(scene) on every delete.
   */
  entityRemoved: { id: EntityId; parentId: EntityId | null; removedIds: EntityId[] };
  entityRenamed: { id: EntityId; name: string };
  entityReparented: { id: EntityId; parentId: EntityId | null; previousParentId: EntityId | null };
  transformChanged: { id: EntityId };
  componentsChanged: { id: EntityId };
  assetsChanged: Record<string, never>;
  /** Wholesale replacement (load, or undo of a destructive op). Listeners should resync fully. */
  sceneReplaced: Record<string, never>;
}

let idCounter = 0;

/** Ids must be unique scene-wide so cross-chunk references survive independent loading. §9.2 */
export function generateEntityId(): EntityId {
  idCounter += 1;
  return `e${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/**
 * The scene graph. Owns entity data and parent/child structure; knows nothing about
 * rendering, selection, or undo. Mutations here are raw — the editor always goes through
 * commands (editor/commands) so they land on the undo stack.
 */
export class Scene {
  readonly events = new Emitter<SceneEvents>();

  name = 'Untitled Scene';
  world: WorldSettings = { chunkSize: DEFAULT_CHUNK_SIZE };

  private entities = new Map<EntityId, Entity>();
  /** Maintained alongside `entities` so child lookup is O(children), not O(entities). */
  private childIds = new Map<EntityId | null, EntityId[]>();
  private assets = new Map<string, AssetRecord>();
  /** Transforms mutated in place this frame — see `markTransformDirty`. */
  private dirtyTransforms = new Set<EntityId>();

  constructor() {
    this.childIds.set(null, []);
  }

  // ---------------------------------------------------------------- queries

  get(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  /** Throws if missing. Use where absence is a bug rather than a case to handle. */
  expect(id: EntityId): Entity {
    const entity = this.entities.get(id);
    if (!entity) throw new Error(`Scene: no entity with id "${id}"`);
    return entity;
  }

  has(id: EntityId): boolean {
    return this.entities.has(id);
  }

  get size(): number {
    return this.entities.size;
  }

  all(): Entity[] {
    return [...this.entities.values()];
  }

  childrenOf(id: EntityId | null): EntityId[] {
    return this.childIds.get(id) ?? [];
  }

  rootIds(): EntityId[] {
    return this.childrenOf(null);
  }

  /** Depth-first ids of the subtree rooted at `id`, `id` itself first. */
  subtreeOf(id: EntityId): EntityId[] {
    const out: EntityId[] = [];
    const walk = (current: EntityId) => {
      out.push(current);
      for (const child of this.childrenOf(current)) walk(child);
    };
    walk(id);
    return out;
  }

  ancestorsOf(id: EntityId): EntityId[] {
    const out: EntityId[] = [];
    let current = this.get(id)?.parentId ?? null;
    while (current) {
      out.push(current);
      current = this.get(current)?.parentId ?? null;
    }
    return out;
  }

  isDescendantOf(id: EntityId, possibleAncestor: EntityId): boolean {
    return this.ancestorsOf(id).includes(possibleAncestor);
  }

  chunkKeyOf(id: EntityId): string {
    return chunkKeyFor(this.worldPositionOf(id), this.world.chunkSize);
  }

  /**
   * Position in world space, accumulated through parents.
   *
   * Deliberately ignores parent rotation/scale: this exists to bucket entities into chunks,
   * and an approximate bucket is fine (a chunk is 256 m). Exact world transforms are the
   * render bridge's job, where Three.js already maintains matrix hierarchies.
   */
  private worldPositionOf(id: EntityId): Vec3 {
    const out: Vec3 = [0, 0, 0];
    let current: EntityId | null = id;
    while (current) {
      const entity: Entity | undefined = this.entities.get(current);
      if (!entity) break;
      out[0] += entity.transform.position[0];
      out[1] += entity.transform.position[1];
      out[2] += entity.transform.position[2];
      current = entity.parentId;
    }
    return out;
  }

  // --------------------------------------------------------------- mutation

  add(entity: Entity, index?: number): Entity {
    if (this.entities.has(entity.id)) {
      throw new Error(`Scene: duplicate entity id "${entity.id}"`);
    }
    if (entity.parentId !== null && !this.entities.has(entity.parentId)) {
      throw new Error(`Scene: parent "${entity.parentId}" of "${entity.id}" does not exist`);
    }
    this.entities.set(entity.id, entity);
    this.childIds.set(entity.id, []);
    this.insertChild(entity.parentId, entity.id, index);
    this.events.emit('entityAdded', { entity });
    return entity;
  }

  /** Removes the entity and its whole subtree. Returns removed entities, deepest last. */
  remove(id: EntityId): Entity[] {
    const entity = this.get(id);
    if (!entity) return [];
    const removed = this.subtreeOf(id).map((childId) => this.expect(childId));
    // Detach the root of the subtree only; the rest go with it.
    this.detachChild(entity.parentId, id);
    for (const e of removed) {
      this.entities.delete(e.id);
      this.childIds.delete(e.id);
    }
    this.events.emit('entityRemoved', {
      id,
      parentId: entity.parentId,
      removedIds: removed.map((e) => e.id),
    });
    return removed;
  }

  rename(id: EntityId, name: string): void {
    const entity = this.expect(id);
    if (entity.name === name) return;
    entity.name = name;
    this.events.emit('entityRenamed', { id, name });
  }

  /**
   * Reparent, preserving sibling ordering via `index`.
   *
   * Note this changes the entity's *local* transform semantics: the caller is responsible
   * for rebasing the transform if it wants the entity to stay put visually. The editor's
   * ReparentCommand does exactly that.
   */
  reparent(id: EntityId, parentId: EntityId | null, index?: number): void {
    const entity = this.expect(id);
    if (parentId !== null) {
      if (parentId === id) throw new Error('Scene: an entity cannot parent itself');
      if (!this.entities.has(parentId)) throw new Error(`Scene: no entity with id "${parentId}"`);
      if (this.isDescendantOf(parentId, id)) {
        throw new Error('Scene: cannot reparent an entity under its own descendant');
      }
    }
    const previousParentId = entity.parentId;
    this.detachChild(previousParentId, id);
    entity.parentId = parentId;
    this.insertChild(parentId, id, index);
    this.events.emit('entityReparented', { id, parentId, previousParentId });
  }

  /** Sibling position within the current parent, or -1 if unknown. */
  indexOf(id: EntityId): number {
    const entity = this.get(id);
    if (!entity) return -1;
    return this.childrenOf(entity.parentId).indexOf(id);
  }

  setTransform(id: EntityId, transform: Partial<Transform>): void {
    const entity = this.expect(id);
    if (transform.position) entity.transform.position = [...transform.position];
    if (transform.rotation) entity.transform.rotation = [...transform.rotation];
    if (transform.scale) entity.transform.scale = [...transform.scale];
    this.events.emit('transformChanged', { id });
  }

  /**
   * Records that an entity's transform was mutated in place, to be announced once at the end
   * of the frame by `flushTransforms()`.
   *
   * This exists for gameplay systems. A hundred wandering NPCs each writing x, y and z through
   * `setTransform` would emit three hundred events a frame, and every listener — the render
   * bridge, the selection outline, the gizmo pivot — would run three hundred times for a
   * hundred actual changes. Editor commands keep using `setTransform`: a gizmo drag is one
   * entity and wants its event immediately.
   */
  markTransformDirty(id: EntityId): void {
    this.dirtyTransforms.add(id);
  }

  /** Emits one `transformChanged` per entity marked dirty since the last call. */
  flushTransforms(): void {
    if (this.dirtyTransforms.size === 0) return;
    const ids = [...this.dirtyTransforms];
    this.dirtyTransforms.clear();
    for (const id of ids) {
      // An entity destroyed later in the same frame has nothing left to sync.
      if (this.entities.has(id)) this.events.emit('transformChanged', { id });
    }
  }

  getComponent<T extends Component = Component>(id: EntityId, type: string): T | undefined {
    return this.get(id)?.components.find((c) => c.type === type) as T | undefined;
  }

  /**
   * Every component of a type, in the order the entity stores them.
   *
   * Most types are one per entity and `getComponent` is the right call. Some are deliberately
   * not — an entity can carry several `Script` components, one per behaviour — and everything
   * that has to see all of them goes through here. See `ComponentDefinition.allowMultiple`.
   */
  getComponents<T extends Component = Component>(id: EntityId, type: string): T[] {
    return (this.get(id)?.components.filter((c) => c.type === type) ?? []) as T[];
  }

  addComponent(id: EntityId, component: Component, index?: number): void {
    const entity = this.expect(id);
    if (index === undefined) entity.components.push(component);
    else entity.components.splice(index, 0, component);
    this.events.emit('componentsChanged', { id });
  }

  removeComponent(id: EntityId, type: string): Component | undefined {
    const entity = this.expect(id);
    const index = entity.components.findIndex((c) => c.type === type);
    if (index === -1) return undefined;
    return this.removeComponentAt(id, index);
  }

  /**
   * Removes whichever component sits at `index`.
   *
   * The by-type form cannot express "the second Script on this entity", and once a type can
   * repeat, removing by type quietly deletes the wrong one — the first, always.
   */
  removeComponentAt(id: EntityId, index: number): Component | undefined {
    const entity = this.expect(id);
    if (index < 0 || index >= entity.components.length) return undefined;
    const [removed] = entity.components.splice(index, 1);
    this.events.emit('componentsChanged', { id });
    return removed;
  }

  /** Shallow-merges `patch` into the first component of that type. No-op if the entity lacks it. */
  updateComponent(id: EntityId, type: string, patch: Record<string, unknown>): void {
    const component = this.getComponent(id, type);
    if (!component) return;
    Object.assign(component, patch);
    this.events.emit('componentsChanged', { id });
  }

  /** Shallow-merges `patch` into the component at `index`. */
  updateComponentAt(id: EntityId, index: number, patch: Record<string, unknown>): void {
    const component = this.get(id)?.components[index];
    if (!component) return;
    Object.assign(component, patch);
    this.events.emit('componentsChanged', { id });
  }

  /**
   * Announces that a component was mutated in place.
   *
   * The command layer writes through a dotted path directly into the component object, so there
   * is no patch to merge — but the render bridge still has to hear about it. `updateComponent`
   * with an empty patch used to serve as this, which only worked while every type was unique.
   */
  touchComponents(id: EntityId): void {
    if (this.has(id)) this.events.emit('componentsChanged', { id });
  }

  // ----------------------------------------------------------------- assets

  listAssets(): AssetRecord[] {
    return [...this.assets.values()];
  }

  getAsset(id: string): AssetRecord | undefined {
    return this.assets.get(id);
  }

  addAsset(asset: AssetRecord): void {
    this.assets.set(asset.id, asset);
    this.events.emit('assetsChanged', {});
  }

  removeAsset(id: string): void {
    if (this.assets.delete(id)) this.events.emit('assetsChanged', {});
  }

  // ------------------------------------------------------------------ bulk

  /** Drops everything. Emits a single `sceneReplaced` so listeners resync in one pass. */
  clear(): void {
    this.entities.clear();
    this.childIds.clear();
    this.childIds.set(null, []);
    this.assets.clear();
    this.dirtyTransforms.clear();
    this.events.emit('sceneReplaced', {});
  }

  /**
   * Populates from already-validated data without per-entity events.
   *
   * Entities may arrive in any order — children before parents included — so structure is
   * wired up in a second pass.
   */
  load(data: {
    name: string;
    world: WorldSettings;
    entities: Entity[];
    assets: AssetRecord[];
  }): void {
    this.entities.clear();
    this.childIds.clear();
    this.childIds.set(null, []);
    this.assets.clear();
    this.dirtyTransforms.clear();

    this.name = data.name;
    this.world = { ...data.world };

    for (const entity of data.entities) {
      this.entities.set(entity.id, entity);
      this.childIds.set(entity.id, []);
    }
    for (const entity of data.entities) {
      // A parent that didn't survive the load would orphan the child; promote it to root
      // rather than dropping it, so no data is silently lost.
      if (entity.parentId !== null && !this.entities.has(entity.parentId)) entity.parentId = null;
      this.childIds.get(entity.parentId)!.push(entity.id);
    }
    for (const asset of data.assets) this.assets.set(asset.id, asset);

    this.events.emit('sceneReplaced', {});
  }

  // --------------------------------------------------------------- internal

  private insertChild(parentId: EntityId | null, childId: EntityId, index?: number): void {
    let siblings = this.childIds.get(parentId);
    if (!siblings) {
      siblings = [];
      this.childIds.set(parentId, siblings);
    }
    if (index === undefined || index < 0 || index >= siblings.length) siblings.push(childId);
    else siblings.splice(index, 0, childId);
  }

  private detachChild(parentId: EntityId | null, childId: EntityId): void {
    const siblings = this.childIds.get(parentId);
    if (!siblings) return;
    const index = siblings.indexOf(childId);
    if (index !== -1) siblings.splice(index, 1);
  }
}

export { cloneTransform };
