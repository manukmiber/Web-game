import * as THREE from 'three';
import { cloneMeshData, deformVertices, flipFaces, type MeshData } from '../MeshData';
import { registerModifier, type Modifier } from './registry';
import type { Vec3 } from '../../scene/types';

export interface TransformModifier extends Modifier {
  type: 'Transform';
  translate: Vec3;
  /** Euler degrees, in the same XYZ order the entity transform uses. */
  rotate: Vec3;
  scale: Vec3;
}

/**
 * Moves, rotates and scales the mesh itself, leaving the object's own transform alone.
 *
 * Not redundant with the entity transform, because it sits *inside* the stack: where it goes
 * changes what happens next. Lathe spins the profile around the object origin, so the only way
 * to control the radius of the resulting ring is to move the profile away from the axis first —
 * and doing that with the entity's transform would move the finished ring instead. Same story
 * for Mirror, whose plane is the object origin, and for Array, whose relative offset is measured
 * against the mesh's own bounds.
 *
 * A negative scale mirrors the mesh, which reverses its winding and turns a solid inside out.
 * Detecting that from the determinant and flipping the faces back is what makes `scale: -1` a
 * usable mirror rather than a lighting bug.
 */
export function transformMesh(
  mesh: MeshData,
  translate: Vec3,
  rotate: Vec3,
  scale: Vec3,
): MeshData {
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(translate[0], translate[1], translate[2]),
    new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(rotate[0]),
        THREE.MathUtils.degToRad(rotate[1]),
        THREE.MathUtils.degToRad(rotate[2]),
      ),
    ),
    new THREE.Vector3(scale[0] || 1e-6, scale[1] || 1e-6, scale[2] || 1e-6),
  );

  const out = cloneMeshData(mesh);
  const point = new THREE.Vector3();
  deformVertices(out, (v) => {
    point.set(v[0], v[1], v[2]).applyMatrix4(matrix);
    return [point.x, point.y, point.z];
  });

  if (matrix.determinant() < 0) flipFaces(out);
  return out;
}

export function createTransformModifier(
  overrides: Partial<TransformModifier> = {},
): TransformModifier {
  return {
    type: 'Transform',
    enabled: true,
    translate: [0, 0, 0],
    rotate: [0, 0, 0],
    scale: [1, 1, 1],
    ...overrides,
  };
}

registerModifier<TransformModifier>({
  type: 'Transform',
  label: 'Transform',
  create: createTransformModifier,
  fields: () => [
    { kind: 'vec3', key: 'translate', label: 'Translate', step: 0.1 },
    { kind: 'vec3', key: 'rotate', label: 'Rotate °', step: 5 },
    { kind: 'vec3', key: 'scale', label: 'Scale', step: 0.1 },
  ],
  apply: (mesh, modifier) => transformMesh(mesh, modifier.translate, modifier.rotate, modifier.scale),
});
