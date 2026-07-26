import type { Scene } from '@engine/scene/Scene';
import type { EntityId } from '@engine/scene/types';
import type { MeshRendererComponent } from '@engine/components/MeshRenderer';
import type { Modifier } from '@engine/mesh/modifiers';
import type { Command } from './Command';

/**
 * Reads the live modifier array off an entity's MeshRenderer.
 *
 * Returns a reference, not a copy — the commands below snapshot it themselves so that undo
 * restores the exact stack rather than a partially-mutated one.
 */
function stackOf(scene: Scene, id: EntityId): Modifier[] {
  const component = scene.getComponent<MeshRendererComponent>(id, 'MeshRenderer');
  return component?.modifiers ?? [];
}

function writeStack(scene: Scene, id: EntityId, modifiers: Modifier[]): void {
  scene.updateComponent(id, 'MeshRenderer', { modifiers });
}

/**
 * Base for stack edits: snapshot the whole array, apply a transform, and restore the snapshot
 * on undo.
 *
 * Whole-array snapshots rather than fine-grained diffs because a modifier stack is small (a
 * handful of plain objects) and the operations reorder as often as they edit. A diff would be
 * more code for no benefit and more ways to get undo subtly wrong.
 */
abstract class StackCommand implements Command {
  abstract readonly label: string;
  private previous: Modifier[] = [];

  constructor(
    protected readonly scene: Scene,
    protected readonly id: EntityId,
  ) {}

  execute(): void {
    this.previous = structuredClone(stackOf(this.scene, this.id));
    writeStack(this.scene, this.id, this.transform(structuredClone(this.previous)));
  }

  undo(): void {
    writeStack(this.scene, this.id, structuredClone(this.previous));
  }

  protected abstract transform(stack: Modifier[]): Modifier[];
}

export class AddModifierCommand extends StackCommand {
  readonly label: string;

  constructor(
    scene: Scene,
    id: EntityId,
    private readonly modifier: Modifier,
  ) {
    super(scene, id);
    this.label = `Add ${modifier.type}`;
  }

  protected transform(stack: Modifier[]): Modifier[] {
    return [...stack, structuredClone(this.modifier)];
  }
}

export class RemoveModifierCommand extends StackCommand {
  readonly label = 'Remove Modifier';

  constructor(
    scene: Scene,
    id: EntityId,
    private readonly index: number,
  ) {
    super(scene, id);
  }

  protected transform(stack: Modifier[]): Modifier[] {
    return stack.filter((_, i) => i !== this.index);
  }
}

/**
 * Moves an entry up or down the stack.
 *
 * Order is meaningful — Mirror then Array tiles a mirrored pair, Array then Mirror mirrors a
 * whole row — so this is an editing operation in its own right, not just cosmetic.
 */
export class MoveModifierCommand extends StackCommand {
  readonly label = 'Reorder Modifier';

  constructor(
    scene: Scene,
    id: EntityId,
    private readonly from: number,
    private readonly to: number,
  ) {
    super(scene, id);
  }

  protected transform(stack: Modifier[]): Modifier[] {
    if (this.to < 0 || this.to >= stack.length || this.from === this.to) return stack;
    const next = [...stack];
    const [moved] = next.splice(this.from, 1);
    if (moved) next.splice(this.to, 0, moved);
    return next;
  }
}

export class SetModifierPropertyCommand extends StackCommand {
  readonly label: string;
  readonly mergeKey: string;

  constructor(
    scene: Scene,
    id: EntityId,
    private readonly index: number,
    private readonly key: string,
    private value: unknown,
  ) {
    super(scene, id);
    this.label = `Set ${key}`;
    // Dragging a slider is one edit, so consecutive changes to the same field coalesce.
    this.mergeKey = `modifier:${id}:${index}:${key}`;
  }

  protected transform(stack: Modifier[]): Modifier[] {
    const target = stack[this.index];
    if (target) target[this.key] = this.value;
    return stack;
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetModifierPropertyCommand) || next.mergeKey !== this.mergeKey) {
      return false;
    }
    this.value = next.value;
    return true;
  }
}
