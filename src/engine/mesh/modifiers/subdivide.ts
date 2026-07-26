import {
  createMeshData,
  faceCentroid,
  getVertex,
  pushVertex,
  type MeshData,
} from '../MeshData';
import { registerModifier, type Modifier } from './registry';

export interface SubdivideModifier extends Modifier {
  type: 'Subdivide';
  /** Each level multiplies face count by roughly four, so this gets expensive fast. */
  levels: number;
  /** Marks the output smooth-shaded, which is what makes subdivision look like a surface. */
  smooth: boolean;
}

const MAX_LEVELS = 4;

interface EdgeRecord {
  a: number;
  b: number;
  faces: number[];
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

function buildEdges(mesh: MeshData): Map<string, EdgeRecord> {
  const edges = new Map<string, EdgeRecord>();
  for (const [faceIndex, face] of mesh.faces.entries()) {
    for (let i = 0; i < face.length; i += 1) {
      const a = face[i]!;
      const b = face[(i + 1) % face.length]!;
      const key = edgeKey(a, b);
      const record = edges.get(key);
      if (record) record.faces.push(faceIndex);
      else edges.set(key, { a, b, faces: [faceIndex] });
    }
  }
  return edges;
}

/**
 * One level of Catmull-Clark subdivision.
 *
 * The full rule set, not an approximation, because the cheap version (splitting each face and
 * averaging neighbours) does not converge to a smooth limit surface and shows visible
 * lumpiness exactly where a modeller looks hardest — around corners.
 *
 * Boundary edges get the open-mesh rules instead: an edge point at the midpoint, and a vertex
 * point weighted only by its two boundary neighbours. Without that special case, an open mesh
 * like a Plane shrinks away from its own border every level.
 */
function subdivideOnce(mesh: MeshData): MeshData {
  const out = createMeshData();
  const hasUvs = mesh.uvs !== undefined;
  if (hasUvs) out.uvs = [];

  const uvOf = (index: number): [number, number] =>
    hasUvs ? [mesh.uvs![index * 2] ?? 0, mesh.uvs![index * 2 + 1] ?? 0] : [0, 0];

  const pushWithUv = (position: [number, number, number], uv: [number, number]): number => {
    const index = pushVertex(out, position[0], position[1], position[2]);
    if (hasUvs) out.uvs!.push(uv[0], uv[1]);
    return index;
  };

  // 1. Face points — the centroid of each face.
  const facePoints: number[] = [];
  for (const face of mesh.faces) {
    const centroid = faceCentroid(mesh, face);
    let u = 0;
    let v = 0;
    for (const index of face) {
      const uv = uvOf(index);
      u += uv[0] / face.length;
      v += uv[1] / face.length;
    }
    facePoints.push(pushWithUv(centroid, [u, v]));
  }

  const edges = buildEdges(mesh);

  // 2. Edge points — interior edges average their endpoints with the two adjacent face
  //    points; boundary edges use the plain midpoint.
  const edgePoints = new Map<string, number>();
  for (const [key, edge] of edges) {
    const a = getVertex(mesh, edge.a);
    const b = getVertex(mesh, edge.b);
    const uvA = uvOf(edge.a);
    const uvB = uvOf(edge.b);
    const uv: [number, number] = [(uvA[0] + uvB[0]) / 2, (uvA[1] + uvB[1]) / 2];

    if (edge.faces.length === 2) {
      const f0 = getVertex(out, facePoints[edge.faces[0]!]!);
      const f1 = getVertex(out, facePoints[edge.faces[1]!]!);
      edgePoints.set(
        key,
        pushWithUv(
          [
            (a[0] + b[0] + f0[0] + f1[0]) / 4,
            (a[1] + b[1] + f0[1] + f1[1]) / 4,
            (a[2] + b[2] + f0[2] + f1[2]) / 4,
          ],
          uv,
        ),
      );
    } else {
      edgePoints.set(
        key,
        pushWithUv([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], uv),
      );
    }
  }

  // 3. Vertex points.
  const vertexFaces = new Map<number, number[]>();
  const vertexEdges = new Map<number, string[]>();
  for (const [faceIndex, face] of mesh.faces.entries()) {
    for (const index of face) {
      const list = vertexFaces.get(index);
      if (list) list.push(faceIndex);
      else vertexFaces.set(index, [faceIndex]);
    }
  }
  for (const [key, edge] of edges) {
    for (const index of [edge.a, edge.b]) {
      const list = vertexEdges.get(index);
      if (list) list.push(key);
      else vertexEdges.set(index, [key]);
    }
  }

  const vertexPoints: number[] = [];
  for (let v = 0; v < mesh.positions.length / 3; v += 1) {
    const original = getVertex(mesh, v);
    const incidentEdges = vertexEdges.get(v) ?? [];
    const boundaryEdges = incidentEdges.filter((key) => (edges.get(key)?.faces.length ?? 0) < 2);

    if (boundaryEdges.length > 0) {
      // A vertex touching exactly one face is a corner, and corners are pinned. The crease
      // rule would drag them inward a little on every level, so a Plane would visibly shrink
      // away from its own border the more it is subdivided.
      if ((vertexFaces.get(v)?.length ?? 0) <= 1) {
        vertexPoints.push(pushWithUv(original, uvOf(v)));
        continue;
      }

      // Open-mesh crease rule: (6P + neighbour + neighbour) / 8, boundary neighbours only.
      const sum: [number, number, number] = [0, 0, 0];
      for (const key of boundaryEdges) {
        const edge = edges.get(key)!;
        const other = getVertex(mesh, edge.a === v ? edge.b : edge.a);
        sum[0] += other[0];
        sum[1] += other[1];
        sum[2] += other[2];
      }
      const weight = boundaryEdges.length;
      vertexPoints.push(
        pushWithUv(
          [
            (original[0] * 6 + sum[0] * (2 / weight)) / 8,
            (original[1] * 6 + sum[1] * (2 / weight)) / 8,
            (original[2] * 6 + sum[2] * (2 / weight)) / 8,
          ],
          uvOf(v),
        ),
      );
      continue;
    }

    const incidentFaces = vertexFaces.get(v) ?? [];
    const n = incidentFaces.length;
    if (n === 0) {
      vertexPoints.push(pushWithUv(original, uvOf(v)));
      continue;
    }

    // F: average of adjacent face points. R: average of adjacent edge midpoints.
    const F: [number, number, number] = [0, 0, 0];
    for (const faceIndex of incidentFaces) {
      const point = getVertex(out, facePoints[faceIndex]!);
      F[0] += point[0] / n;
      F[1] += point[1] / n;
      F[2] += point[2] / n;
    }
    const R: [number, number, number] = [0, 0, 0];
    for (const key of incidentEdges) {
      const edge = edges.get(key)!;
      const a = getVertex(mesh, edge.a);
      const b = getVertex(mesh, edge.b);
      R[0] += (a[0] + b[0]) / 2 / incidentEdges.length;
      R[1] += (a[1] + b[1]) / 2 / incidentEdges.length;
      R[2] += (a[2] + b[2]) / 2 / incidentEdges.length;
    }
    vertexPoints.push(
      pushWithUv(
        [
          (F[0] + 2 * R[0] + (n - 3) * original[0]) / n,
          (F[1] + 2 * R[1] + (n - 3) * original[1]) / n,
          (F[2] + 2 * R[2] + (n - 3) * original[2]) / n,
        ],
        uvOf(v),
      ),
    );
  }

  // 4. Every original face becomes one quad per corner. An n-gon yields n quads, so the mesh
  //    is all-quad after the first level regardless of what it started as.
  out.smoothFaces = [];
  for (const [faceIndex, face] of mesh.faces.entries()) {
    for (let i = 0; i < face.length; i += 1) {
      const previous = face[(i - 1 + face.length) % face.length]!;
      const current = face[i]!;
      const next = face[(i + 1) % face.length]!;
      out.faces.push([
        vertexPoints[current]!,
        edgePoints.get(edgeKey(current, next))!,
        facePoints[faceIndex]!,
        edgePoints.get(edgeKey(previous, current))!,
      ]);
      out.smoothFaces.push(mesh.smoothFaces?.[faceIndex] ?? false);
    }
  }

  return out;
}

export function subdivide(mesh: MeshData, levels: number, smooth = true): MeshData {
  let current = mesh;
  const count = Math.max(0, Math.min(MAX_LEVELS, Math.floor(levels)));
  for (let i = 0; i < count; i += 1) current = subdivideOnce(current);
  if (smooth && count > 0) {
    current = { ...current, smoothFaces: current.faces.map(() => true) };
  }
  return current;
}

export function createSubdivideModifier(
  overrides: Partial<SubdivideModifier> = {},
): SubdivideModifier {
  return { type: 'Subdivide', enabled: true, levels: 1, smooth: true, ...overrides };
}

registerModifier<SubdivideModifier>({
  type: 'Subdivide',
  label: 'Subdivide (Catmull-Clark)',
  create: createSubdivideModifier,
  fields: () => [
    // Capped at 4: each level roughly quadruples the face count, so level 6 on a modest mesh
    // is already millions of triangles and a locked-up tab.
    { kind: 'number', key: 'levels', label: 'Levels', min: 0, max: MAX_LEVELS, step: 1, integer: true },
    { kind: 'boolean', key: 'smooth', label: 'Smooth Shading' },
  ],
  apply: (mesh, modifier) => subdivide(mesh, modifier.levels, modifier.smooth),
});
