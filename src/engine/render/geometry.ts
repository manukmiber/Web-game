import * as THREE from 'three';
import {
  DEFAULT_PRIMITIVE_PARAMS,
  relevantParams,
  type MeshRendererComponent,
  type PrimitiveParams,
  type PrimitiveType,
} from '../components/MeshRenderer';
import { ResourceCache } from './ResourceCache';

/**
 * Cache key built only from the params the primitive actually uses, so changing
 * `widthSegments` on a Box (which ignores it) doesn't fragment the cache.
 */
export function geometryKey(component: MeshRendererComponent): string {
  const params = { ...DEFAULT_PRIMITIVE_PARAMS, ...component.params };
  const parts = relevantParams(component.primitive).map((key) => `${key}=${params[key]}`);
  return `${component.primitive}|${parts.join(',')}`;
}

function parseKey(key: string): { primitive: PrimitiveType; params: PrimitiveParams } {
  const [primitive, rest] = key.split('|');
  const params = { ...DEFAULT_PRIMITIVE_PARAMS };
  for (const pair of (rest ?? '').split(',')) {
    const [name, value] = pair.split('=');
    if (name && value !== undefined) params[name as keyof PrimitiveParams] = Number(value);
  }
  return { primitive: primitive as PrimitiveType, params };
}

function build(primitive: PrimitiveType, p: PrimitiveParams): THREE.BufferGeometry {
  switch (primitive) {
    case 'Box':
      return new THREE.BoxGeometry(p.width, p.height, p.depth);
    case 'Sphere':
      return new THREE.SphereGeometry(p.radius, p.widthSegments, p.heightSegments);
    case 'Plane': {
      // Authored lying flat (Unity's Plane is horizontal); Three's PlaneGeometry faces +Z.
      const geometry = new THREE.PlaneGeometry(p.width, p.height);
      geometry.rotateX(-Math.PI / 2);
      return geometry;
    }
    case 'Cylinder':
      return new THREE.CylinderGeometry(p.radiusTop, p.radiusBottom, p.height, p.radialSegments);
    case 'Capsule':
      return new THREE.CapsuleGeometry(p.radius, p.height, p.capSegments, p.radialSegments);
    case 'Cone':
      return new THREE.ConeGeometry(p.radius, p.height, p.radialSegments);
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

export const geometryCache = new ResourceCache<THREE.BufferGeometry>((key) => {
  const { primitive, params } = parseKey(key);
  return build(primitive, params);
});
