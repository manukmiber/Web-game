import { disambiguated, type SceneEditor } from '@engine/assistant/SceneEditor';
import type { Scene } from '@engine/scene/Scene';
import type { Component, Entity, EntityId, Transform } from '@engine/scene/types';
import type { Command, CommandHistory } from '../commands/Command';
import { CompositeCommand } from '../commands/CompositeCommand';
import {
  AddComponentCommand,
  AddEntitiesCommand,
  DeleteEntitiesCommand,
  RemoveComponentCommand,
  RenameEntityCommand,
  ReparentEntitiesCommand,
  SetComponentPropertyCommand,
  SetTransformCommand,
} from '../commands/sceneCommands';
import { useEditorStore } from '../state/editorStore';

/**
 * The editor's `SceneEditor`: every assistant edit becomes a command on the undo stack.
 *
 * This is the whole reason the tools take an interface instead of a `Scene`. An assistant that
 * writes to the scene directly produces changes the user cannot take back — which makes trying
 * anything ambitious with it a bad bet, and a bad bet is not a feature. Ctrl+Z after "build me
 * a village" has to put things back exactly, and one composite entry per tool call is what
 * makes it a single keystroke rather than two hundred.
 */
export class CommandSceneEditor implements SceneEditor {
  /** Non-null while a batch is open; commands go here instead of straight to the history. */
  private collecting: Command[] | null = null;

  constructor(
    readonly scene: Scene,
    private readonly history: CommandHistory,
  ) {}

  batch<T>(label: string, body: () => T): T {
    // Nested batches fold into the outermost one — a tool calling a helper that also batches
    // should still be one undo entry, not two.
    if (this.collecting) return body();

    const collected: Command[] = [];
    this.collecting = collected;
    try {
      return body();
    } finally {
      this.collecting = null;
      if (collected.length === 1) this.history.pushExecuted(collected[0]!);
      else if (collected.length > 1) {
        this.history.pushExecuted(new CompositeCommand(`Assistant: ${label}`, collected));
      }
    }
  }

  add(entities: Entity[]): void {
    // `AddEntitiesCommand` disambiguates every name it is given, including children. The tools
    // already decided which of these are roots, so names are settled here and the command is
    // handed a list it will leave alone.
    this.run(new AddEntitiesCommand(this.scene, disambiguated(this.scene, entities)));
  }

  remove(ids: EntityId[]): void {
    this.run(new DeleteEntitiesCommand(this.scene, ids));
  }

  rename(id: EntityId, name: string): void {
    this.run(new RenameEntityCommand(this.scene, id, name));
  }

  reparent(ids: EntityId[], parentId: EntityId | null): void {
    this.run(new ReparentEntitiesCommand(this.scene, ids, parentId));
  }

  setTransform(id: EntityId, transform: Partial<Transform>): void {
    this.run(new SetTransformCommand(this.scene, new Map([[id, transform]])));
  }

  addComponent(id: EntityId, component: Component): void {
    this.run(new AddComponentCommand(this.scene, id, component));
  }

  removeComponent(id: EntityId, type: string): void {
    this.run(new RemoveComponentCommand(this.scene, id, type));
  }

  setComponentProperty(ids: EntityId[], type: string, path: string, value: unknown): void {
    this.run(new SetComponentPropertyCommand(this.scene, ids, type, path, value));
  }

  select(ids: EntityId[]): void {
    useEditorStore.getState().setSelection(ids);
  }

  private run(command: Command): void {
    if (!this.collecting) {
      this.history.execute(command);
      return;
    }
    // Apply now so the next step in the batch reads the state this one produced; the composite
    // is pushed already-executed when the batch closes.
    command.execute();
    this.collecting.push(command);
  }
}
