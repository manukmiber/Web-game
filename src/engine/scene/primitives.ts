import { createMaterial } from '../components/Material';
import { createMeshRenderer, type PrimitiveType } from '../components/MeshRenderer';
import { generateEntityId } from './Scene';
import { createTransform, type Entity, type Vec3 } from './types';

export type PrimitiveKind = PrimitiveType | 'Empty';

/** Matches Unity's GameObject > 3D Object menu ordering. */
export const PRIMITIVE_MENU: readonly PrimitiveKind[] = [
  'Box',
  'Sphere',
  'Plane',
  'Cylinder',
  'Capsule',
  'Cone',
  'Empty',
];

const DEFAULT_NAMES: Record<PrimitiveKind, string> = {
  Box: 'Box',
  Sphere: 'Sphere',
  Plane: 'Plane',
  Cylinder: 'Cylinder',
  Capsule: 'Capsule',
  Cone: 'Cone',
  Empty: 'Empty',
};

/**
 * Default geometry per primitive, sized so a fresh object reads at a sensible scale next to
 * the 1 m grid. Plane gets 10x10 because it is nearly always used as ground.
 */
const DEFAULT_PARAMS: Partial<Record<PrimitiveKind, Record<string, number>>> = {
  Plane: { width: 10, height: 10 },
  Capsule: { radius: 0.5, height: 1 },
  Cylinder: { radiusTop: 0.5, radiusBottom: 0.5, height: 1 },
  Cone: { radius: 0.5, height: 1 },
};

export interface CreatePrimitiveOptions {
  name?: string;
  position?: Vec3;
  parentId?: string | null;
  color?: string;
}

/**
 * Builds the entity for a primitive. An Empty gets only a Transform — that is the whole point
 * of it, it exists to be a parent/group node.
 */
export function createPrimitiveEntity(
  kind: PrimitiveKind,
  options: CreatePrimitiveOptions = {},
): Entity {
  const entity: Entity = {
    id: generateEntityId(),
    name: options.name ?? DEFAULT_NAMES[kind],
    parentId: options.parentId ?? null,
    transform: createTransform(options.position ?? [0, 0, 0]),
    components: [],
  };

  if (kind !== 'Empty') {
    entity.components.push(
      createMeshRenderer({ primitive: kind, params: DEFAULT_PARAMS[kind] as never }),
      createMaterial(options.color ? { color: options.color } : {}),
    );
  }

  return entity;
}

/**
 * "Box", "Box (1)", "Box (2)" — Unity-style disambiguation so duplicating never produces two
 * identically named siblings.
 */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const existing = new Set(taken);
  if (!existing.has(base)) return base;
  // Strip an existing " (n)" suffix so duplicating "Box (1)" gives "Box (2)", not "Box (1) (1)".
  const stem = base.replace(/ \(\d+\)$/, '');
  for (let i = 1; ; i += 1) {
    const candidate = `${stem} (${i})`;
    if (!existing.has(candidate)) return candidate;
  }
}
