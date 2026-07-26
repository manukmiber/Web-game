import type { FieldSchema } from '../../components/registry';
import type { MeshData } from '../MeshData';

/**
 * One entry in an object's modifier stack.
 *
 * Deliberately plain data: a modifier is part of the scene document, so it has to serialise,
 * undo and round-trip like everything else. Behaviour lives in the registry, keyed by `type`.
 */
export interface Modifier {
  type: string;
  enabled: boolean;
  [key: string]: unknown;
}

export interface ModifierDefinition<T extends Modifier = Modifier> {
  type: string;
  label: string;
  create(overrides?: Partial<T>): T;
  /** Inspector fields, same schema the component registry uses. */
  fields(modifier: T): FieldSchema[];
  /**
   * Takes a mesh and returns a new one. Must not mutate the input — the stack is
   * non-destructive, and the source mesh is re-used every time a later modifier changes.
   */
  apply(mesh: MeshData, modifier: T): MeshData;
}

const definitions = new Map<string, ModifierDefinition>();

export function registerModifier<T extends Modifier>(definition: ModifierDefinition<T>): void {
  definitions.set(definition.type, definition as ModifierDefinition);
}

export function getModifierDefinition(type: string): ModifierDefinition | undefined {
  return definitions.get(type);
}

export function listModifierDefinitions(): ModifierDefinition[] {
  return [...definitions.values()];
}

/**
 * Runs the stack in order.
 *
 * Unknown modifier types are skipped rather than throwing, for the same reason unknown
 * components are preserved: a scene authored in a newer build should still open here, minus
 * the effect it cannot reproduce.
 */
export function applyModifiers(mesh: MeshData, modifiers: readonly Modifier[]): MeshData {
  let current = mesh;
  for (const modifier of modifiers) {
    if (modifier.enabled === false) continue;
    const definition = definitions.get(modifier.type);
    if (!definition) continue;
    current = definition.apply(current, modifier);
  }
  return current;
}
