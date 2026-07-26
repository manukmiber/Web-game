import {
  cloneMeshData,
  flipFaces,
  mergeMeshes,
  weldVertices,
  type MeshData,
} from '../MeshData';
import { registerModifier, type Modifier } from './registry';

export const AXES = ['X', 'Y', 'Z'] as const;
export type Axis = (typeof AXES)[number];

export interface MirrorModifier extends Modifier {
  type: 'Mirror';
  axis: Axis;
  /** Welds vertices that land on the mirror plane, so the seam is one surface. */
  merge: boolean;
  mergeThreshold: number;
}

const AXIS_INDEX: Record<Axis, number> = { X: 0, Y: 1, Z: 2 };

export function mirror(mesh: MeshData, axis: Axis, merge = true, threshold = 1e-4): MeshData {
  const out = cloneMeshData(mesh);
  const reflected = cloneMeshData(mesh);
  const component = AXIS_INDEX[axis];

  for (let i = component; i < reflected.positions.length; i += 3) {
    reflected.positions[i] = -reflected.positions[i]!;
  }
  // Reflection reverses handedness, so without flipping, the mirrored half is inside out.
  flipFaces(reflected);

  mergeMeshes(out, reflected);
  // Merging matters more than it looks: an unwelded seam is invisible on a flat-shaded mesh
  // but becomes a hard crease the moment Subdivide or smooth shading runs after it.
  return merge ? weldVertices(out, threshold) : out;
}

export function createMirrorModifier(overrides: Partial<MirrorModifier> = {}): MirrorModifier {
  return {
    type: 'Mirror',
    enabled: true,
    axis: 'X',
    merge: true,
    mergeThreshold: 1e-4,
    ...overrides,
  };
}

registerModifier<MirrorModifier>({
  type: 'Mirror',
  label: 'Mirror',
  create: createMirrorModifier,
  fields: (modifier) => [
    { kind: 'enum', key: 'axis', label: 'Axis', options: AXES },
    { kind: 'boolean', key: 'merge', label: 'Merge Seam' },
    ...(modifier.merge
      ? ([
          {
            kind: 'number',
            key: 'mergeThreshold',
            label: 'Threshold',
            min: 0,
            step: 0.0001,
          },
        ] as const)
      : []),
  ],
  apply: (mesh, modifier) =>
    mirror(mesh, modifier.axis, modifier.merge, modifier.mergeThreshold),
});
