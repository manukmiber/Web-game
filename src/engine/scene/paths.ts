/**
 * Dotted property paths into component data — "params.width", "props.speed".
 *
 * They live in the engine rather than in the editor's command layer because three separate
 * things now address component fields by path: the Inspector's field schemas, the undo
 * command that writes them, and the assistant tools (`engine/assistant`). The engine may not
 * import the editor, so the shared helper has to sit on this side of the line.
 */

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
