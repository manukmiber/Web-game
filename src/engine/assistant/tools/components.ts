import { getComponentDefinition, listComponentDefinitions } from '../../components/registry';
import type { ScriptComponent, ScriptPropValue } from '../../components/Script';
import { readPath } from '../../scene/paths';
import type { Component } from '../../scene/types';
import { registerTool } from '../ToolRegistry';
import { resolveEntities, resolveEntity } from './shared';

function componentTypes(): string[] {
  return listComponentDefinitions().map((definition) => definition.type);
}

function expectDefinition(type: string) {
  const definition = getComponentDefinition(type);
  if (!definition) {
    throw new Error(`No component type "${type}". Known types: ${componentTypes().join(', ')}.`);
  }
  return definition;
}

/**
 * Checks a field path against the component's own field schema.
 *
 * The registry already knows every editable field — the Inspector is built from it — so a
 * typo'd path can be answered with the real list instead of writing a stray property into the
 * scene document, where it would round-trip forever and never do anything. Script `props` are
 * the deliberate exception: they are author-declared, so any key under `props.` is legitimate.
 */
function checkPath(component: Component, path: string): void {
  if (path.startsWith('props.')) return;
  const definition = expectDefinition(component.type);
  const keys = definition.fields(component).map((field) => field.key);
  if (keys.includes(path)) return;
  throw new Error(`${component.type} has no field "${path}". It has: ${keys.join(', ')}.`);
}

registerTool<{ entity: string; component: string; properties: Record<string, unknown> }>({
  name: 'add_component',
  title: 'Add component',
  description:
    'Attaches a component to an entity — Light, Camera, Script, NpcAgent, CharacterController, ' +
    'Environment, Material. Call list_capabilities for the types and their fields.',
  input: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'Id or name.' },
      component: { type: 'string', description: 'Component type.' },
      properties: {
        type: 'object',
        description: 'Initial field values, e.g. {"lightType": "Point", "intensity": 3}.',
        properties: {},
        additionalProperties: true,
      },
    },
    required: ['entity', 'component'],
  },
  run({ entity: reference, component: type, properties }, { editor }) {
    const entity = resolveEntity(editor.scene, reference);
    const definition = expectDefinition(type);
    if (entity.components.some((existing) => existing.type === type) && !definition.allowMultiple) {
      throw new Error(`"${entity.name}" already has a ${type}.`);
    }

    const created = definition.create(properties as never);
    // Validate after creating, so the check runs against the schema the finished component
    // reports rather than the one an empty default would.
    for (const key of Object.keys(properties ?? {})) checkPath(created, key);

    return editor.batch(`Add ${type}`, () => {
      editor.addComponent(entity.id, created);
      return `Added ${type} to "${entity.name}".\n${JSON.stringify(created, null, 2)}`;
    });
  },
});

registerTool<{ entity: string; component: string }>({
  name: 'remove_component',
  title: 'Remove component',
  description: 'Detaches a component from an entity.',
  input: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'Id or name.' },
      component: { type: 'string', description: 'Component type to remove.' },
    },
    required: ['entity', 'component'],
  },
  run({ entity: reference, component: type }, { editor }) {
    const entity = resolveEntity(editor.scene, reference);
    if (!entity.components.some((existing) => existing.type === type)) {
      throw new Error(`"${entity.name}" has no ${type}. It has: ${entity.components.map((c) => c.type).join(', ')}.`);
    }
    return editor.batch(`Remove ${type}`, () => {
      editor.removeComponent(entity.id, type);
      return `Removed ${type} from "${entity.name}".`;
    });
  },
});

