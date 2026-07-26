import * as THREE from 'three';
import type { MaterialComponent } from '../components/Material';
import { createMaterial } from '../components/Material';
import type { AssetStore } from '../assets/AssetStore';
import { ResourceCache, disposeMaterial } from './ResourceCache';

/**
 * Cache key covering every property that changes the resulting THREE.Material. Materials are
 * shared across entities with identical settings, which is what keeps a field of identical
 * props to one material binding rather than hundreds.
 */
export function materialKey(component: MaterialComponent): string {
  const m = { ...createMaterial(), ...component };
  return [
    m.color,
    m.alpha,
    m.mode,
    m.cutoff,
    m.metalness,
    m.roughness,
    m.map ?? '-',
    m.doubleSided ? 'ds' : 'ss',
  ].join('|');
}

function parseKey(key: string): MaterialComponent {
  const [color, alpha, mode, cutoff, metalness, roughness, map, sides] = key.split('|');
  return createMaterial({
    color,
    alpha: Number(alpha),
    mode: mode as MaterialComponent['mode'],
    cutoff: Number(cutoff),
    metalness: Number(metalness),
    roughness: Number(roughness),
    map: map === '-' ? null : (map ?? null),
    doubleSided: sides === 'ds',
  });
}

/**
 * Maps our three blend modes onto Three.js state, following the same intent as Unity's
 * shader rendering modes:
 *
 * - Opaque: alpha ignored entirely, full depth write.
 * - Transparent: alpha blended, depth write off so overlapping transparent faces don't
 *   occlude each other in draw order.
 * - Cutout: no blending, fragments discarded below `cutoff`, depth write on — which is what
 *   makes foliage cards sort correctly. That matters a lot for the vegetation in §9.3.
 */
function applyBlendMode(material: THREE.MeshStandardMaterial, c: MaterialComponent): void {
  switch (c.mode) {
    case 'Transparent':
      material.transparent = true;
      material.opacity = c.alpha;
      material.depthWrite = false;
      material.alphaTest = 0;
      break;
    case 'Cutout':
      material.transparent = false;
      material.opacity = 1;
      material.depthWrite = true;
      material.alphaTest = c.cutoff;
      break;
    case 'Opaque':
    default:
      material.transparent = false;
      material.opacity = 1;
      material.depthWrite = true;
      material.alphaTest = 0;
      break;
  }
}

/**
 * Set by the engine at startup so the cache factory can resolve texture ids. A module-level
 * hook rather than a constructor argument because the cache itself is a singleton shared by
 * every viewport.
 */
let assetStore: AssetStore | null = null;

export function bindAssetStore(store: AssetStore): void {
  assetStore = store;
}

export const materialCache = new ResourceCache<THREE.Material>((key) => {
  const component = parseKey(key);
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(component.color),
    metalness: component.metalness,
    roughness: component.roughness,
    side: component.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
  applyBlendMode(material, component);
  const texture = assetStore?.getTexture(component.map);
  if (texture) material.map = texture;
  return material;
});

export function releaseMaterial(key: string): void {
  materialCache.release(key);
}

export { disposeMaterial };
