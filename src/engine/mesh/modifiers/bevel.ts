import {
  cloneMeshData,
  createMeshData,
  faceCentroid,
  getVertex,
  pushVertex,
  type MeshData,
} from '../MeshData';
import { registerModifier, type Modifier } from './registry';
import type { Vec3 } from '../../scene/types';

export interface BevelModifier extends Modifier {
  type: 'Bevel';
  /** How far each face pulls back from its edges, in metres. */
  width: number;
  /** Rounding steps across the bevel. 1 is a flat chamfer. */
  segments: number;
}

const MAX_SEGMENTS = 6;

interface EdgeUse {
  a: number;
  b: number;
  /** Face index and the position of `a` within that face. */
  uses: { face: number; corner: number }[];
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

/**
 * Bevels every edge by shrinking each face inside its own boundary and filling the gaps.
 *
 * Three kinds of geometry come out of it: the shrunken faces themselves, a strip bridging each
 * original edge between the two faces that share it, and a small polygon closing each original
 * corner. That is the standard "inset and bridge" construction, and it produces a correct
 * chamfer for convex geometry, which is what primitives and their modifier output are.
 *
 * Bevel is the modifier that makes rendered geometry stop looking like programmer art: real
 * objects have no perfectly sharp edges, and a bevel is what gives them a highlight to catch.
 *
 * What this is not: Blender's edge-selection bevel with mitred corners and clamping. Doing
 * that properly needs edge loops and per-edge weights, which belong with edit mode. This
 * bevels uniformly, which is what a modifier stack wants anyway.
 */
export function bevel(mesh: MeshData, width: number, segments = 1): MeshData {
  if (width <= 1e-6 || mesh.faces.length === 0) return cloneMeshData(mesh);

  const out = createMeshData();
  out.smoothFaces = [];

  // Each original face gets its own copy of its corners, pulled toward the face centroid.
  // Per-face copies rather than shared vertices is the whole trick: the gap that opens between
  // neighbouring faces is exactly the space the bevel fills.
  const insetCorner = new Map<string, number>();
  const cornerKey = (face: number, vertex: number) => `${face}:${vertex}`;

  for (const [faceIndex, face] of mesh.faces.entries()) {
    const centroid = faceCentroid(mesh, face);
    const inset: number[] = [];

    for (const vertexIndex of face) {
      const v = getVertex(mesh, vertexIndex);
      const toCentre: Vec3 = [centroid[0] - v[0], centroid[1] - v[1], centroid[2] - v[2]];
      const distance = Math.hypot(toCentre[0], toCentre[1], toCentre[2]);
      // Never pull past the centroid: on a small face that would fold the polygon inside out.
      const travel = Math.min(width, distance * 0.98);
      const scale = distance > 1e-9 ? travel / distance : 0;

      const index = pushVertex(
        out,
        v[0] + toCentre[0] * scale,
        v[1] + toCentre[1] * scale,
        v[2] + toCentre[2] * scale,
      );
      insetCorner.set(cornerKey(faceIndex, vertexIndex), index);
      inset.push(index);
    }

    out.faces.push(inset);
    out.smoothFaces.push(mesh.smoothFaces?.[faceIndex] ?? false);
  }

  // Catalogue every edge and which faces use it, keeping the corner order so the bridge strip
  // can be wound to match its neighbours.
  const edges = new Map<string, EdgeUse>();
  for (const [faceIndex, face] of mesh.faces.entries()) {
    for (let corner = 0; corner < face.length; corner += 1) {
      const a = face[corner]!;
      const b = face[(corner + 1) % face.length]!;
      const key = edgeKey(a, b);
      const record = edges.get(key);
      if (record) record.uses.push({ face: faceIndex, corner });
      else edges.set(key, { a, b, uses: [{ face: faceIndex, corner }] });
    }
  }

  const steps = Math.max(1, Math.min(MAX_SEGMENTS, Math.floor(segments)));

  for (const edge of edges.values()) {
    if (edge.uses.length !== 2) continue; // Border edge: nothing on the other side to bridge to.
    const [first, second] = edge.uses as [{ face: number; corner: number }, { face: number; corner: number }];

    const a0 = insetCorner.get(cornerKey(first.face, edge.a));
    const b0 = insetCorner.get(cornerKey(first.face, edge.b));
    const a1 = insetCorner.get(cornerKey(second.face, edge.a));
    const b1 = insetCorner.get(cornerKey(second.face, edge.b));
    if (a0 === undefined || b0 === undefined || a1 === undefined || b1 === undefined) continue;

    if (steps === 1) {
      out.faces.push([a0, b0, b1, a1]);
      out.smoothFaces.push(false);
      continue;
    }

    // Rounded bevel: interpolate across the gap, bulging outward from the original edge so the
    // profile is convex rather than a flat ramp.
    const original = [getVertex(mesh, edge.a), getVertex(mesh, edge.b)] as [Vec3, Vec3];
    const ring: number[][] = [[a0, b0]];
    for (let step = 1; step < steps; step += 1) {
      const t = step / steps;
      const row: number[] = [];
      for (const [end, [start, finish]] of [
        [0, [a0, a1]],
        [1, [b0, b1]],
      ] as [number, [number, number]][]) {
        const from = getVertex(out, start);
        const to = getVertex(out, finish);
        const anchor = original[end]!;
        const midX = from[0] + (to[0] - from[0]) * t;
        const midY = from[1] + (to[1] - from[1]) * t;
        const midZ = from[2] + (to[2] - from[2]) * t;
        // Push the midpoint back toward the original corner to round the profile; strongest at
        // the middle of the arc, zero at both ends.
        const bulge = Math.sin(t * Math.PI) * 0.5;
        row.push(
          pushVertex(
            out,
            midX + (anchor[0] - midX) * bulge,
            midY + (anchor[1] - midY) * bulge,
            midZ + (anchor[2] - midZ) * bulge,
          ),
        );
      }
      ring.push(row);
    }
    ring.push([a1, b1]);

    for (let step = 0; step < ring.length - 1; step += 1) {
      const lower = ring[step]!;
      const upper = ring[step + 1]!;
      out.faces.push([lower[0]!, lower[1]!, upper[1]!, upper[0]!]);
      out.smoothFaces.push(true);
    }
  }

  // Corner polygons: one per original vertex, joining that vertex's inset copy from every face
  // around it. Ordering them by angle keeps the polygon convex instead of self-crossing.
  const vertexFaces = new Map<number, number[]>();
  for (const [faceIndex, face] of mesh.faces.entries()) {
    for (const vertexIndex of face) {
      const list = vertexFaces.get(vertexIndex);
      if (list) list.push(faceIndex);
      else vertexFaces.set(vertexIndex, [faceIndex]);
    }
  }

  for (const [vertexIndex, faceIndices] of vertexFaces) {
    if (faceIndices.length < 3) continue;
    const corners = faceIndices
      .map((faceIndex) => insetCorner.get(cornerKey(faceIndex, vertexIndex)))
      .filter((index): index is number => index !== undefined);
    if (corners.length < 3) continue;

    const origin = getVertex(mesh, vertexIndex);
    const centre = corners.reduce<Vec3>(
      (sum, index) => {
        const v = getVertex(out, index);
        return [sum[0] + v[0] / corners.length, sum[1] + v[1] / corners.length, sum[2] + v[2] / corners.length];
      },
      [0, 0, 0],
    );

    // Sort around the outward direction at this corner so the polygon is wound consistently.
    const normal: Vec3 = [centre[0] - origin[0], centre[1] - origin[1], centre[2] - origin[2]];
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    if (length < 1e-9) continue;
    normal[0] /= length;
    normal[1] /= length;
    normal[2] /= length;

    const reference = getVertex(out, corners[0]!);
    const uAxis: Vec3 = [reference[0] - centre[0], reference[1] - centre[1], reference[2] - centre[2]];
    const uLength = Math.hypot(uAxis[0], uAxis[1], uAxis[2]);
    if (uLength < 1e-9) continue;
    uAxis[0] /= uLength;
    uAxis[1] /= uLength;
    uAxis[2] /= uLength;
    const vAxis: Vec3 = [
      normal[1] * uAxis[2] - normal[2] * uAxis[1],
      normal[2] * uAxis[0] - normal[0] * uAxis[2],
      normal[0] * uAxis[1] - normal[1] * uAxis[0],
    ];

    const sorted = [...corners].sort((left, right) => angleOf(left) - angleOf(right));
    function angleOf(index: number): number {
      const v = getVertex(out, index);
      const d: Vec3 = [v[0] - centre[0], v[1] - centre[1], v[2] - centre[2]];
      return Math.atan2(
        d[0] * vAxis[0] + d[1] * vAxis[1] + d[2] * vAxis[2],
        d[0] * uAxis[0] + d[1] * uAxis[1] + d[2] * uAxis[2],
      );
    }

    out.faces.push(sorted);
    out.smoothFaces.push(true);
  }

  return out;
}

export function createBevelModifier(overrides: Partial<BevelModifier> = {}): BevelModifier {
  return { type: 'Bevel', enabled: true, width: 0.05, segments: 1, ...overrides };
}

registerModifier<BevelModifier>({
  type: 'Bevel',
  label: 'Bevel',
  create: createBevelModifier,
  fields: () => [
    { kind: 'number', key: 'width', label: 'Width', min: 0, step: 0.01 },
    {
      kind: 'number',
      key: 'segments',
      label: 'Segments',
      min: 1,
      max: MAX_SEGMENTS,
      step: 1,
      integer: true,
    },
  ],
  apply: (mesh, modifier) => bevel(mesh, modifier.width, modifier.segments),
});
