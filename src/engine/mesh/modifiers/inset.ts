import {
  cloneMeshData,
  createMeshData,
  faceCentroid,
  faceNormal,
  getVertex,
  pushVertex,
  type MeshData,
} from '../MeshData';
import { registerModifier, type Modifier } from './registry';
import type { Vec3 } from '../../scene/types';

export interface InsetModifier extends Modifier {
  type: 'Inset';
  /** How far each face pulls in from its own edges. */
  thickness: number;
  /** How far the inset face moves along its normal. Negative sinks it in. */
  depth: number;
}

function normalise(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length < 1e-12) return [0, 0, 0];
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Shrinks every face inside its own border and bridges the gap with a rim.
 *
 * The modelling operation panels, recesses, window frames and button faces are all made of, and
 * the one that turns a flat extruded profile into something with an edge worth lighting.
 *
 * Corners are mitred properly rather than pulled toward the centroid: each new corner is placed
 * where the two inward-offset edge lines actually meet, so the inset border stays parallel to
 * the original on a long thin face. Pulling toward the centroid — which is what Bevel does, and
 * is right for Bevel because it wants a uniform gap all round — narrows a 10:1 rectangle far
 * more along its short axis than its long one, and the result reads as a mistake.
 *
 * The original border vertices are kept and shared, so only the inner rings are new geometry.
 */
export function inset(mesh: MeshData, thickness: number, depth = 0): MeshData {
  if (mesh.faces.length === 0) return cloneMeshData(mesh);
  if (Math.abs(thickness) < 1e-9 && Math.abs(depth) < 1e-9) return cloneMeshData(mesh);

  const out = createMeshData();
  out.positions = [...mesh.positions];
  if (mesh.uvs) out.uvs = [...mesh.uvs];
  out.smoothFaces = [];

  for (const [faceIndex, face] of mesh.faces.entries()) {
    const smooth = mesh.smoothFaces?.[faceIndex] ?? false;
    if (face.length < 3) {
      out.faces.push([...face]);
      out.smoothFaces.push(smooth);
      continue;
    }

    const normal = faceNormal(mesh, face);
    const centroid = faceCentroid(mesh, face);
    const inner: number[] = [];

    for (let i = 0; i < face.length; i += 1) {
      const previous = getVertex(mesh, face[(i + face.length - 1) % face.length]!);
      const current = getVertex(mesh, face[i]!);
      const next = getVertex(mesh, face[(i + 1) % face.length]!);

      // Inward normals of the two edges meeting at this corner. For a face wound
      // counter-clockwise about its normal, `normal × edge` points into the face.
      const inA = cross(normal, normalise([current[0] - previous[0], current[1] - previous[1], current[2] - previous[2]]));
      const inB = cross(normal, normalise([next[0] - current[0], next[1] - current[1], next[2] - current[2]]));
      const bisector: Vec3 = [inA[0] + inB[0], inA[1] + inB[1], inA[2] + inB[2]];
      const scale = 1 + (inA[0] * inB[0] + inA[1] * inB[1] + inA[2] * inB[2]);

      let offset: Vec3;
      if (scale > 1e-6) {
        const step = thickness / scale;
        offset = [bisector[0] * step, bisector[1] * step, bisector[2] * step];
      } else {
        // The two edges double back on each other, so they have no meeting point. Offsetting
        // along one of them is arbitrary but finite, which is what matters.
        offset = [inA[0] * thickness, inA[1] * thickness, inA[2] * thickness];
      }

      // Never travel past the centroid: on a small face the inset would fold the polygon
      // inside out and the rim quads would cross each other.
      const toCentre: Vec3 = [
        centroid[0] - current[0],
        centroid[1] - current[1],
        centroid[2] - current[2],
      ];
      const limit = Math.hypot(toCentre[0], toCentre[1], toCentre[2]) * 0.98;
      const travel = Math.hypot(offset[0], offset[1], offset[2]);
      if (travel > limit && travel > 1e-12) {
        const clamp = limit / travel;
        offset = [offset[0] * clamp, offset[1] * clamp, offset[2] * clamp];
      }

      const index = pushVertex(
        out,
        current[0] + offset[0] + normal[0] * depth,
        current[1] + offset[1] + normal[1] * depth,
        current[2] + offset[2] + normal[2] * depth,
      );
      if (out.uvs) {
        out.uvs.push(mesh.uvs?.[face[i]! * 2] ?? 0, mesh.uvs?.[face[i]! * 2 + 1] ?? 0);
      }
      inner.push(index);
    }

    out.faces.push(inner);
    out.smoothFaces.push(smooth);

    // Rim, wound the same way as the face it came from so it faces outward with it.
    for (let i = 0; i < face.length; i += 1) {
      const next = (i + 1) % face.length;
      out.faces.push([face[i]!, face[next]!, inner[next]!, inner[i]!]);
      out.smoothFaces.push(smooth);
    }
  }

  return out;
}

export function createInsetModifier(overrides: Partial<InsetModifier> = {}): InsetModifier {
  return { type: 'Inset', enabled: true, thickness: 0.1, depth: 0, ...overrides };
}

registerModifier<InsetModifier>({
  type: 'Inset',
  label: 'Inset Faces',
  create: createInsetModifier,
  fields: () => [
    { kind: 'number', key: 'thickness', label: 'Thickness', step: 0.01 },
    { kind: 'number', key: 'depth', label: 'Depth', step: 0.01 },
  ],
  apply: (mesh, modifier) => inset(mesh, modifier.thickness, modifier.depth),
});
