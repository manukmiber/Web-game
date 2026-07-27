import type { Transform, Vec3 } from '../../scene/types';
import { registerTool } from '../ToolRegistry';
import { vec3Schema } from '../schema';
import { report, resolveEntities, resolveEntity, summariseEntity } from './shared';

registerTool<{ entities: string[] }>({
  name: 'delete_entities',
  title: 'Delete entities',
  description: 'Removes entities and everything parented under them.',
  input: {
    type: 'object',
    properties: {
      entities: {
        type: 'array',
        description: 'Ids or names to delete.',
        items: { type: 'string' },
        minItems: 1,
      },
    },
    required: ['entities'],
  },
  run({ entities: references }, { editor }) {
    const targets = resolveEntities(editor.scene, references);
    return editor.batch(targets.length === 1 ? 'Delete entity' : `Delete ${targets.length} entities`, () => {
      const names = targets.map((entity) => `${entity.name} (${entity.id})`);
      editor.remove(targets.map((entity) => entity.id));
      editor.select([]);
      return `Deleted ${names.join(', ')}.`;
    });
  },
});

registerTool<{ entity: string; name: string }>({
  name: 'rename_entity',
  title: 'Rename entity',
  description: 'Renames one entity. Names stay unique scene-wide, so a clash gets a " (n)" suffix.',
  input: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'Id or current name.' },
      name: { type: 'string', description: 'New name.' },
    },
    required: ['entity', 'name'],
  },
  run({ entity: reference, name }, { editor }) {
    const entity = resolveEntity(editor.scene, reference);
    const previous = entity.name;
    return editor.batch('Rename entity', () => {
      editor.rename(entity.id, name);
      return `Renamed "${previous}" to "${editor.scene.expect(entity.id).name}".`;
    });
  },
});

registerTool<{
  entity: string;
  position?: number[];
  rotation?: number[];
  scale?: number[];
  relative: boolean;
}>({
  name: 'set_transform',
  title: 'Set transform',
  description:
    'Moves, rotates or scales an entity. Rotation is Euler degrees, XYZ order, and -Z is ' +
    'forward for cameras, lights and characters. Set relative to add to the current values ' +
    'instead of replacing them.',
  input: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'Id or name.' },
      position: vec3Schema('Position [x, y, z].'),
      rotation: vec3Schema('Euler rotation in degrees [x, y, z].'),
      scale: vec3Schema('Scale [x, y, z]. Multiplied, not added, when relative.'),
      relative: {
        type: 'boolean',
        description: 'Treat the values as deltas from the current transform.',
        default: false,
      },
    },
    required: ['entity'],
  },
  run({ entity: reference, position, rotation, scale, relative }, { editor }) {
    const entity = resolveEntity(editor.scene, reference);
    if (!position && !rotation && !scale) throw new Error('Give at least one of position, rotation or scale.');

    const current = entity.transform;
    const patch: Partial<Transform> = {};
    if (position) patch.position = combine(current.position, position as Vec3, relative, 'add');
    if (rotation) patch.rotation = combine(current.rotation, rotation as Vec3, relative, 'add');
    if (scale) patch.scale = combine(current.scale, scale as Vec3, relative, 'multiply');

    return editor.batch('Transform', () => {
      editor.setTransform(entity.id, patch);
      return report('Transformed', [editor.scene.expect(entity.id)]);
    });
  },
});

/** Scale composes by multiplication; a relative scale of [2,2,2] means "twice as big". */
function combine(current: Vec3, value: Vec3, relative: boolean, mode: 'add' | 'multiply'): Vec3 {
  if (!relative) return [...value];
  if (mode === 'multiply') {
    return [current[0] * value[0], current[1] * value[1], current[2] * value[2]];
  }
  return [current[0] + value[0], current[1] + value[1], current[2] + value[2]];
}

registerTool<{ entities: string[]; parent?: string }>({
  name: 'reparent_entities',
  title: 'Reparent entities',
  description:
    'Moves entities under a new parent, or to the scene root when parent is omitted. ' +
    'Child transforms are relative to the parent, so this is how you build a rig — a camera ' +
    'under a character rides along with it.',
  input: {
    type: 'object',
    properties: {
      entities: {
        type: 'array',
        description: 'Ids or names to move.',
        items: { type: 'string' },
        minItems: 1,
      },
      parent: { type: 'string', description: 'Id or name of the new parent. Omit for the scene root.' },
    },
    required: ['entities'],
  },
  run({ entities: references, parent }, { editor }) {
    const targets = resolveEntities(editor.scene, references);
    const newParent = parent ? resolveEntity(editor.scene, parent) : null;

    for (const entity of targets) {
      if (newParent && (newParent.id === entity.id || editor.scene.isDescendantOf(newParent.id, entity.id))) {
        throw new Error(`Cannot parent "${entity.name}" under its own descendant.`);
      }
    }

    return editor.batch('Reparent', () => {
      editor.reparent(
        targets.map((entity) => entity.id),
        newParent?.id ?? null,
      );
      return `Moved ${targets.map((entity) => entity.name).join(', ')} under ${
        newParent ? `"${newParent.name}"` : 'the scene root'
      }.`;
    });
  },
});

registerTool<{ entities: string[] }>({
  name: 'select_entities',
  title: 'Select entities',
  description:
    'Selects entities in the editor, which is what puts the gizmo on them and shows them in ' +
    'the Inspector. Use it to point at what you just talked about. No effect outside the editor.',
  input: {
    type: 'object',
    properties: {
      entities: { type: 'array', description: 'Ids or names. Empty clears the selection.', items: { type: 'string' } },
    },
    required: ['entities'],
  },
  run({ entities: references }, { editor }) {
    const targets = resolveEntities(editor.scene, references);
    editor.select(targets.map((entity) => entity.id));
    if (targets.length === 0) return 'Cleared the selection.';
    return `Selected:\n${targets.map(summariseEntity).join('\n')}`;
  },
});
