import * as THREE from 'three';
import type { Vec3 } from '../scene/types';
import { newellNormal, triangulatePolygon3D } from './tessellate';

/**
 * An editable mesh: vertices plus **polygon** faces, not a triangle soup.
 *
 * Faces are n-gons (usually quads) rather than triangles, and that is the whole point. Every
 * modelling operation worth having depends on it:
 *
 * - Catmull-Clark subdivision on triangles produces pinched, uneven surfaces; on quads it
 *   produces the smooth results people expect from Blender or C4D.
 * - Extrude, inset and bevel are face operations. A triangulated cube has twelve faces to
 *   push instead of six, and the result is wrong.
 * - Edge loops only exist in quad topology.
 *
 * Triangulation happens once, at the very end, when building the render geometry.
 */
export interface MeshData {
  /** Flat xyz triples. Length is always a multiple of 3. */
  positions: number[];
  /** Each face is a list of vertex indices, wound counter-clockwise when seen from outside. */
  faces: number[][];
  /** Optional flat uv pairs, one per vertex. */
  uvs?: number[];
  /**
   * Per-face smooth-shading flag. Absent means the whole mesh is flat shaded, which is what a
   * box wants; a sphere sets these true.
   */
  smoothFaces?: boolean[];
}

export function createMeshData(): MeshData {
  return { positions: [], faces: [] };
}

export function cloneMeshData(mesh: MeshData): MeshData {
  return {
    positions: [...mesh.positions],
    faces: mesh.faces.map((face) => [...face]),
    ...(mesh.uvs ? { uvs: [...mesh.uvs] } : {}),
    ...(mesh.smoothFaces ? { smoothFaces: [...mesh.smoothFaces] } : {}),
  };
}

export function vertexCount(mesh: MeshData): number {
  return mesh.positions.length / 3;
}

export function getVertex(mesh: MeshData, index: number): Vec3 {
  const i = index * 3;
  return [mesh.positions[i] ?? 0, mesh.positions[i + 1] ?? 0, mesh.positions[i + 2] ?? 0];
}

export function setVertex(mesh: MeshData, index: number, value: Vec3): void {
  const i = index * 3;
  mesh.positions[i] = value[0];
  mesh.positions[i + 1] = value[1];
  mesh.positions[i + 2] = value[2];
}

export function pushVertex(mesh: MeshData, x: number, y: number, z: number): number {
  mesh.positions.push(x, y, z);
  return mesh.positions.length / 3 - 1;
}

/** Triangles the mesh would produce. An n-gon fans into n-2 triangles. */
export function triangleCount(mesh: MeshData): number {
  let total = 0;
  for (const face of mesh.faces) total += Math.max(0, face.length - 2);
  return total;
}

export function edgeCount(mesh: MeshData): number {
  const seen = new Set<string>();
  for (const face of mesh.faces) {
    for (let i = 0; i < face.length; i += 1) {
      const a = face[i]!;
      const b = face[(i + 1) % face.length]!;
      seen.add(a < b ? `${a}_${b}` : `${b}_${a}`);
    }
  }
  return seen.size;
}

// ------------------------------------------------------------------ geometry

/** Centroid of a face. Used by subdivision, inset and extrude. */
export function faceCentroid(mesh: MeshData, face: number[]): Vec3 {
  const out: Vec3 = [0, 0, 0];
  if (face.length === 0) return out;
  for (const index of face) {
    const v = getVertex(mesh, index);
    out[0] += v[0];
    out[1] += v[1];
    out[2] += v[2];
  }
  out[0] /= face.length;
  out[1] /= face.length;
  out[2] /= face.length;
  return out;
}

/**
 * Face normal via Newell's method — correct for n-gons and for faces that are not perfectly
 * planar, both of which happen constantly once deformers start moving vertices around.
 */
export function faceNormal(mesh: MeshData, face: readonly number[]): Vec3 {
  return newellNormal(face.map((index) => getVertex(mesh, index)));
}

/**
 * Splits one face into triangles, as vertex indices, keeping the face's winding.
 *
 * The single place n-gons become triangles. Concave faces are ear-clipped; convex ones (every
 * primitive generator's output) take a plain fan. See `tessellate.ts` for why the fan alone is
 * not enough once 2D shapes like Star and Gear exist.
 */
export function triangulateFace(mesh: MeshData, face: readonly number[]): [number, number, number][] {
  if (face.length < 3) return [];
  if (face.length === 3) return [[face[0]!, face[1]!, face[2]!]];
  const points = face.map((index) => getVertex(mesh, index));
  return triangulatePolygon3D(points).map(
    ([a, b, c]) => [face[a]!, face[b]!, face[c]!] as [number, number, number],
  );
}

