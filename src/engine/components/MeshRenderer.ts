import type { Component } from '../scene/types';
import {
  DEFAULT_PRIMITIVE_PARAMS,
  PRIMITIVE_TYPES,
  relevantParams,
  type PrimitiveParams,
  type PrimitiveType,
} from '../mesh/generators';
import type { Modifier } from '../mesh/modifiers/registry';
import { registerComponent, type FieldSchema } from './registry';

export { PRIMITIVE_TYPES, DEFAULT_PRIMITIVE_PARAMS, relevantParams };
export type { PrimitiveType, PrimitiveParams };

export interface MeshRendererComponent extends Component {
  type: 'MeshRenderer';
  primitive: PrimitiveType;
  params: PrimitiveParams;
  /**
   * Non-destructive modifier stack, evaluated in order over the generated primitive.
   *
   * Lives on the renderer rather than in its own component because it is one pipeline: source
   * geometry in, final geometry out. Splitting it would make the ordering relationship between
   * the two components implicit.
   */
  modifiers: Modifier[];
  castShadow: boolean;
  receiveShadow: boolean;
  visible: boolean;
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
  depthSegments: 'Depth Segments',
  radialSegments: 'Radial Segments',
  capSegments: 'Cap Segments',
  tubeRadius: 'Tube Radius',
  tubularSegments: 'Tubular Segments',
  innerRadius: 'Inner Radius',
  subdivisions: 'Subdivisions',
  cornerRadius: 'Corner Radius',
  cornerSegments: 'Corner Segments',
  sides: 'Sides',
  points: 'Points',
  startAngle: 'Start Angle °',
  sweepAngle: 'Sweep Angle °',
  teeth: 'Teeth',
  toothDepth: 'Tooth Depth',
};

const SEGMENT_KEYS = new Set<keyof PrimitiveParams>([
  'widthSegments',
  'heightSegments',
  'depthSegments',
  'radialSegments',
  'capSegments',
  'tubularSegments',
  'cornerSegments',
  'sides',
  'points',
  'teeth',
]);

/** Angles are the only params that legitimately go negative. */
const ANGLE_KEYS = new Set<keyof PrimitiveParams>(['startAngle', 'sweepAngle']);

/** Counts that need more than one to describe anything. */
const MIN_COUNT: Partial<Record<keyof PrimitiveParams, number>> = {
  sides: 3,
  points: 3,
  teeth: 3,
};

/**
 * Sizes where zero is a real choice rather than a degenerate one: no corner rounding, no bore,
 * no teeth standing out. Every other dimension is clamped just above zero, because a
 * zero-radius sphere is nothing at all.
 */
const ZERO_ALLOWED = new Set<keyof PrimitiveParams>(['cornerRadius', 'innerRadius', 'toothDepth']);

/** Icosphere recursion is capped much lower — each level quadruples the triangle count. */
const RECURSION_KEYS = new Set<keyof PrimitiveParams>(['subdivisions']);

function lowerBound(key: keyof PrimitiveParams): number | undefined {
  if (ANGLE_KEYS.has(key)) return undefined;
  if (SEGMENT_KEYS.has(key)) return MIN_COUNT[key] ?? 1;
  if (RECURSION_KEYS.has(key) || ZERO_ALLOWED.has(key)) return 0;
  return 0.001;
}

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
    modifiers: overrides.modifiers ? overrides.modifiers.map((m) => ({ ...m })) : [],
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
      const isRecursion = RECURSION_KEYS.has(key);
      const isAngle = ANGLE_KEYS.has(key);
      fields.push({
        kind: 'number',
        key: `params.${key}`,
        label: PARAM_LABELS[key],
        min: lowerBound(key),
        // Segment counts are the direct lever on triangle count, so they are capped: a
        // 512-segment sphere behind a Subdivide modifier is millions of triangles.
        max: isSegment ? 256 : isRecursion ? 5 : undefined,
        step: isSegment || isRecursion ? 1 : isAngle ? 5 : 0.1,
        integer: isSegment || isRecursion,
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
