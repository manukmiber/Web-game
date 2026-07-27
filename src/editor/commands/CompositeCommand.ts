import type { Command } from './Command';

/**
 * Several commands undone and redone as one step.
 *
 * "Build me a fence" is twelve boxes, a group and a transform; twelve entries on the undo
 * stack is not a fence, it is a list of things that happened. One entry labelled "Assistant:
 * create fence" is the unit the user actually thinks in — and the unit they will want back
 * when they change their mind.
 *
 * Order matters in both directions: redo replays forwards so a child is created after its
 * parent, undo runs backwards so the parent is removed after the child.
 */
export class CompositeCommand implements Command {
  constructor(
    readonly label: string,
    private readonly commands: readonly Command[],
  ) {}

  get size(): number {
    return this.commands.length;
  }

  execute(): void {
    for (const command of this.commands) command.execute();
  }

  undo(): void {
    for (let index = this.commands.length - 1; index >= 0; index -= 1) {
      this.commands[index]!.undo();
    }
  }
}
