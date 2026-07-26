import type { Scene } from '@engine/scene/Scene';
import { generateEntityId } from '@engine/scene/Scene';
import { uniqueName } from '@engine/scene/primitives';
import type { Component, Entity, EntityId, Transform } from '@engine/scene/types';
import { cloneTransform } from '@engine/scene/types';
import type { Command } from './Command';

function snapshot(entity: Entity): Entity {
  return structuredClone(entity);
}

/** Names of every entity in the scene — used to keep sibling names unique. */
function takenNames(scene: Scene): string[] {
  return scene.all().map((e) => e.name);
}

export class AddEntityCommand implements Command {
  readonly label: string;
  private readonly entity: Entity;

  constructor(
    private readonly scene: Scene,
    entity: Entity,
    private readonly index?: number,
  ) {
    this.entity = { ...entity, name: uniqueName(entity.name, takenNames(scene)) };
    this.label = `Add ${this.entity.name}`;
  }

  get entityId(): EntityId {
    return this.entity.id;
  }

  execute(): void {
    this.scene.add(this.entity, this.index);
  }

  undo(): void {
    this.scene.remove(this.entity.id);
  }
}

/**
 * Deleting captures the whole subtree, including each entity's sibling index, so undo puts
 * everything back exactly where it was rather than appending it to the end of its parent.
 */
export class DeleteEntitiesCommand implements Command {
  readonly label: string;
  private records: { entity: Entity; index: number }[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly ids: EntityId[],
  ) {
    this.label = ids.length === 1 ? 'Delete Entity' : `Delete ${ids.length} Entities`;
  }

  execute(): void {
    this.records = [];
    // Deleting a parent also deletes its children, so skip ids already covered by an
    // ancestor in the same selection — otherwise the second delete would be a no-op and
    // undo would restore an incomplete tree.
    const roots = this.ids.filter(
      (id) => !this.ids.some((other) => other !== id && this.scene.isDescendantOf(id, other)),
    );
    for (const id of roots) {
      const index = this.scene.indexOf(id);
      const removed = this.scene.remove(id);
      for (const [offset, entity] of removed.entries()) {
        this.records.push({ entity: snapshot(entity), index: offset === 0 ? index : -1 });
      }
    }
  }

  undo(): void {
    // Restore in capture order: `Scene.remove` returns parents before children, so parents
    // always exist by the time their children are re-added.
    for (const { entity, index } of this.records) {
      this.scene.add(snapshot(entity), index >= 0 ? index : undefined);
    }
  }
}

export class RenameEntityCommand implements Command {
  readonly label = 'Rename Entity';
  readonly mergeKey: string;
  private previousName: string;

  constructor(
    private readonly scene: Scene,
    private readonly id: EntityId,
    private nextName: string,
  ) {
    this.previousName = scene.expect(id).name;
    this.mergeKey = `rename:${id}`;
  }

  execute(): void {
    this.scene.rename(this.id, this.nextName);
  }

  undo(): void {
    this.scene.rename(this.id, this.previousName);
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof RenameEntityCommand) || next.id !== this.id) return false;
    this.nextName = next.nextName;
    return true;
  }
}

export class ReparentEntitiesCommand implements Command {
  readonly label = 'Reparent';
  private records: {
    id: EntityId;
    previousParentId: EntityId | null;
    previousIndex: number;
    previousTransform: Transform;
  }[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly ids: EntityId[],
    private readonly parentId: EntityId | null,
    private readonly index?: number,
  ) {}

  execute(): void {
    this.records = [];
    for (const id of this.ids) {
      // Dropping a parent onto its own descendant is a legal gesture in the tree UI but an
      // illegal graph edit; skip rather than throw so the rest of a multi-drag still applies.
      if (this.parentId !== null && (id === this.parentId || this.scene.isDescendantOf(this.parentId, id))) {
        continue;
      }
      const entity = this.scene.expect(id);
      // Read before reparenting: `entity` is a live reference, so `entity.parentId` becomes
      // the new parent the moment the reparent lands.
      const previousParentId = entity.parentId;
      this.records.push({
        id,
        previousParentId,
        previousIndex: this.scene.indexOf(id),
        previousTransform: cloneTransform(entity.transform),
      });
      this.scene.reparent(id, this.parentId, this.index);
      this.scene.setTransform(id, rebasedTransform(this.scene, id, previousParentId, this.parentId));
    }
  }

  undo(): void {
    for (const record of [...this.records].reverse()) {
      this.scene.reparent(record.id, record.previousParentId, record.previousIndex);
      this.scene.setTransform(record.id, record.previousTransform);
    }
  }
}

