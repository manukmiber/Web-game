import * as THREE from 'three';
import type { MaterialComponent } from '../components/Material';
import { createMaterial, usesPhysicalFeatures } from '../components/Material';
import type { AssetStore } from '../assets/AssetStore';
import { ResourceCache } from './ResourceCache';

/**
 * The PBR material pipeline: a component in, a shared `THREE.Material` out.
 *
 * Two things make this more than a property copy, and both come from the same source — a
 * `MaterialComponent` describes a *surface*, while Three describes a *program plus samplers*.
 *
 * **Colour space per slot.** A base colour map is sRGB and must be decoded; a normal, roughness,
 * metalness or occlusion map is *data* and must not be. `AssetStore` marks everything sRGB
 * because it has no idea what a texture will be used for, so the decision is made here, where the
 * slot is known. Handing a normal map through an sRGB decode bends every normal towards the
 * surface, which reads as a bump map that is mysteriously weak in the mid-tones — a bug that
 * looks like an authoring problem and is not.
 *
 * **Tiling per material.** `repeat` and `offset` live on the texture in Three, not on the
 * material, so two materials tiling the same asset differently cannot share one texture object.
 *
 * Both are solved the same way: every map slot gets its own lightweight *view* of the asset —
 * `Texture.clone()`, which shares the decoded image (Three refcounts sources, so the pixels are
 * uploaded once) and carries its own colour space and uv transform. The views belong to the
 * material and die with it, which is what the cache's `teardown` hook is for.
 */

/** Every texture slot, and whether its contents are colour or data. */
const TEXTURE_SLOTS = [
  { field: 'map', target: 'map', color: true },
  { field: 'normalMap', target: 'normalMap', color: false },
  { field: 'roughnessMap', target: 'roughnessMap', color: false },
  { field: 'metalnessMap', target: 'metalnessMap', color: false },
  { field: 'aoMap', target: 'aoMap', color: false },
  { field: 'emissiveMap', target: 'emissiveMap', color: true },
  { field: 'displacementMap', target: 'displacementMap', color: false },
] as const satisfies readonly {
  field: keyof MaterialComponent;
  target: string;
  color: boolean;
}[];

/**
 * Cache key covering every property that changes the resulting THREE.Material.
 *
 * JSON of a normalised component rather than the hand-joined string this used to be. With eight
 * fields a delimiter-joined key was readable; with thirty, one field added in the wrong position
 * silently shifts every value after it — a class of bug where materials come out with another
 * material's roughness. The round trip through `JSON.parse` is exact by construction.
 */
export function materialKey(component: MaterialComponent): string {
  const m = { ...createMaterial(), ...component };
  // `type` is constant and the component may carry unknown fields from a newer build; both are
  // dropped so they cannot fragment the cache.
  const { type: _type, ...rest } = m;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(createMaterial()).sort()) {
    if (key === 'type') continue;
    ordered[key] = (rest as Record<string, unknown>)[key];
  }
  return JSON.stringify(ordered);
}

