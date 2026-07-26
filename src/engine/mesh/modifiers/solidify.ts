import {
  cloneMeshData,
  faceNormal,
  getVertex,
  vertexCount,
  type MeshData,
} from '../MeshData';
import { registerModifier, type Modifier } from './registry';
import type { Vec3 } from '../../scene/types';

export interface SolidifyModifier extends Modifier {
  type: 'Solidify';
  thickness: number;
  /** 0 pushes the shell entirely inward, 1 entirely outward, 0.5 splits it evenly. */
  offset: number;
}

/** Area-weighted vertex normals, so a vertex where large and small faces meet leans correctly. */
function vertexNormals(mesh: MeshData): Vec3[] {
  const normals: Vec3[] = Array.from({ length: vertexCount(mesh) }, () => [0, 0, 0] as Vec3);
  for (const face of mesh.faces) {
    const normal = faceNormal(mesh, face);
    for (const index of face) {
      const accumulated = normals[index]!;
      accumulated[0] += normal[0];
      accumulated[1] += normal[1];
      accumulated[2] += normal[2];
    }
  }
  for (const normal of normals) {
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    if (length > 1e-12) {
      normal[0] /= length;
      normal[1] /= length;
      normal[2] /= length;
    }
  }
  return normals;
}

/**
 * Gives a surface thickness: an inner shell, plus rim faces closing any open border.
 *
 * The rim step is what makes this useful on open meshes like a Plane — without it, solidify
 * produces two disconnected sheets with a visible gap all the way round. Closed meshes have
 * no boundary edges, so they simply get a shell.
 */
export function solidify(mesh: MeshData, thickness: number, offset = 0): MeshData {
  if (Math.abs(thickness) < 1e-9) return cloneMeshData(mesh);

  const normals = vertexNormals(mesh);
  const outerShift = thickness * offset;
  const innerShift = thickness * (offset - 1);

  const out = cloneMeshData(mesh);
  const count = vertexCount(mesh);

  // Push the original surface out, then append a mirrored inner shell.
  for (let i = 0; i < count; i += 1) {
    const [x, y, z] = getVertex(mesh, i);
    const n = normals[i]!;
    out.positions[i * 3] = x + n[0] * outerShift;
    out.positions[i * 3 + 1] = y + n[1] * outerShift;
    out.positions[i * 3 + 2] = z + n[2] * outerShift;
  }
  for (let i = 0; i < count; i += 1) {
    const [x, y, z] = getVertex(mesh, i);
    const n = normals[i]!;
    out.positions.push(x + n[0] * innerShift, y + n[1] * innerShift, z + n[2] * innerShift);
    if (out.uvs) out.uvs.push(mesh.uvs?.[i * 2] ?? 0, mesh.uvs?.[i * 2 + 1] ?? 0);
  }

  out.smoothFaces ??= mesh.faces.map(() => false);
  const originalFaceCount = mesh.faces.length;
  for (let f = 0; f < originalFaceCount; f += 1) {
    // Inner shell faces are wound backwards so they face into the cavity.
    out.faces.push([...mesh.faces[f]!].reverse().map((index) => index + count));
    out.smoothFaces.push(out.smoothFaces[f] ?? false);
  }

  // Rim: every edge used by exactly one face is on the border and needs closing.
  const edgeUse = new Map<string, { a: number; b: number; count: number }>();
  for (const face of mesh.faces) {
    for (let i = 0; i < face.length; i += 1) {
      const a = face[i]!;
      const b = face[(i + 1) % face.length]!;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const record = edgeUse.get(key);
      if (record) record.count += 1;
      else edgeUse.set(key, { a, b, count: 1 });
    }
  }
  for (const { a, b, count: uses } of edgeUse.values()) {
    if (uses !== 1) continue;
    out.faces.push([a, b, b + count, a + count]);
    out.smoothFaces.push(false);
  }

  return out;
}

export function createSolidifyModifier(
  overrides: Partial<SolidifyModifier> = {},
): SolidifyModifier {
  return { type: 'Solidify', enabled: true, thickness: 0.05, offset: 0, ...overrides };
}

registerModifier<SolidifyModifier>({
  type: 'Solidify',
  label: 'Solidify',
  create: createSolidifyModifier,
  fields: () => [
    { kind: 'number', key: 'thickness', label: 'Thickness', step: 0.01 },
    { kind: 'number', key: 'offset', label: 'Offset', min: 0, max: 1, step: 0.05 },
  ],
  apply: (mesh, modifier) => solidify(mesh, modifier.thickness, modifier.offset),
});
