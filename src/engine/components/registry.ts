import type { Component } from '../scene/types';

/**
 * Field metadata. The Inspector builds its UI from this rather than from a switch statement,
 * which is what makes adding a component type (Script/Behaviour in Phase 3) a single
 * `registerComponent` call with no editor changes. See ARCHITECTURE.md §3.
 */
export type FieldSchema =
  | { kind: 'number'; key: string; label: string; min?: number; max?: number; step?: number; integer?: boolean }
  | { kind: 'vec3'; key: string; label: string; step?: number }
  | { kind: 'boolean'; key: string; label: string }
  | { kind: 'string'; key: string; label: string }
  | { kind: 'color'; key: string; label: string }
  | { kind: 'enum'; key: string; label: string; options: readonly string[] }
  | { kind: 'asset'; key: string; label: string; assetType: 'texture' };

export interface ComponentDefinition<T extends Component = Component> {
  type: string;
  /** Shown as the component header in the Inspector. */
  label: string;
  /** Fresh instance with defaults applied. */
  create(overrides?: Partial<T>): T;
  /** Inspector fields. May depend on current values (e.g. primitive-specific parameters). */
  fields(component: T): FieldSchema[];
  /** False for components an entity must not have two of. Defaults to false. */
  allowMultiple?: boolean;
  /** False hides it from the Inspector's "Add Component" menu (e.g. still-unimplemented types). */
  addable?: boolean;
}

const definitions = new Map<string, ComponentDefinition>();

export function registerComponent<T extends Component>(definition: ComponentDefinition<T>): void {
  definitions.set(definition.type, definition as ComponentDefinition);
}

export function getComponentDefinition(type: string): ComponentDefinition | undefined {
  return definitions.get(type);
}

export function listComponentDefinitions(): ComponentDefinition[] {
  return [...definitions.values()];
}

/**
 * Components whose type has no registered definition are still valid data — they round-trip
 * untouched so a scene from a newer build survives an older one. See ARCHITECTURE.md §3.
 */
export function isKnownComponent(type: string): boolean {
  return definitions.has(type);
}
