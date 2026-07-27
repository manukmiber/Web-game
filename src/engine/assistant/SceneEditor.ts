import type { Scene } from '../scene/Scene';
import { uniqueName } from '../scene/primitives';
import type { Component, Entity, EntityId, Transform } from '../scene/types';
import { writePath } from '../scene/paths';

/**
 * Every mutation the assistant tools are allowed to make, as an interface rather than direct
 * `Scene` access.
 *
 * This is the seam that lets one set of tools serve two hosts. The editor's implementation
 * routes each call through the command stack, so a scene the assistant built is undone with
 * Ctrl+Z like anything else; a headless runtime or a test uses `DirectSceneEditor` and writes
 * straight to the scene. Giving the tools a `Scene` instead would have made the editor's undo
 * history silently wrong the first time a model touched anything — and "the assistant's edits
 * are the only ones you cannot take back" is not a seam anyone would choose deliberately.
 *
 * Reads go through `scene` directly. Only writes need the indirection, because only writes
 * have something to record.
 */
export interface SceneEditor {
  readonly scene: Scene;

  /**
   * Groups everything one tool call does into a single undo step.
   *
   * Steps are applied as they are decided — a later step reads what an earlier one produced —
   * so this brackets work that has already happened rather than deferring it.
   */
  batch<T>(label: string, body: () => T): T;

  /** Parents first: adding a child before its parent exists throws. */
  add(entities: Entity[]): void;
  remove(ids: EntityId[]): void;
  rename(id: EntityId, name: string): void;
  /** `null` moves entities to the scene root. */
  reparent(ids: EntityId[], parentId: EntityId | null): void;
  setTransform(id: EntityId, transform: Partial<Transform>): void;
  addComponent(id: EntityId, component: Component): void;
  removeComponent(id: EntityId, type: string): void;
  setComponentProperty(ids: EntityId[], type: string, path: string, value: unknown): void;

  /**
   * Selection is an editor concept, so a headless host ignores it. It is on the interface
   * anyway because "make me a house" ending with the house selected is most of what makes the
   * result feel like something you did rather than something that happened to you.
   */
  select(ids: EntityId[]): void;
}

/**
 * Applies "Box", "Box (1)", "Box (2)" to what is being added — but only to the roots of the
 * batch.
 *
 * Children keep the names they were given, which is what makes duplicating a car produce a
 * second car with four wheels rather than "Wheel (4)" through "Wheel (7)". It is also Unity's
 * behaviour, and the editor's own Duplicate command already works this way.
 */
export function disambiguated(scene: Scene, entities: readonly Entity[]): Entity[] {
  const taken = scene.all().map((entity) => entity.name);
  const incoming = new Set(entities.map((entity) => entity.id));
  return entities.map((entity) => {
    if (entity.parentId !== null && incoming.has(entity.parentId)) return entity;
    const name = uniqueName(entity.name, taken);
    taken.push(name);
    return name === entity.name ? entity : { ...entity, name };
  });
}

/**
 * Writes straight to the scene, with no undo. What a runtime, a test or a script-driven build
 * uses; the editor uses `CommandSceneEditor` instead.
 */
export class DirectSceneEditor implements SceneEditor {
  constructor(readonly scene: Scene) {}

  batch<T>(_label: string, body: () => T): T {
    return body();
  }

  add(entities: Entity[]): void {
    for (const entity of disambiguated(this.scene, entities)) this.scene.add(entity);
  }

  remove(ids: EntityId[]): void {
    for (const id of ids) this.scene.remove(id);
  }

  rename(id: EntityId, name: string): void {
    this.scene.rename(id, name);
  }

  reparent(ids: EntityId[], parentId: EntityId | null): void {
    for (const id of ids) this.scene.reparent(id, parentId);
  }

  setTransform(id: EntityId, transform: Partial<Transform>): void {
    this.scene.setTransform(id, transform);
  }

  addComponent(id: EntityId, component: Component): void {
    this.scene.addComponent(id, component);
  }

  removeComponent(id: EntityId, type: string): void {
    this.scene.removeComponent(id, type);
  }

  setComponentProperty(ids: EntityId[], type: string, path: string, value: unknown): void {
    for (const id of ids) {
      const component = this.scene.getComponent(id, type);
      if (!component) continue;
      writePath(component, path, value);
      // Re-announce through the Scene so the render bridge picks the mutation up.
      this.scene.updateComponent(id, type, {});
    }
  }

  select(): void {
    // Nothing to select without an editor.
  }
}
