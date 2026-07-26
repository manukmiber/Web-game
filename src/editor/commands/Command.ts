import { Emitter } from '@engine/core/Emitter';

export interface Command {
  /** Shown in tooltips and useful in tests; not user-editable. */
  readonly label: string;
  execute(): void;
  undo(): void;
  /**
   * Commands sharing a merge key coalesce when issued back to back within the merge window.
   *
   * This is what stops a single gizmo drag from becoming sixty undo entries. Undefined means
   * never merge.
   */
  readonly mergeKey?: string;
  /** Absorb a newer same-key command. Return false to decline and be pushed separately. */
  mergeWith?(next: Command): boolean;
}

interface HistoryEvents {
  changed: { canUndo: boolean; canRedo: boolean };
}

/** Two consecutive same-key commands merge if issued within this window. */
const MERGE_WINDOW_MS = 600;
const DEFAULT_LIMIT = 200;

/**
 * Undo/redo stack. Editor-only by design — the game runtime has no history, which is exactly
 * why this lives outside `engine/` (ARCHITECTURE.md §5).
 */
export class CommandHistory {
  readonly events = new Emitter<HistoryEvents>();

  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private lastPushTime = 0;
  /**
   * Set while a command is executing so scene events triggered by it don't recursively
   * enqueue more commands (the Inspector listens to the same events it writes through).
   */
  private applying = false;
  private interactionDepth = 0;
  /** Forces the first command of an interaction to start a new entry rather than merge. */
  private startingInteraction = false;

  constructor(private readonly limit = DEFAULT_LIMIT) {}

  get isApplying(): boolean {
    return this.applying;
  }

  /**
   * Marks the start of a continuous interaction such as a gizmo drag, within which every
   * same-key command coalesces into one undo entry no matter how long it takes.
   *
   * The timer alone is not enough. A user placing an object carefully can easily go longer
   * than the merge window between two mouse moves, and with snapping enabled the gizmo only
   * emits a change when the pointer crosses a snap increment — so a slow snapped drag would
   * otherwise leave a trail of undo entries for what was, to the user, one action.
   */
  beginInteraction(): void {
    this.interactionDepth += 1;
    if (this.interactionDepth === 1) this.startingInteraction = true;
  }

  endInteraction(): void {
    if (this.interactionDepth === 0) return;
    this.interactionDepth -= 1;
    // Stop the next unrelated command from merging into the one that just finished.
    if (this.interactionDepth === 0) this.lastPushTime = 0;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Runs the command and pushes it, merging into the previous one where possible. */
  execute(command: Command): void {
    this.run(() => command.execute());
    this.redoStack = [];

    const previous = this.undoStack[this.undoStack.length - 1];
    // Inside an interaction the window is irrelevant; outside it, proximity in time is the
    // only signal that two commands were one user action (typing in a number field).
    const inWindow = this.interactionDepth > 0 || performance.now() - this.lastPushTime < MERGE_WINDOW_MS;
    const mergeable =
      !this.startingInteraction &&
      previous &&
      command.mergeKey !== undefined &&
      previous.mergeKey === command.mergeKey &&
      inWindow &&
      previous.mergeWith?.(command);
    this.startingInteraction = false;

    if (!mergeable) {
      this.undoStack.push(command);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }

    this.lastPushTime = performance.now();
    this.emitChanged();
  }

  undo(): void {
    const command = this.undoStack.pop();
    if (!command) return;
    this.run(() => command.undo());
    this.redoStack.push(command);
    // Prevents a merge across an undo boundary, which would silently rewrite history.
    this.lastPushTime = 0;
    this.emitChanged();
  }

  redo(): void {
    const command = this.redoStack.pop();
    if (!command) return;
    this.run(() => command.execute());
    this.undoStack.push(command);
    this.lastPushTime = 0;
    this.emitChanged();
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.lastPushTime = 0;
    this.interactionDepth = 0;
    this.startingInteraction = false;
    this.emitChanged();
  }

  /** Labels, oldest first. For tests and a future history panel. */
  undoLabels(): string[] {
    return this.undoStack.map((c) => c.label);
  }

  private run(action: () => void): void {
    this.applying = true;
    try {
      action();
    } finally {
      this.applying = false;
    }
  }

  private emitChanged(): void {
    this.events.emit('changed', { canUndo: this.canUndo(), canRedo: this.canRedo() });
  }
}
