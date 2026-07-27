import {
  cloneMeshData,
  createMeshData,
  faceCentroid,
  faceNormal,
  getVertex,
  pushVertex,
  vertexCount,
  type MeshData,
} from './MeshData';
import { boundaryLoops } from './loops';
import type { Vec3 } from '../scene/types';

export interface SweepOptions {
  /** Rings between the start and the end. More steps make taper, twist and rise smooth. */
  steps: number;
  /** Where a source point sits at parameter `t` along the sweep. `t === 0` must be identity. */
  at(point: Vec3, t: number): Vec3;
  /**
   * True when the final ring lands back on the first — a full revolution with no rise. The
   * final ring then reuses the source vertices instead of duplicating them, which is the
   * difference between a torus that is one surface and one with an invisible split seam that
   * Subdivide and smooth shading both turn into a crease.
   */
  closed?: boolean;
  /** Close the near end with the source faces, reversed so they point away from the solid. */
  capStart?: boolean;
  /** Close the far end with the source faces at the end of the sweep. */
  capEnd?: boolean;
  /** Smooth-shade the swept walls. Right for a lathe, wrong for a straight extrusion. */
  smoothWalls?: boolean;
}

/**
 * Which way the sweep pushes the surface, measured against the surface's own normals.
 *
 * A swept wall faces outward when the path moves the profile *along* its normal, and inside out
 * when it moves the other way. Both happen for ordinary settings — a negative extrude distance,
 * a lathe profile sitting on the far side of the spin axis, a negative angle — so rather than
 * making each caller work out its own sign rule, the sweep measures the first small step and
 * reverses the whole result when it comes out backwards.
 *
 * Measured at a fraction of one step rather than at the end of the path, because a full
 * revolution returns every point to where it started and would report no motion at all.
 */
function sweepOrientation(mesh: MeshData, options: SweepOptions, steps: number): number {
  const t = 1 / (2 * steps);
  let total = 0;
  for (const face of mesh.faces) {
    const normal = faceNormal(mesh, face);
    const centre = faceCentroid(mesh, face);
    const moved = options.at(centre, t);
    total +=
      normal[0] * (moved[0] - centre[0]) +
      normal[1] * (moved[1] - centre[1]) +
      normal[2] * (moved[2] - centre[2]);
  }
  return total;
}

/**
 * Sweeps an open mesh's border along a path, building walls and optional caps.
 *
 * The single construction behind both Extrude and Lathe: they differ only in the transform
 * handed to `at`. Writing it once means the awkward parts — vertex sharing between rings, which
 * end gets which winding, welding a full revolution back onto itself — are solved once and
 * behave identically in both.
 *
 * A mesh with no border has nothing to sweep and comes back unchanged. That is the honest answer
 * for a closed solid: there is no profile in it to push along a path, and inventing one (say, by
 * splitting it in half) would be a different operation wearing this one's name.
 */
export function sweepProfile(mesh: MeshData, options: SweepOptions): MeshData {
  const loops = boundaryLoops(mesh);
  const steps = Math.max(1, Math.floor(options.steps) || 1);
  if (loops.length === 0 || mesh.faces.length === 0) return cloneMeshData(mesh);

  const sourceCount = vertexCount(mesh);
  const out = createMeshData();
  out.positions = [...mesh.positions];
  if (mesh.uvs) out.uvs = [...mesh.uvs];
  out.smoothFaces = [];

  const copyVertex = (source: number, t: number): number => {
    const [x, y, z] = options.at(getVertex(mesh, source), t);
    const index = pushVertex(out, x, y, z);
    if (out.uvs) out.uvs.push(mesh.uvs?.[source * 2] ?? 0, mesh.uvs?.[source * 2 + 1] ?? 0);
    return index;
  };

  // `rings[k][sourceIndex]` is where source vertex `sourceIndex` sits at step `k`, or -1 where
  // that step does not carry it. Only the two ends need every vertex — they may be capped with
  // the source faces — so intermediate rings carry the border alone.
  const border = new Set<number>();
  for (const loop of loops) for (const index of loop) border.add(index);

  const rings: number[][] = [];
  rings.push(Array.from({ length: sourceCount }, (_, i) => i));

  for (let step = 1; step < steps; step += 1) {
    const ring = new Array<number>(sourceCount).fill(-1);
    for (const source of border) ring[source] = copyVertex(source, step / steps);
    rings.push(ring);
  }

  if (options.closed) {
    // Last ring is the first ring: no new vertices, no seam.
    rings.push(rings[0]!);
  } else {
    const ring = new Array<number>(sourceCount).fill(-1);
    for (let source = 0; source < sourceCount; source += 1) ring[source] = copyVertex(source, 1);
    rings.push(ring);
  }

  const smoothWalls = options.smoothWalls ?? false;
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i += 1) {
      const a = loop[i]!;
      const b = loop[(i + 1) % loop.length]!;
      for (let step = 0; step < steps; step += 1) {
        const lower = rings[step]!;
        const upper = rings[step + 1]!;
        const quad = [lower[a]!, lower[b]!, upper[b]!, upper[a]!];
        // A ring that collapses onto the previous one (a taper to nothing, a zero-length step)
        // would otherwise contribute faces with repeated corners.
        const unique = quad.filter((index, at) => quad.indexOf(index) === at);
        if (unique.length < 3) continue;
        out.faces.push(unique);
        out.smoothFaces.push(smoothWalls);
      }
    }
  }

  // Caps are meaningless on a closed sweep — the two ends are the same ring.
  if (!options.closed && options.capStart !== false) {
    for (const [faceIndex, face] of mesh.faces.entries()) {
      out.faces.push([...face].reverse());
      out.smoothFaces.push(mesh.smoothFaces?.[faceIndex] ?? false);
    }
  }
  if (!options.closed && options.capEnd !== false) {
    const ring = rings[steps]!;
    for (const [faceIndex, face] of mesh.faces.entries()) {
      out.faces.push(face.map((index) => ring[index]!));
      out.smoothFaces.push(mesh.smoothFaces?.[faceIndex] ?? false);
    }
  }

  if (sweepOrientation(mesh, options, steps) < 0) for (const face of out.faces) face.reverse();
  return out;
}