registerTool<{ entities: string[]; component: string; path: string; value: unknown }>({
  name: 'set_component_property',
  title: 'Set component property',
  description:
    'Writes one field on a component, on one or many entities at once. Paths are dotted: ' +
    '"color", "params.width", "intensity", "props.speed". Call get_entity or ' +
    'list_capabilities first if you are unsure of the field name.',
  input: {
    type: 'object',
    properties: {
      entities: {
        type: 'array',
        description: 'Ids or names to write to.',
        items: { type: 'string' },
        minItems: 1,
      },
      component: { type: 'string', description: 'Component type, e.g. "Material".' },
      path: { type: 'string', description: 'Dotted field path, e.g. "params.radius".' },
      value: { description: 'The new value. Type must match the field.' },
    },
    required: ['entities', 'component', 'path', 'value'],
  },
  run({ entities: references, component: type, path, value }, { editor }) {
    const targets = resolveEntities(editor.scene, references);
    expectDefinition(type);

    const missing = targets.filter((entity) => !entity.components.some((c) => c.type === type));
    if (missing.length > 0) {
      throw new Error(`No ${type} on: ${missing.map((entity) => entity.name).join(', ')}. Use add_component first.`);
    }
    for (const entity of targets) {
      checkPath(entity.components.find((c) => c.type === type)!, path);
    }

    return editor.batch(`Set ${type}.${path}`, () => {
      editor.setComponentProperty(
        targets.map((entity) => entity.id),
        type,
        path,
        value,
      );
      const written = targets.map((entity) => editor.scene.expect(entity.id));
      const sample = readPath(written[0]!.components.find((c) => c.type === type)!, path);
      return `Set ${type}.${path} to ${JSON.stringify(sample)} on ${written.length} entity(s).`;
    });
  },
});

/**
 * Scripts get their own tool rather than going through `set_component_property`.
 *
 * Source and props change together — a script referencing `props.speed` is broken until the
 * prop exists — and writing them as two separate calls leaves a window where the behaviour
 * throws on every frame. One call, one undo entry, one consistent state.
 */
registerTool<{ entity: string; source?: string; name?: string; props?: Record<string, unknown> }>({
  name: 'set_script',
  title: 'Set script',
  description:
    'Writes a Script component: source, display name and props together. Adds the component if ' +
    'the entity has none. Scripts run in Play mode with entity, scene, input, time, props, ' +
    'game and console in scope; define start(), update(dt) and destroy() as plain functions. ' +
    'Props are the per-entity tunables the source reads as props.<name>.',
  input: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'Id or name.' },
      source: { type: 'string', description: 'The script body.' },
      name: { type: 'string', description: 'Display name shown in the console and Inspector.' },
      props: {
        type: 'object',
        description: 'Tunables, numbers/strings/booleans only. Replaces the existing set.',
        properties: {},
        additionalProperties: true,
      },
    },
    required: ['entity'],
  },
  run({ entity: reference, source, name, props }, { editor }) {
    const entity = resolveEntity(editor.scene, reference);
    if (source === undefined && name === undefined && props === undefined) {
      throw new Error('Give at least one of source, name or props.');
    }

    const checked: Record<string, ScriptPropValue> = {};
    for (const [key, value] of Object.entries(props ?? {})) {
      if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') {
        // Only these survive a round-trip through scene JSON, which is why the component
        // declares them and why anything else has to be rejected rather than quietly saved.
        throw new Error(`props.${key} must be a number, string or boolean.`);
      }
      checked[key] = value;
    }

    const definition = expectDefinition('Script');
    const existing = entity.components.find((component) => component.type === 'Script') as
      | ScriptComponent
      | undefined;

    return editor.batch(existing ? 'Edit script' : 'Add script', () => {
      if (!existing) {
        editor.addComponent(
          entity.id,
          definition.create({
            ...(source !== undefined ? { source } : {}),
            ...(name !== undefined ? { name } : {}),
            ...(props !== undefined ? { props: checked } : {}),
          } as never),
        );
      } else {
        if (source !== undefined) editor.setComponentProperty([entity.id], 'Script', 'source', source);
        if (name !== undefined) editor.setComponentProperty([entity.id], 'Script', 'name', name);
        if (props !== undefined) editor.setComponentProperty([entity.id], 'Script', 'props', checked);
      }
      const script = editor.scene.getComponent<ScriptComponent>(entity.id, 'Script')!;
      return `Script "${script.name}" on "${entity.name}" — props ${JSON.stringify(script.props)}. Press Play to run it.`;
    });
  },
});
