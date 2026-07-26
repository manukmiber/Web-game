import type { Component } from '../scene/types';
import { registerComponent, type FieldSchema } from './registry';

export const PRIMITIVE_TYPES = ['Box', 'Sphere', 'Plane', 'Cylinder', 'Capsule', 'Cone'] as const;
export type PrimitiveType = (typeof PRIMITIVE_TYPES)[number];

/**
 * Geometry parameters, flattened into one bag rather than a per-primitive union.
 *
 * Flat keeps serialisation trivial and lets `fields()` expose only the subset that applies to
 * the current primitive — switching Box→Sphere keeps the segment counts you already set, which
 * is what you want while iterating in the editor.
 */
export interface PrimitiveParams {
  width: number;
  height: number;
  depth: number;
  radius: number;
  radiusTop: number;
  radiusBottom: number;
  widthSegments: number;
  heightSegments: number;
  radialSegments: number;
  capSegments: number;
}

export interface MeshRendererComponent extends Component {
  type: 'MeshRenderer';
  primitive: PrimitiveType;
  params: PrimitiveParams;
  castShadow: boolean;
  receiveShadow: boolean;
  visible: boolean;
}

export const DEFAULT_PRIMITIVE_PARAMS: PrimitiveParams = {
  width: 1,
  height: 1,
  depth: 1,
  radius: 0.5,
  radiusTop: 0.5,
  radiusBottom: 0.5,
  widthSegments: 32,
  heightSegments: 16,
  radialSegments: 32,
  capSegments: 8,
};

/** Which params each primitive actually consumes — drives both the Inspector and the cache key. */
const PARAMS_BY_PRIMITIVE: Record<PrimitiveType, (keyof PrimitiveParams)[]> = {
  Box: ['width', 'height', 'depth'],
  Sphere: ['radius', 'widthSegments', 'heightSegments'],
  Plane: ['width', 'height'],
  Cylinder: ['radiusTop', 'radiusBottom', 'height', 'radialSegments'],
  Capsule: ['radius', 'height', 'capSegments', 'radialSegments'],
  Cone: ['radius', 'height', 'radialSegments'],
};

export function relevantParams(primitive: PrimitiveType): (keyof PrimitiveParams)[] {
  return PARAMS_BY_PRIMITIVE[primitive];
}

const PARAM_LABELS: Record<keyof PrimitiveParams, string> = {
  width: 'Width',
  height: 'Height',
  depth: 'Depth',
  radius: 'Radius',
  radiusTop: 'Radius Top',
  radiusBottom: 'Radius Bottom',
  widthSegments: 'Width Segments',
  heightSegments: 'Height Segments',
  radialSegments: 'Radial Segments',
  capSegments: 'Cap Segments',
};

const SEGMENT_KEYS = new Set<keyof PrimitiveParams>([
  'widthSegments',
  'heightSegments',
  'radialSegments',
  'capSegments',
]);

export function createMeshRenderer(
  overrides: Partial<MeshRendererComponent> = {},
): MeshRendererComponent {
  return {
    type: 'MeshRenderer',
    primitive: 'Box',
    castShadow: true,
    receiveShadow: true,
    visible: true,
    ...overrides,
    params: { ...DEFAULT_PRIMITIVE_PARAMS, ...overrides.params },
  };
}

registerComponent<MeshRendererComponent>({
  type: 'MeshRenderer',
  label: 'Mesh Renderer',
  create: createMeshRenderer,
  fields(component) {
    const fields: FieldSchema[] = [
      { kind: 'enum', key: 'primitive', label: 'Primitive', options: PRIMITIVE_TYPES },
    ];
    for (const key of relevantParams(component.primitive)) {
      const isSegment = SEGMENT_KEYS.has(key);
      fields.push({
        kind: 'number',
        key: `params.${key}`,
        label: PARAM_LABELS[key],
        min: isSegment ? 1 : 0.001,
        step: isSegment ? 1 : 0.1,
        integer: isSegment,
      });
    }
    fields.push(
      { kind: 'boolean', key: 'visible', label: 'Visible' },
      { kind: 'boolean', key: 'castShadow', label: 'Cast Shadow' },
      { kind: 'boolean', key: 'receiveShadow', label: 'Receive Shadow' },
    );
    return fields;
  },
});
