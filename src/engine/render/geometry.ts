import type * as THREE from 'three';
import type { MeshRendererComponent } from '../components/MeshRenderer';
import { DEFAULT_PRIMITIVE_PARAMS, generatePrimitive, relevantParams } from '../mesh/generators';
import { toBufferGeometry, triangleCount, vertexCount, type MeshData } from '../mesh/MeshData';
import { applyModifiers, type Modifier } from '../mesh/modifiers';
import { ResourceCache } from './ResourceCache';

/**
 * Cache key covering everything that changes the resulting geometry: the primitive, the
 * parameters it actually uses, and the whole modifier stack.
 *
 * Built only from the *relevant* params so changing `radialSegments` on a Box — which ignores
 * it — does not fragment the cache. Disabled modifiers are skipped for the same reason.
 */
export function geometryKey(component: MeshRendererComponent): string {
  const params = { ...DEFAULT_PRIMITIVE_PARAMS, ...component.params };
  const parts = relevantParams(component.primitive).map((key) => `${key}=${params[key]}`);
  const stack = (component.modifiers ?? [])
    .filter((modifier) => modifier.enabled !== false)
    .map((modifier) => JSON.stringify(modifier))
    .join(';');
  return `${component.primitive}|${parts.join(',')}|${stack}`;
}

/**
 * Evaluates a mesh renderer into final geometry: generate the primitive, run the stack, then
 * triangulate once at the end.
 *
 * Kept as its own function so the Inspector can report the evaluated topology without going
 * through the GPU-side cache — a modeller needs to see what a modifier costs before deciding
 * to keep it.
 */
export function evaluateMesh(component: MeshRendererComponent): MeshData {
  const base = generatePrimitive(component.primitive, component.params);
  return applyModifiers(base, component.modifiers ?? []);
}

export interface MeshStats {
  vertices: number;
  faces: number;
  triangles: number;
}

export function meshStats(component: MeshRendererComponent): MeshStats {
  const mesh = evaluateMesh(component);
  return {
    vertices: vertexCount(mesh),
    faces: mesh.faces.length,
    triangles: triangleCount(mesh),
  };
}

/**
 * The cache is keyed by string, so the factory has to rebuild the component from the key.
 * Storing the source component alongside would mean the cache holds references to scene data
 * and leaks it; a key that fully describes the geometry keeps the cache self-contained.
 */
const pendingComponents = new Map<string, MeshRendererComponent>();

export const geometryCache = new ResourceCache<THREE.BufferGeometry>((key) => {
  const component = pendingComponents.get(key);
  if (!component) {
    // Should not happen — acquireGeometry always registers first — but an empty geometry is a
    // far better failure than a thrown exception inside the render loop.
    return toBufferGeometry({ positions: [], faces: [] });
  }
  return toBufferGeometry(evaluateMesh(component));
});

/** Acquires the geometry for a component, building it on first use. */
export function acquireGeometry(component: MeshRendererComponent): {
  key: string;
  geometry: THREE.BufferGeometry;
} {
  const key = geometryKey(component);
  pendingComponents.set(key, component);
  const geometry = geometryCache.acquire(key);
  pendingComponents.delete(key);
  return { key, geometry };
}

export type { Modifier };
