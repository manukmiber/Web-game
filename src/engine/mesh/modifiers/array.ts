import {
  cloneMeshData,
  createMeshData,
  meshBounds,
  mergeMeshes,
  weldVertices,
  type MeshData,
} from '../MeshData';
import { registerModifier, type Modifier } from './registry';

export interface ArrayModifier extends Modifier {
  type: 'Array';
  count: number;
  /** Offset as a multiple of the mesh's own bounding box — 1.0 places copies edge to edge. */
  relativeX: number;
  relativeY: number;
  relativeZ: number;
  /** Additional offset in metres, added on top of the relative one. */
  constantX: number;
  constantY: number;
  constantZ: number;
  /** Welds touching copies into one surface. Off by default: it is expensive on big arrays. */
  merge: boolean;
}

const MAX_COUNT = 256;

export function arrayModify(mesh: MeshData, modifier: ArrayModifier): MeshData {
  const count = Math.max(1, Math.min(MAX_COUNT, Math.floor(modifier.count)));
  if (count === 1) return cloneMeshData(mesh);

  const bounds = meshBounds(mesh);
  const size: [number, number, number] = bounds
    ? [
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
      ]
    : [0, 0, 0];

  const step: [number, number, number] = [
    size[0] * modifier.relativeX + modifier.constantX,
    size[1] * modifier.relativeY + modifier.constantY,
    size[2] * modifier.relativeZ + modifier.constantZ,
  ];

  const out = createMeshData();
  for (let i = 0; i < count; i += 1) {
    const copy = cloneMeshData(mesh);
    for (let v = 0; v < copy.positions.length; v += 3) {
      copy.positions[v] = copy.positions[v]! + step[0] * i;
      copy.positions[v + 1] = copy.positions[v + 1]! + step[1] * i;
      copy.positions[v + 2] = copy.positions[v + 2]! + step[2] * i;
    }
    mergeMeshes(out, copy);
  }

  return modifier.merge ? weldVertices(out, 1e-4) : out;
}

export function createArrayModifier(overrides: Partial<ArrayModifier> = {}): ArrayModifier {
  return {
    type: 'Array',
    enabled: true,
    count: 3,
    relativeX: 1,
    relativeY: 0,
    relativeZ: 0,
    constantX: 0,
    constantY: 0,
    constantZ: 0,
    merge: false,
    ...overrides,
  };
}

registerModifier<ArrayModifier>({
  type: 'Array',
  label: 'Array',
  create: createArrayModifier,
  fields: () => [
    { kind: 'number', key: 'count', label: 'Count', min: 1, max: MAX_COUNT, step: 1, integer: true },
    { kind: 'number', key: 'relativeX', label: 'Relative X', step: 0.05 },
    { kind: 'number', key: 'relativeY', label: 'Relative Y', step: 0.05 },
    { kind: 'number', key: 'relativeZ', label: 'Relative Z', step: 0.05 },
    { kind: 'number', key: 'constantX', label: 'Constant X', step: 0.1 },
    { kind: 'number', key: 'constantY', label: 'Constant Y', step: 0.1 },
    { kind: 'number', key: 'constantZ', label: 'Constant Z', step: 0.1 },
    { kind: 'boolean', key: 'merge', label: 'Merge Copies' },
  ],
  apply: arrayModify,
});