/** Bounding box, or null when the mesh is empty. */
export function meshBounds(mesh: MeshData): { min: Vec3; max: Vec3 } | null {
  if (mesh.positions.length === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.positions[i + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  return { min, max };
}

// ------------------------------------------------------------------ editing

/**
 * Merges vertices closer together than `threshold`, rewiring faces onto the survivors.
 *
 * Needed after mirroring (seam vertices land on top of each other) and after any operation
 * that duplicates geometry. Without it, a mirrored mesh has a split seam that subdivision and
 * smooth shading both reveal as a crease.
 */
export function weldVertices(mesh: MeshData, threshold = 1e-4): MeshData {
  const out = createMeshData();
  // Welding is lossy for UVs: a box corner legitimately carries three different ones, and
  // only the survivor's is kept. Proper seam preservation needs split vertices, which is the
  // texturing phase's problem; dropping the attribute altogether would be worse.
  if (mesh.uvs) out.uvs = [];
  const remap = new Array<number>(vertexCount(mesh));
  // Hash to a grid one threshold wide so lookup is constant time rather than quadratic. Also
  // probe neighbouring cells, since two points within the threshold can straddle a boundary.
  const cellSize = Math.max(threshold, 1e-9);
  const buckets = new Map<string, number[]>();

  for (let i = 0; i < vertexCount(mesh); i += 1) {
    const [x, y, z] = getVertex(mesh, i);
    const cx = Math.floor(x / cellSize);
    const cy = Math.floor(y / cellSize);
    const cz = Math.floor(z / cellSize);

    let found = -1;
    for (let dx = -1; dx <= 1 && found === -1; dx += 1) {
      for (let dy = -1; dy <= 1 && found === -1; dy += 1) {
        for (let dz = -1; dz <= 1 && found === -1; dz += 1) {
          const candidates = buckets.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!candidates) continue;
          for (const candidate of candidates) {
            const [ox, oy, oz] = getVertex(out, candidate);
            if (Math.hypot(x - ox, y - oy, z - oz) <= threshold) {
              found = candidate;
              break;
            }
          }
        }
      }
    }

    if (found === -1) {
      found = pushVertex(out, x, y, z);
      if (out.uvs) out.uvs.push(mesh.uvs?.[i * 2] ?? 0, mesh.uvs?.[i * 2 + 1] ?? 0);
      const key = `${cx},${cy},${cz}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(found);
      else buckets.set(key, [found]);
    }
    remap[i] = found;
  }

  out.smoothFaces = mesh.smoothFaces ? [] : undefined;
  for (const [faceIndex, face] of mesh.faces.entries()) {
    const mapped: number[] = [];
    for (const index of face) {
      const target = remap[index]!;
      // Drop indices repeated back to back — welding can collapse an edge to nothing.
      if (mapped[mapped.length - 1] !== target) mapped.push(target);
    }
    if (mapped.length > 1 && mapped[0] === mapped[mapped.length - 1]) mapped.pop();
    if (mapped.length < 3) continue;
    out.faces.push(mapped);
    if (out.smoothFaces) out.smoothFaces.push(mesh.smoothFaces?.[faceIndex] ?? false);
  }

  return out;
}

/** Appends `source` into `target`, offsetting its face indices. Both are left valid. */
export function mergeMeshes(target: MeshData, source: MeshData): void {
  const offset = vertexCount(target);
  target.positions.push(...source.positions);
  if (source.uvs) {
    target.uvs ??= new Array<number>(offset * 2).fill(0);
    target.uvs.push(...source.uvs);
  }
  for (const [index, face] of source.faces.entries()) {
    target.faces.push(face.map((i) => i + offset));
    if (target.smoothFaces || source.smoothFaces) {
      target.smoothFaces ??= new Array<boolean>(target.faces.length - 1).fill(false);
      target.smoothFaces.push(source.smoothFaces?.[index] ?? false);
    }
  }
}

/** Reverses winding so faces point the other way. Used by Mirror and Solidify. */
export function flipFaces(mesh: MeshData): void {
  for (const face of mesh.faces) face.reverse();
}

/** Applies a per-vertex function in place. The basis for every deformer. */
export function deformVertices(mesh: MeshData, fn: (v: Vec3, index: number) => Vec3): void {
  for (let i = 0; i < vertexCount(mesh); i += 1) {
    setVertex(mesh, i, fn(getVertex(mesh, i), i));
  }
}

// ------------------------------------------------------------------ render

/**
 * Triangulates into a THREE.BufferGeometry.
 *
 * Vertices are split per face rather than shared, because a shared vertex cannot carry two
 * different normals — and a cube needs three different normals at each corner. Smooth faces
 * get their normals averaged afterwards across the faces meeting at each original vertex,
 * which is what gives a sphere a continuous surface while leaving the cube's edges crisp.
 */
export function toBufferGeometry(mesh: MeshData): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  // Averaged normals for smooth-shaded faces, accumulated per original vertex.
  const smoothNormals = new Map<number, Vec3>();
  const hasSmooth = mesh.smoothFaces?.some(Boolean) ?? false;
  if (hasSmooth) {
    for (const [faceIndex, face] of mesh.faces.entries()) {
      if (!mesh.smoothFaces?.[faceIndex]) continue;
      const normal = faceNormal(mesh, face);
      for (const index of face) {
        const accumulated = smoothNormals.get(index) ?? [0, 0, 0];
        accumulated[0] += normal[0];
        accumulated[1] += normal[1];
        accumulated[2] += normal[2];
        smoothNormals.set(index, accumulated);
      }
    }
    for (const [index, normal] of smoothNormals) {
      const length = Math.hypot(normal[0], normal[1], normal[2]);
      if (length > 1e-12) {
        smoothNormals.set(index, [normal[0] / length, normal[1] / length, normal[2] / length]);
      }
    }
  }

  for (const [faceIndex, face] of mesh.faces.entries()) {
    if (face.length < 3) continue;
    const flatNormal = faceNormal(mesh, face);
    const smooth = mesh.smoothFaces?.[faceIndex] ?? false;

    for (const triangle of triangulateFace(mesh, face)) {
      for (const index of triangle) {
        const [x, y, z] = getVertex(mesh, index);
        positions.push(x, y, z);
        const normal = (smooth ? smoothNormals.get(index) : undefined) ?? flatNormal;
        normals.push(normal[0], normal[1], normal[2]);
        if (mesh.uvs) {
          uvs.push(mesh.uvs[index * 2] ?? 0, mesh.uvs[index * 2 + 1] ?? 0);
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  if (uvs.length > 0) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}
