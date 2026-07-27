import { createMaterial } from '../components/Material';
import { createMeshRenderer, type PrimitiveType } from '../components/MeshRenderer';
import { generateEntityId } from './Scene';
import { createTransform, type Entity, type Vec3 } from './types';

export type PrimitiveKind = PrimitiveType | 'Empty';

/** Solids, ordered roughly like Unity's GameObject > 3D Object menu. */
export const SOLID_MENU: readonly PrimitiveKind[] = [
  'Box',
  'Sphere',
  'Plane',
  'Cylinder',
  'Capsule',
  'Cone',
  'Torus',
  'Tube',
  'Icosphere',
  'Wedge',
  'Empty',
];

/**
 * Flat profiles. Separate from the solids in the menu because they are a different kind of
 * thing to reach for: a 2D shape is usually a step on the way to a solid, via Extrude or Lathe,
 * rather than the finished object.
 */
export const SHAPE_MENU: readonly PrimitiveKind[] = [
  'Circle',
  'Ellipse',
  'Rectangle',
  'Polygon',
  'Star',
  'Arc',
  'Ring',
  'Gear',
];

export const PRIMITIVE_MENU: readonly PrimitiveKind[] = [...SOLID_MENU, ...SHAPE_MENU];

/**
 * Default geometry per primitive, sized so a fresh object reads at a sensible scale next to
 * the 1 m grid. Plane gets 10x10 because it is nearly always used as ground.
 */
const DEFAULT_PARAMS: Partial<Record<PrimitiveKind, Record<string, number>>> = {
  // Plane lies in XZ, so its second axis is depth. Setting `height` here silently
  // left it at the default 1 and produced a 10x1 strip.
  Plane: { width: 10, depth: 10 },
  Capsule: { radius: 0.5, height: 1 },
  Cylinder: { radiusTop: 0.5, radiusBottom: 0.5, height: 1 },
  Cone: { radius: 0.5, height: 1 },
  Torus: { radius: 0.5, tubeRadius: 0.18 },
  Tube: { radius: 0.5, innerRadius: 0.3, height: 1 },
  Icosphere: { radius: 0.5, subdivisions: 2 },
  Wedge: { width: 1, height: 1, depth: 1 },
  Circle: { radius: 0.5 },
  Ellipse: { width: 1.4, depth: 1 },
  Rectangle: { width: 1, depth: 1, cornerRadius: 0 },
  Polygon: { radius: 0.5, sides: 6 },
  Star: { radius: 0.5, innerRadius: 0.22, points: 5 },
  Arc: { radius: 0.5, startAngle: 0, sweepAngle: 270 },
  Ring: { radius: 0.5, innerRadius: 0.3 },
  Gear: { radius: 0.5, toothDepth: 0.12, teeth: 12, innerRadius: 0.15 },
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
    name: options.name ?? kind,
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