/**
 * Keeps an entity visually in place across a reparent by rebasing its local position.
 *
 * Position only — parent rotation and scale would need full matrix decomposition to
 * compensate for, and the Scene deliberately does not maintain world matrices (that is the
 * render bridge's job). Reparenting under a rotated parent therefore does move the child,
 * which matches how the drag reads in the Hierarchy: you are changing whose space it lives in.
 */
function rebasedTransform(
  scene: Scene,
  id: EntityId,
  previousParentId: EntityId | null,
  nextParentId: EntityId | null,
): Partial<Transform> {
  const entity = scene.expect(id);
  const previousOrigin = accumulatedPosition(scene, previousParentId);
  const nextOrigin = accumulatedPosition(scene, nextParentId);
  return {
    position: [
      entity.transform.position[0] + previousOrigin[0] - nextOrigin[0],
      entity.transform.position[1] + previousOrigin[1] - nextOrigin[1],
      entity.transform.position[2] + previousOrigin[2] - nextOrigin[2],
    ],
  };
}

function accumulatedPosition(scene: Scene, id: EntityId | null): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  let current = id;
  while (current) {
    const entity = scene.get(current);
    if (!entity) break;
    out[0] += entity.transform.position[0];
    out[1] += entity.transform.position[1];
    out[2] += entity.transform.position[2];
    current = entity.parentId;
  }
  return out;
}

/**
 * Transform edits from both the gizmo and the Inspector.
 *
 * `mergeKey` includes the entity ids so a drag coalesces into one history entry, while
 * switching to a different object starts a fresh one.
 */
export class SetTransformCommand implements Command {
  readonly label = 'Transform';
  readonly mergeKey: string;
  private previous: Map<EntityId, Transform>;

  constructor(
    private readonly scene: Scene,
    private next: Map<EntityId, Partial<Transform>>,
  ) {
    this.previous = new Map();
    for (const id of next.keys()) {
      this.previous.set(id, cloneTransform(scene.expect(id).transform));
    }
    this.mergeKey = `transform:${[...next.keys()].sort().join(',')}`;
  }

  execute(): void {
    for (const [id, transform] of this.next) {
      if (this.scene.has(id)) this.scene.setTransform(id, transform);
    }
  }

  undo(): void {
    for (const [id, transform] of this.previous) {
      if (this.scene.has(id)) this.scene.setTransform(id, transform);
    }
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetTransformCommand) || next.mergeKey !== this.mergeKey) return false;
    // Keep our `previous` (the state before the drag started) and take their newer target.
    this.next = next.next;
    return true;
  }
}

export class SetComponentPropertyCommand implements Command {
  readonly label: string;
  readonly mergeKey: string;
  private previous: Map<EntityId, unknown>;

  constructor(
    private readonly scene: Scene,
    private readonly ids: EntityId[],
    private readonly componentType: string,
    private readonly path: string,
    private nextValue: unknown,
  ) {
    this.label = `Set ${path}`;
    this.mergeKey = `component:${componentType}:${path}:${[...ids].sort().join(',')}`;
    this.previous = new Map();
    for (const id of ids) {
      const component = scene.getComponent(id, componentType);
      if (component) this.previous.set(id, structuredClone(readPath(component, path)));
    }
  }

  execute(): void {
    for (const id of this.ids) this.write(id, this.nextValue);
  }

  undo(): void {
    for (const id of this.ids) {
      if (this.previous.has(id)) this.write(id, this.previous.get(id));
    }
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetComponentPropertyCommand) || next.mergeKey !== this.mergeKey) {
      return false;
    }
    this.nextValue = next.nextValue;
    return true;
  }

  private write(id: EntityId, value: unknown): void {
    const component = this.scene.getComponent(id, this.componentType);
    if (!component) return;
    writePath(component, this.path, value);
    // Re-emit through the Scene so the render bridge picks up the mutation.
    this.scene.updateComponent(id, this.componentType, {});
  }
}

export class AddComponentCommand implements Command {
  readonly label: string;

  constructor(
    private readonly scene: Scene,
    private readonly id: EntityId,
    private readonly component: Component,
  ) {
    this.label = `Add ${component.type}`;
  }

  execute(): void {
    this.scene.addComponent(this.id, structuredClone(this.component));
  }

  undo(): void {
    this.scene.removeComponent(this.id, this.component.type);
  }
}

export class RemoveComponentCommand implements Command {
  readonly label: string;
  private removed: Component | undefined;
  private index = -1;

  constructor(
    private readonly scene: Scene,
    private readonly id: EntityId,
    private readonly componentType: string,
  ) {
    this.label = `Remove ${componentType}`;
  }

  execute(): void {
    const entity = this.scene.get(this.id);
    this.index = entity?.components.findIndex((c) => c.type === this.componentType) ?? -1;
    this.removed = this.scene.removeComponent(this.id, this.componentType);
  }

