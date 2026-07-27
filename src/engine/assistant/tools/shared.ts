import type { Scene } from '../../scene/Scene';
import type { Entity, EntityId } from '../../scene/types';

/**
 * Resolves an entity reference, which may be an id or an exact name.
 *
 * Accepting names is not sloppiness, it is the difference between a tool that works and one
 * that burns a turn: a model that has just read "Crate 1" in a scene listing will pass
 * "Crate 1" back, and an id-only API answers that with an error instead of a crate. Ids win
 * ties, and an ambiguous name is an error rather than a coin flip — sibling names are unique
 * per scene, so ambiguity means something has genuinely gone wrong.
 */
export function resolveEntity(scene: Scene, reference: string): Entity {
  const byId = scene.get(reference);
  if (byId) return byId;

  const byName = scene.all().filter((entity) => entity.name === reference);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new Error(
      `"${reference}" matches ${byName.length} entities (${byName.map((e) => e.id).join(', ')}). Use an id.`,
    );
  }
  throw new Error(`No entity with id or name "${reference}". Call describe_scene to list what exists.`);
}

export function resolveEntities(scene: Scene, references: readonly string[]): Entity[] {
  return references.map((reference) => resolveEntity(scene, reference));
}

function round(value: number): number {
  // Three decimals: enough for millimetre placement, short enough that a scene listing of a
  // hundred objects is still readable.
  return Math.round(value * 1000) / 1000;
}

export function formatVec3(vec: readonly number[]): string {
  return vec.map(round).join(', ');
}

/** The primitive an entity renders, when it has one — the most useful single word about it. */
export function primitiveOf(entity: Entity): string | undefined {
  const renderer = entity.components.find((component) => component.type === 'MeshRenderer');
  return typeof renderer?.primitive === 'string' ? renderer.primitive : undefined;
}

/** One line per entity: enough to pick one out, short enough to list the whole scene. */
export function summariseEntity(entity: Entity): string {
  const kind = primitiveOf(entity) ?? 'Empty';
  const types = entity.components.map((component) => component.type);
  const extras = types.filter((type) => type !== 'MeshRenderer' && type !== 'Material');
  const tail = extras.length > 0 ? ` +${extras.join(',')}` : '';
  return `${entity.id} "${entity.name}" ${kind} at (${formatVec3(entity.transform.position)})${tail}`;
}

/** The hierarchy as an indented tree, which is how a scene is actually read. */
export function outlineScene(scene: Scene, limit: number): string {
  const lines: string[] = [];
  let truncated = false;

  const walk = (id: EntityId, depth: number) => {
    if (lines.length >= limit) {
      truncated = true;
      return;
    }
    lines.push(`${'  '.repeat(depth)}${summariseEntity(scene.expect(id))}`);
    for (const child of scene.childrenOf(id)) walk(child, depth + 1);
  };

  for (const rootId of scene.rootIds()) walk(rootId, 0);
  if (truncated) lines.push(`… ${scene.size - limit} more entities not shown`);
  return lines.join('\n');
}

/** Entities the caller just created or changed, reported the same way every time. */
export function report(action: string, entities: readonly Entity[]): string {
  if (entities.length === 0) return `${action}: nothing matched.`;
  return `${action}:\n${entities.map((entity) => summariseEntity(entity)).join('\n')}`;
}