function fromKey(key: string): MaterialComponent {
  try {
    return createMaterial(JSON.parse(key) as Partial<MaterialComponent>);
  } catch {
    // A malformed key cannot happen through `materialKey`, and a default surface is a much
    // better failure inside the render loop than a throw.
    return createMaterial();
  }
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

/**
 * Builds the material's own view of one asset.
 *
 * `clone()` rather than a fresh `Texture`: the clone shares the decoded `Source`, which Three
 * refcounts, so a hundred materials tiling the same brick upload one image between them. What
 * the clone does *not* share is the uv transform and the colour space, which is exactly the two
 * things that have to differ per slot.
 */
function textureView(
  assetId: string | null,
  color: boolean,
  component: MaterialComponent,
): THREE.Texture | null {
  const base = assetStore?.getTexture(assetId ?? null);
  if (!base) return null;
  const view = base.clone();
  view.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  view.repeat.set(component.tiling[0], component.tiling[1]);
  view.offset.set(component.offset[0], component.offset[1]);
  // A cloned texture starts with no GPU upload of its own; without this it renders as white.
  view.needsUpdate = true;
  return view;
}

/**
 * (Re-)resolves every texture slot from the asset store.
 *
 * Called on construction and again whenever a texture finishes decoding, because decoding is
 * asynchronous and a material built before its image landed would otherwise stay untextured for
 * the rest of the session — the bug that made "the texture only appears if you nudge the
 * material afterwards".
 */
function applyTextures(material: THREE.MeshStandardMaterial, component: MaterialComponent): void {
  const target = material as unknown as Record<string, THREE.Texture | null>;
  for (const slot of TEXTURE_SLOTS) {
    const previous = target[slot.target] ?? null;
    const next = textureView(component[slot.field] as string | null, slot.color, component);
    if (previous === next) continue;
    // Only views this module minted are ever assigned, so disposing the outgoing one is always
    // correct — and disposing it is the whole reason they are views rather than the store's own
    // textures, which are shared and must outlive any one material.
    previous?.dispose();
    target[slot.target] = next;
  }
  // A slot appearing or disappearing changes which chunks the program needs.
  material.needsUpdate = true;
}

function releaseTextures(material: THREE.Material): void {
  const target = material as unknown as Record<string, THREE.Texture | null | undefined>;
  for (const slot of TEXTURE_SLOTS) {
    target[slot.target]?.dispose();
    target[slot.target] = null;
  }
}

/**
 * Disposes a material and the texture views it owns.
 *
 * Note what it does *not* do: touch anything in the `AssetStore`. An earlier version disposed
 * `material.map` — which was the store's texture, shared by every other material using the same
 * asset — so releasing one material blanked the texture everywhere else it was used. Owning
 * views rather than borrowing textures is what makes this function safe to write at all.
 */
export function disposeMaterial(material: THREE.Material): void {
  releaseTextures(material);
  material.dispose();
}

function build(component: MaterialComponent): THREE.MeshStandardMaterial {
  const shared = {
    color: new THREE.Color(component.color),
    metalness: component.metalness,
    roughness: component.roughness,
    side: component.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    emissive: new THREE.Color(component.emissive),
    emissiveIntensity: component.emissiveIntensity,
    flatShading: component.flatShading,
    wireframe: component.wireframe,
    normalScale: new THREE.Vector2(component.normalScale, component.normalScale),
    aoMapIntensity: component.aoIntensity,
    displacementScale: component.displacementScale,
  };

  /**
   * The cheaper program unless the surface actually asks for more.
   *
   * `MeshPhysicalMaterial` extends the standard one with the clearcoat, sheen and transmission
   * lobes; every one of them is compiled into the fragment shader whether or not it is used, and
   * transmission additionally makes the renderer keep a copy of the framebuffer to refract
   * through. A scene of painted crates should pay none of that, and with the choice made from the
   * values there is nothing for an artist to remember.
   */
  const material = usesPhysicalFeatures(component)
    ? new THREE.MeshPhysicalMaterial({
        ...shared,
        clearcoat: component.clearcoat,
        clearcoatRoughness: component.clearcoatRoughness,
        sheen: component.sheen,
        sheenColor: new THREE.Color(component.sheenColor),
        sheenRoughness: component.sheenRoughness,
        transmission: component.transmission,
        thickness: component.thickness,
        ior: component.ior,
        specularIntensity: component.specularIntensity,
      })
    : new THREE.MeshStandardMaterial(shared);

  applyBlendMode(material, component);
  applyTextures(material, component);
  // Kept so a texture that finishes decoding later can find the slots it belongs in.
  material.userData.materialComponent = component;
  return material;
}

export const materialCache = new ResourceCache<THREE.Material>(
  (key) => build(fromKey(key)),
  disposeMaterial,
);

export function releaseMaterial(key: string): void {
  materialCache.release(key);
}

/**
 * Re-resolves texture slots on every live material referencing `assetId`.
 *
 * The hook that closes the gap between "a material is built once and cached" and "textures
 * decode whenever the network feels like it". Cheap: it only touches materials that name the
 * asset, and a material with no maps is skipped in one comparison.
 */
export function refreshMaterialTextures(assetId: string): void {
  materialCache.forEach((material) => {
    const component = material.userData.materialComponent as MaterialComponent | undefined;
    if (!component) return;
    const uses = TEXTURE_SLOTS.some((slot) => component[slot.field] === assetId);
    if (!uses) return;
    applyTextures(material as THREE.MeshStandardMaterial, component);
  });
}

/** Whether a material reads a second UV set. Only the occlusion map does; see `RenderBridge`. */
export function needsSecondUv(component: MaterialComponent): boolean {
  return component.aoMap !== null;
}
