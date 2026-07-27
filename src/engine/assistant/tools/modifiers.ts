import type { MeshRendererComponent } from '../../components/MeshRenderer';
import { getModifierDefinition, listModifierDefinitions, type Modifier } from '../../mesh/modifiers/registry';
import type { EntityId } from '../../scene/types';
import { registerTool } from '../ToolRegistry';
import type { SceneEditor } from '../SceneEditor';
import { resolveEntity } from './shared';

function modifierTypes(): string[] {
  return listModifierDefinitions().map((definition) => definition.type);
}

/**
 * The stack lives on the MeshRenderer, so every edit here is a whole-array write through
 * `set_component_property`'s machinery.
 *
 * Writing the array rather than adding a mutate-in-place API keeps the modifier tools on
 * exactly the same undo and change-notification path as every other component edit — the
 * render bridge re-evaluates because `componentsChanged` fired, not because these tools
 * remembered to tell it.
 */
function stackOf(editor: SceneEditor, id: EntityId): Modifier[] {
  const renderer = editor.scene.getComponent<MeshRendererComponent>(id, 'MeshRenderer');
  if (!renderer) throw new Error('That entity has no MeshRenderer, so it has no modifier stack.');
  return renderer.modifiers.map((modifier) => ({ ...modifier }));
}

function describeStack(stack: readonly Modifier[]): string {
  if (stack.length === 0) return 'The stack is now empty.';
  return stack
    .map((modifier, index) => `  ${index}: ${modifier.type}${modifier.enabled === false ? ' (disabled)' : ''}`)
    .join('\n');
}

registerTool<{ entity: string; modifier: string; properties: Record<string, unknown>; index?: number }>({
  name: 'add_modifier',
  title: 'Add modifier',
  description:
    'Pushes a non-destructive modifier onto an entity\'s stack — Subdivide, Bevel, Extrude, ' +
    'Lathe, Mirror, Array, Solidify, Twist, Bend, Taper and the rest. Order matters: the stack ' +
    'runs top to bottom, so Mirror then Array tiles a mirrored pair while Array then Mirror ' +
    'mirrors a whole row. Extrude and Lathe need an open surface, so start from a 2D shape.',
  input: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'Id or name.' },
      modifier: { type: 'string', description: 'Modifier type.' },
      properties: {
        type: 'object',
        description: 'Initial values, e.g. {"levels": 2}.',
        properties: {},
        additionalProperties: true,
      },
      index: { type: 'integer', description: 'Position in the stack. Appends when omitted.', minimum: 0 },
    },
    required: ['entity', 'modifier'],
  },
  run({ entity: reference, modifier: type, properties, index }, { editor }) {
    const entity = resolveEntity(editor.scene, reference);
    const definition = getModifierDefinition(type);
    if (!definition) {
      throw new Error(`No modifier type "${type}". Known types: ${modifierTypes().join(', ')}.`);
    }

    const created = definition.create(properties as never);
    const keys = definition.fields(created).map((field) => field.key);
    for (const key of Object.keys(properties ?? {})) {
      if (key !== 'enabled' && !keys.includes(key)) {
        throw new Error(`${type} has no field "${key}". It has: ${keys.join(', ')}.`);
      }
    }

    const stack = stackOf(editor, entity.id);
    stack.splice(index ?? stack.length, 0, created);

    return editor.batch(`Add ${type}`, () => {
      editor.setComponentProperty([entity.id], 'MeshRenderer', 'modifiers', stack);
      return `Added ${type} to "${entity.name}".\n${describeStack(stack)}`;
    });
  },
});

registerTool<{ entity: string; index: number }>({
  name: 'remove_modifier',
  title: 'Remove modifier',
  description: 'Removes one entry from an entity\'s modifier stack by its index.',
  input: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'Id or name.' },
      index: { type: 'integer', description: 'Stack index, from get_entity.', minimum: 0 },
    },
    required: ['entity', 'index'],
  },
  run({ entity: reference, index }, { editor }) {
    const entity = resolveEntity(editor.scene, reference);
    const stack = stackOf(editor, entity.id);
    if (index >= stack.length) {
      throw new Error(`"${entity.name}" has ${stack.length} modifier(s), so index ${index} does not exist.`);
    }
    const [removed] = stack.splice(index, 1);

    return editor.batch(`Remove ${removed!.type}`, () => {
      editor.setComponentProperty([entity.id], 'MeshRenderer', 'modifiers', stack);
      return `Removed ${removed!.type} from "${entity.name}".\n${describeStack(stack)}`;
    });
  },
});

registerTool<{ entity: string; index: number; field: string; value: unknown }>({
  name: 'set_modifier_property',
  title: 'Set modifier property',
  description: 'Changes one field on one modifier in the stack — a Subdivide level, a Bevel width.',
  input: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'Id or name.' },
      index: { type: 'integer', description: 'Stack index.', minimum: 0 },
      field: { type: 'string', description: 'Field name, e.g. "levels". "enabled" toggles it off.' },
      value: { description: 'New value.' },
    },
    required: ['entity', 'index', 'field', 'value'],
  },
  run({ entity: reference, index, field, value }, { editor }) {
    const entity = resolveEntity(editor.scene, reference);
    const stack = stackOf(editor, entity.id);
    const modifier = stack[index];
    if (!modifier) {
      throw new Error(`"${entity.name}" has ${stack.length} modifier(s), so index ${index} does not exist.`);
    }

    const definition = getModifierDefinition(modifier.type);
    const keys = definition?.fields(modifier).map((schema) => schema.key) ?? [];
    if (field !== 'enabled' && !keys.includes(field)) {
      throw new Error(`${modifier.type} has no field "${field}". It has: ${keys.join(', ')}.`);
    }
    stack[index] = { ...modifier, [field]: value };

    return editor.batch(`Set ${modifier.type}.${field}`, () => {
      editor.setComponentProperty([entity.id], 'MeshRenderer', 'modifiers', stack);
      return `Set ${modifier.type}.${field} to ${JSON.stringify(value)} on "${entity.name}".`;
    });
  },
});
