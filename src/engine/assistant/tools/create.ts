import { relevantParams, type PrimitiveParams, type PrimitiveType } from '../../mesh/generators';
import { createPrefab, PREFAB_MENU, type PrefabKind } from '../../scene/prefabs';
import { createPrimitiveEntity, PRIMITIVE_MENU, type PrimitiveKind } from '../../scene/primitives';
import { generateEntityId, type Scene } from '../../scene/Scene';
import type { Entity, EntityId, Vec3 } from '../../scene/types';
import { registerTool } from '../ToolRegistry';
import { vec3Schema } from '../schema';
import { report, resolveEntity } from './shared';

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function checkColor(color: string | undefined): void {
  if (color !== undefined && !COLOR_PATTERN.test(color)) {
    throw new Error(`Colour must be "#rrggbb", got "${color}".`);
  }
}

/**
 * Rejects unknown primitive parameters instead of dropping them.
 *
 * A silently ignored `params.size` on a Box is the worst outcome available: the tool reports
 * success, the box is the wrong size, and the caller has no way to find out. Naming the
 * parameters that *do* apply turns a dead end into a one-line fix.
 */
function checkedParams(kind: PrimitiveKind, params: Record<string, unknown>): Partial<PrimitiveParams> {
  if (kind === 'Empty') {
    if (Object.keys(params).length > 0) throw new Error('An Empty has no geometry parameters.');
    return {};
  }
  const valid = relevantParams(kind as PrimitiveType);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!valid.includes(key as keyof PrimitiveParams)) {
      throw new Error(`${kind} has no parameter "${key}". It takes: ${valid.join(', ')}.`);
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) throw new Error(`params.${key} must be a number, got ${String(value)}.`);
    out[key] = numeric;
  }
  return out as Partial<PrimitiveParams>;
}

registerTool<{
  kind: string;
  name?: string;
  position?: number[];
  rotation?: number[];
  scale?: number[];
  parent?: string;
  color?: string;
  params: Record<string, unknown>;
}>({
  name: 'create_primitive',
  title: 'Create primitive',
  description:
    'Adds one primitive — a 3D solid (Box, Sphere, Cylinder, …), a flat 2D profile to extrude ' +
    'or lathe later (Circle, Rectangle, Star, …), or an Empty to group things under. ' +
    'Omit position to place it where the viewport camera is looking. ' +
    'Call list_capabilities for the parameters each kind takes.',
  input: {
    type: 'object',
    properties: {
      kind: { type: 'string', description: 'Primitive kind.', enum: PRIMITIVE_MENU },
      name: { type: 'string', description: 'Entity name. Defaults to the kind.' },
      position: vec3Schema('World position [x, y, z]. Defaults to where the camera is looking.'),
      rotation: vec3Schema('Euler rotation in degrees [x, y, z].'),
      scale: vec3Schema('Scale [x, y, z].'),
      parent: { type: 'string', description: 'Id or name of the parent entity.' },
      color: { type: 'string', description: 'Material colour as "#rrggbb".' },
      params: {
        type: 'object',
        description: 'Geometry parameters for this kind, e.g. {"width": 2, "height": 3}.',
        properties: {},
        additionalProperties: true,
      },
    },
    required: ['kind'],
  },
  run(input, context) {
    const { editor, spawnPoint } = context;
    checkColor(input.color);
    const params = checkedParams(input.kind as PrimitiveKind, input.params ?? {});
    const parent = input.parent ? resolveEntity(editor.scene, input.parent) : undefined;

    return editor.batch(`Create ${input.kind}`, () => {
      const entity = createPrimitiveEntity(input.kind as PrimitiveKind, {
        name: input.name ?? input.kind,
        position: (input.position as Vec3) ?? spawnPoint(),
        parentId: parent?.id ?? null,
        color: input.color,
      });
      if (input.rotation) entity.transform.rotation = input.rotation as Vec3;
      if (input.scale) entity.transform.scale = input.scale as Vec3;

      const renderer = entity.components.find((component) => component.type === 'MeshRenderer');
      if (renderer) Object.assign(renderer.params as object, params);

      editor.add([entity]);
      editor.select([entity.id]);
      return report('Created', [editor.scene.expect(entity.id)]);
    });
  },
});

registerTool<{ kind: string; name?: string; position?: number[] }>({
  name: 'create_prefab',
  title: 'Create prefab',
  description:
    'Adds a ready-made gameplay object: Player (a character with a follow camera), Zombie, ' +
    'Villager, Animal, Camera, lights, Environment, or Game Logic (a spawner script). ' +
    'Prefer this over assembling the same thing from components.',
  input: {
    type: 'object',
    properties: {
      kind: { type: 'string', description: 'Prefab kind.', enum: PREFAB_MENU },
      name: { type: 'string', description: 'Name for the root entity.' },
      position: vec3Schema('World position. Defaults to where the camera is looking.'),
    },
    required: ['kind'],
  },
  run({ kind, name, position }, { editor, spawnPoint }) {
    return editor.batch(`Create ${kind}`, () => {
      const entities = createPrefab(kind as PrefabKind, {
        position: (position as Vec3) ?? spawnPoint(),
        ...(name ? { name } : {}),
      });
      editor.add(entities);
      const roots = entities.filter((entity) => entity.parentId === null).map((entity) => entity.id);
      editor.select(roots);
      return report(
        'Created',
        roots.map((id) => editor.scene.expect(id)),
      );
    });
  },
});

registerTool<{ entity: string; count: number; offset?: number[] }>({
  name: 'duplicate_entity',
  title: 'Duplicate entity',
  description:
    'Copies an entity and everything under it, optionally several times with each copy offset ' +
    'from the last. The cheap way to build a row of fence posts or a stack of crates.',
  input: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'Id or name of the entity to copy.' },
      count: { type: 'integer', description: 'How many copies.', minimum: 1, maximum: 200, default: 1 },
      offset: vec3Schema('Offset applied cumulatively, so copy n sits at n × offset.'),
    },
    required: ['entity'],
  },
  run({ entity: reference, count, offset }, { editor }) {
    const source = resolveEntity(editor.scene, reference);
    const step = (offset as Vec3) ?? [0, 0, 0];

    return editor.batch(`Duplicate ${source.name}`, () => {
      const created: Entity[] = [];
      for (let index = 1; index <= count; index += 1) {
        const copy = cloneSubtree(editor.scene, source.id);
        const root = copy[0]!;
        root.transform.position = [
          source.transform.position[0] + step[0] * index,
          source.transform.position[1] + step[1] * index,
          source.transform.position[2] + step[2] * index,
        ];
        editor.add(copy);
        created.push(editor.scene.expect(root.id));
      }
      editor.select(created.map((entity) => entity.id));
      return report(`Duplicated ${source.name}`, created);
    });
  },
});

/**
 * Deep-copies a subtree with fresh ids, rewriting internal parent references so the copy is
 * self-contained. Root first, because `Scene.add` rejects a child whose parent is not there yet.
 */
function cloneSubtree(scene: Scene, rootId: EntityId): Entity[] {
  const ids = scene.subtreeOf(rootId);
  const remap = new Map(ids.map((id) => [id, generateEntityId()]));
  return ids.map((id) => {
    const copy = structuredClone(scene.expect(id));
    copy.id = remap.get(id)!;
    copy.parentId = copy.parentId ? (remap.get(copy.parentId) ?? copy.parentId) : null;
    return copy;
  });
}