  undo(): void {
    if (!this.removed) return;
    this.scene.addComponent(this.id, structuredClone(this.removed), this.index >= 0 ? this.index : undefined);
  }
}

/**
 * Duplicates entities with their subtrees, remapping ids so the copy is fully independent
 * while internal parent references stay pointing inside the copy.
 */
export class DuplicateEntitiesCommand implements Command {
  readonly label: string;
  private created: Entity[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly ids: EntityId[],
  ) {
    this.label = ids.length === 1 ? 'Duplicate Entity' : `Duplicate ${ids.length} Entities`;
  }

  /** New top-level ids, for selecting the copy after the operation. */
  get createdRootIds(): EntityId[] {
    const createdIds = new Set(this.created.map((e) => e.id));
    return this.created.filter((e) => e.parentId === null || !createdIds.has(e.parentId)).map((e) => e.id);
  }

  execute(): void {
    this.created = [];
    const names = takenNames(this.scene);
    const roots = this.ids.filter(
      (id) => !this.ids.some((other) => other !== id && this.scene.isDescendantOf(id, other)),
    );

    for (const rootId of roots) {
      const idMap = new Map<EntityId, EntityId>();
      for (const id of this.scene.subtreeOf(rootId)) idMap.set(id, generateEntityId());

      for (const id of this.scene.subtreeOf(rootId)) {
        const source = this.scene.expect(id);
        const copy = snapshot(source);
        copy.id = idMap.get(id)!;
        copy.parentId = source.parentId ? (idMap.get(source.parentId) ?? source.parentId) : null;
        // Only the duplicated root needs disambiguating; children keep their names, which is
        // what Unity does and keeps "Wheel" from becoming "Wheel (7)" inside every copy.
        if (id === rootId) {
          copy.name = uniqueName(source.name, names);
          names.push(copy.name);
        }
        this.created.push(copy);
      }
    }

    for (const entity of this.created) this.scene.add(snapshot(entity));
  }

  undo(): void {
    for (const id of this.createdRootIds) this.scene.remove(id);
  }
}

/**
 * Wraps the selection in a new Empty, positioned at the selection's centre so the group's
 * pivot is where you'd expect to grab it.
 */
export class GroupEntitiesCommand implements Command {
  readonly label = 'Group Selected';
  private groupId: EntityId | null = null;
  private records: { id: EntityId; parentId: EntityId | null; index: number; transform: Transform }[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly ids: EntityId[],
  ) {}

  get createdGroupId(): EntityId | null {
    return this.groupId;
  }

  execute(): void {
    const roots = this.ids.filter(
      (id) => !this.ids.some((other) => other !== id && this.scene.isDescendantOf(id, other)),
    );
    if (roots.length === 0) return;

    const centre: [number, number, number] = [0, 0, 0];
    for (const id of roots) {
      const position = accumulatedPosition(this.scene, id);
      centre[0] += position[0] / roots.length;
      centre[1] += position[1] / roots.length;
      centre[2] += position[2] / roots.length;
    }

    // Group under the shared parent when there is one, so grouping inside a subtree doesn't
    // yank the objects out to the scene root.
    const firstParent = this.scene.expect(roots[0]!).parentId;
    const sharedParent = roots.every((id) => this.scene.expect(id).parentId === firstParent)
      ? firstParent
      : null;
    const parentOrigin = accumulatedPosition(this.scene, sharedParent);

    this.groupId = generateEntityId();
    this.scene.add({
      id: this.groupId,
      name: uniqueName('Group', takenNames(this.scene)),
      parentId: sharedParent,
      transform: {
        position: [
          centre[0] - parentOrigin[0],
          centre[1] - parentOrigin[1],
          centre[2] - parentOrigin[2],
        ],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      components: [],
    });

    this.records = [];
    for (const id of roots) {
      const entity = this.scene.expect(id);
      this.records.push({
        id,
        parentId: entity.parentId,
        index: this.scene.indexOf(id),
        transform: cloneTransform(entity.transform),
      });
      const previousParentId = entity.parentId;
      this.scene.reparent(id, this.groupId);
      this.scene.setTransform(id, rebasedTransform(this.scene, id, previousParentId, this.groupId));
    }
  }

  undo(): void {
    for (const record of [...this.records].reverse()) {
      this.scene.reparent(record.id, record.parentId, record.index);
      this.scene.setTransform(record.id, record.transform);
    }
    if (this.groupId) this.scene.remove(this.groupId);
    this.records = [];
  }
}

// ------------------------------------------------------------------ helpers

/** Reads "params.width" style paths used by the Inspector field schemas. */
export function readPath(target: Record<string, unknown>, path: string): unknown {
  let current: unknown = target;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  let current: Record<string, unknown> = target;
  for (const key of keys) {
    const next = current[key];
    if (typeof next !== 'object' || next === null) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[last] = value;
}
