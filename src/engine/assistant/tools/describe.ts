import { listComponentDefinitions } from '../../components/registry';
import { PRIMITIVE_TYPES, relevantParams, type PrimitiveType } from '../../mesh/generators';
import { listModifierDefinitions } from '../../mesh/modifiers/registry';
import { PREFAB_MENU } from '../../scene/prefabs';
import { registerTool } from '../ToolRegistry';
import { outlineScene, resolveEntity, summariseEntity } from './shared';

/** A whole scene of one-liners is cheaper than a truncated one the caller has to page through. */
const DEFAULT_OUTLINE_LIMIT = 200;

registerTool<{ limit: number }>({
  name: 'describe_scene',
  title: 'Describe scene',
  description:
    'The scene as an indented hierarchy: every entity with its id, name, primitive, position ' +
    'and extra components. Call this first — every other tool takes ids from here.',
  readOnly: true,
  input: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        description: 'Maximum entities to list.',
        minimum: 1,
        maximum: 2000,
        default: DEFAULT_OUTLINE_LIMIT,
      },
    },
  },
  run({ limit }, { editor }) {
    const { scene } = editor;
    if (scene.size === 0) return 'The scene is empty.';
    const header = `Scene "${scene.name}" — ${scene.size} entities, chunk size ${scene.world.chunkSize} m.`;
    return `${header}\n${outlineScene(scene, limit)}`;
  },
});

registerTool<{ entity: string }>({
  name: 'get_entity',
  title: 'Get entity',
  description:
    'Everything about one entity as JSON — transform, every component and its current values, ' +
    'parent and children. Use it before editing a component so you write real field names.',
  readOnly: true,
  input: {
    type: 'object',
    properties: { entity: { type: 'string', description: 'Entity id, or an exact entity name.' } },
    required: ['entity'],
  },
  run({ entity: reference }, { editor }) {
    const entity = resolveEntity(editor.scene, reference);
    return JSON.stringify(
      {
        ...entity,
        childIds: editor.scene.childrenOf(entity.id),
        chunk: editor.scene.chunkKeyOf(entity.id),
      },
      null,
      2,
    );
  },
});

registerTool<{ name?: string; component?: string; primitive?: string }>({
  name: 'find_entities',
  title: 'Find entities',
  description:
    'Entities matching a name fragment (case-insensitive), a component type, or a primitive ' +
    'kind. Filters combine with AND. With no filters it returns everything.',
  readOnly: true,
  input: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Case-insensitive substring of the entity name.' },
      component: { type: 'string', description: 'Component type, e.g. "Light" or "NpcAgent".' },
      primitive: { type: 'string', description: 'Primitive kind, e.g. "Box".', enum: PRIMITIVE_TYPES },
    },
  },
  run({ name, component, primitive }, { editor }) {
    const needle = name?.toLowerCase();
    const matches = editor.scene.all().filter((entity) => {
      if (needle && !entity.name.toLowerCase().includes(needle)) return false;
      if (component && !entity.components.some((c) => c.type === component)) return false;
      if (primitive) {
        const renderer = entity.components.find((c) => c.type === 'MeshRenderer');
        if (renderer?.primitive !== primitive) return false;
      }
      return true;
    });

    if (matches.length === 0) return 'No entities matched.';
    return `${matches.length} match(es):\n${matches.map(summariseEntity).join('\n')}`;
  },
});

/**
 * What the scene *can* contain, read out of the same registries the Inspector builds itself
 * from.
 *
 * Every alternative is worse. Baking the lists into tool descriptions means they go stale the
 * first time someone adds a modifier; leaving them out means the caller guesses component and
 * field names and gets them wrong. Reading the registry means a new `registerComponent` call is
 * visible to the assistant with no edit here — the same payoff ARCHITECTURE.md §3 claims for
 * the Inspector.
 */
registerTool<{ area: string }>({
  name: 'list_capabilities',
  title: 'List capabilities',
  description:
    'What this engine can build: primitive kinds and their parameters, gameplay prefabs, ' +
    'component types with their editable fields, and modifier types. Call it before ' +
    'add_component, set_component_property or add_modifier so you use real names.',
  readOnly: true,
  input: {
    type: 'object',
    properties: {
      area: {
        type: 'string',
        description: 'Which list to return.',
        enum: ['all', 'primitives', 'prefabs', 'components', 'modifiers'],
        default: 'all',
      },
    },
  },
  run({ area }) {
    const sections: string[] = [];

    if (area === 'all' || area === 'primitives') {
      const lines = PRIMITIVE_TYPES.map(
        (primitive: PrimitiveType) => `  ${primitive}: ${relevantParams(primitive).join(', ')}`,
      );
      sections.push(`PRIMITIVES (create_primitive; params go in "params")\n${lines.join('\n')}`);
    }

    if (area === 'all' || area === 'prefabs') {
      sections.push(`PREFABS (create_prefab)\n  ${PREFAB_MENU.join(', ')}`);
    }

    if (area === 'all' || area === 'components') {
      const lines = listComponentDefinitions().map((definition) => {
        // Field keys depend on current values (a Box has no `radius`), so a default instance is
        // the honest answer to "what can I set" without an entity to point at.
        const fields = definition.fields(definition.create()).map((field) => `${field.key}:${field.kind}`);
        return `  ${definition.type} — ${fields.join(', ')}`;
      });
      sections.push(`COMPONENTS (add_component, set_component_property)\n${lines.join('\n')}`);
    }

    if (area === 'all' || area === 'modifiers') {
      const lines = listModifierDefinitions().map((definition) => {
        const fields = definition.fields(definition.create()).map((field) => `${field.key}:${field.kind}`);
        return `  ${definition.type} — ${fields.join(', ')}`;
      });
      sections.push(`MODIFIERS (add_modifier)\n${lines.join('\n')}`);
    }

    return sections.join('\n\n');
  },
});
