import type { Component } from '../scene/types';
import { registerComponent, type FieldSchema } from './registry';

/** Mirrors Unity's shader rendering modes. Phase 1 renders all three; only Opaque is exercised. */
export const BLEND_MODES = ['Opaque', 'Transparent', 'Cutout'] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

/**
 * A physically based surface.
 *
 * The metal/rough parameterisation, which is what glTF, Unity's Standard shader, Unreal and
 * Godot all settled on, and it is worth saying why rather than treating it as inevitable. The
 * older specular/gloss form lets an artist author a physically impossible surface without
 * noticing — a dielectric with a coloured specular, a metal with a bright diffuse — and those
 * surfaces then look wrong under lighting they were not authored in. Metal/rough has one fewer
 * degree of freedom and the missing one is exactly the impossible one: `metalness` blends between
 * "the base colour is albedo and the reflection is white" and "the base colour *is* the
 * reflection and there is no diffuse". A surface authored in one lighting environment holds up in
 * another, which is the whole promise of the word "physically".
 *
 * Beyond that base there are four extension lobes, each of which exists because the base cannot
 * express a real material people ask for: `clearcoat` for car paint and lacquered wood,
 * `sheen` for cloth, `transmission` + `ior` for glass and water, and `specularIntensity` for
 * the dielectrics whose reflectance is not the 4% default. They cost a more expensive shader, so
 * they are opt-in per material and `render/material.ts` picks the cheaper program when they are
 * all at their defaults — see `usesPhysicalFeatures`.
 *
 * Every map slot is an asset id or null, and every one of them is optional in the sense that a
 * scene saved before it existed reads back with the field defaulted by `createMaterial`.
 */
export interface MaterialComponent extends Component {
  type: 'Material';
  /** Hex string, e.g. "#ffffff". Alpha lives in `alpha`, not in the hex. */
  color: string;
  alpha: number;
  mode: BlendMode;
  /** Alpha threshold for Cutout mode. */
  cutoff: number;
  metalness: number;
  roughness: number;
  /** Asset id of the base/albedo map. */
  map: string | null;
  doubleSided: boolean;

  // ------------------------------------------------------------------- maps

  /**
   * Tangent-space normal map.
   *
   * The single largest visual return of anything in this component: it changes how light meets
   * the surface at every pixel, which is what makes a flat quad read as brick. Note the texture
   * must *not* be decoded as sRGB — it encodes directions, not colour — which is why
   * `render/material.ts` keeps a separate linear view of every non-colour map.
   */
  normalMap: string | null;
  /** Strength of the normal map. 1 is as authored; below 1 flattens it, above exaggerates. */
  normalScale: number;
  /** Per-pixel roughness, read from the green channel by convention (glTF's ORM packing). */
  roughnessMap: string | null;
  /** Per-pixel metalness, blue channel by the same convention. */
  metalnessMap: string | null;
  /** Baked ambient occlusion, red channel. Darkens *ambient and environment* light only. */
  aoMap: string | null;
  aoIntensity: number;
  /** Light the surface emits. Not a light source — it does not illuminate anything else. */
  emissive: string;
  emissiveIntensity: number;
  emissiveMap: string | null;
  /** Displacement along the normal, in metres. Needs geometry dense enough to displace. */
  displacementMap: string | null;
  displacementScale: number;

  // -------------------------------------------------------- texture transform

  /** Texture repeat, applied to every map on the material. */
  tiling: [number, number];
  /** Texture offset, same units as tiling (1 is one full repeat). */
  offset: [number, number];

  // ------------------------------------------------------------- extra lobes

  /** A second specular layer over the base — car paint, varnish, a wet surface. 0 disables it. */
  clearcoat: number;
  clearcoatRoughness: number;
  /** Retroreflective lobe at grazing angles: velvet, satin, brushed cloth. 0 disables it. */
  sheen: number;
  sheenColor: string;
  sheenRoughness: number;
  /** Light transmitted through the surface rather than reflected: glass, water, ice. */
  transmission: number;
  /** Attenuation distance for transmitted light, in metres. Only read when transmitting. */
  thickness: number;
  /** Index of refraction. 1.5 is glass, 1.33 water, 1.0 air. */
  ior: number;
  /** Reflectance of a dielectric at normal incidence, as a multiple of the 4% default. */
  specularIntensity: number;
  /** Faceted shading — ignores vertex normals. Reads a low-poly mesh as deliberate. */
  flatShading: boolean;
  /** Draws only the wireframe. A debugging surface, kept per-material rather than global. */
  wireframe: boolean;
}

export function createMaterial(overrides: Partial<MaterialComponent> = {}): MaterialComponent {
  return {
    type: 'Material',
    color: '#cccccc',
    alpha: 1,
    mode: 'Opaque',
    cutoff: 0.5,
    metalness: 0,
    roughness: 0.8,
    map: null,
    doubleSided: false,

    normalMap: null,
    normalScale: 1,
    roughnessMap: null,
    metalnessMap: null,
    aoMap: null,
    aoIntensity: 1,
    emissive: '#000000',
    emissiveIntensity: 1,
    emissiveMap: null,
    displacementMap: null,
    displacementScale: 0,

    clearcoat: 0,
    clearcoatRoughness: 0.1,
    sheen: 0,
    sheenColor: '#ffffff',
    sheenRoughness: 0.5,
    transmission: 0,
    thickness: 0.5,
    ior: 1.5,
    specularIntensity: 1,
    flatShading: false,
    wireframe: false,

    ...overrides,
    tiling: overrides.tiling ? [...overrides.tiling] : [1, 1],
    offset: overrides.offset ? [...overrides.offset] : [0, 0],
  };
}

/**
 * True when a material needs the physical shader rather than the standard one.
 *
 * The distinction is a real cost, not bookkeeping: `MeshPhysicalMaterial` compiles the clearcoat,
 * sheen and transmission lobes into every fragment, and transmission additionally forces the
 * renderer to keep a copy of the framebuffer to refract. A scene of painted crates should pay
 * none of that, so the choice is made per material from the values themselves — nobody has to
 * remember to pick a shader, and nobody pays for a lobe they left at zero.
 */
export function usesPhysicalFeatures(material: MaterialComponent): boolean {
  return (
    material.clearcoat > 0 ||
    material.sheen > 0 ||
    material.transmission > 0 ||
    material.specularIntensity !== 1 ||
    material.ior !== 1.5
  );
}

registerComponent<MaterialComponent>({
  type: 'Material',
  label: 'Material',
  create: createMaterial,
  fields(component) {
    const fields: FieldSchema[] = [
      { kind: 'color', key: 'color', label: 'Base Color' },
      { kind: 'enum', key: 'mode', label: 'Rendering Mode', options: BLEND_MODES },
      { kind: 'number', key: 'alpha', label: 'Alpha', min: 0, max: 1, step: 0.01 },
      // Only meaningful in Cutout; hidden otherwise to keep the Inspector honest.
      ...(component.mode === 'Cutout'
        ? ([
            { kind: 'number', key: 'cutoff', label: 'Alpha Cutoff', min: 0, max: 1, step: 0.01 },
          ] as const)
        : []),
      { kind: 'number', key: 'metalness', label: 'Metallic', min: 0, max: 1, step: 0.01 },
      { kind: 'number', key: 'roughness', label: 'Roughness', min: 0, max: 1, step: 0.01 },

      { kind: 'group', key: '@maps', label: 'Maps' },
      { kind: 'asset', key: 'map', label: 'Base Color', assetType: 'texture' },
      { kind: 'asset', key: 'normalMap', label: 'Normal', assetType: 'texture' },
      // Shown only when there is a map for it to scale, for the same reason Alpha Cutoff is.
      ...(component.normalMap
        ? ([
            { kind: 'number', key: 'normalScale', label: 'Normal Scale', min: 0, max: 4, step: 0.05 },
          ] as const)
        : []),
      { kind: 'asset', key: 'roughnessMap', label: 'Roughness', assetType: 'texture' },
      { kind: 'asset', key: 'metalnessMap', label: 'Metallic', assetType: 'texture' },
      { kind: 'asset', key: 'aoMap', label: 'Occlusion', assetType: 'texture' },
      ...(component.aoMap
        ? ([
            { kind: 'number', key: 'aoIntensity', label: 'Occlusion', min: 0, max: 2, step: 0.05 },
          ] as const)
        : []),
      { kind: 'asset', key: 'displacementMap', label: 'Displacement', assetType: 'texture' },
      ...(component.displacementMap
        ? ([
            {
              kind: 'number',
              key: 'displacementScale',
              label: 'Displace By',
              min: -2,
              max: 2,
              step: 0.01,
            },
          ] as const)
        : []),
      { kind: 'vec2', key: 'tiling', label: 'Tiling', step: 0.1, labels: ['U', 'V'] },
      { kind: 'vec2', key: 'offset', label: 'Offset', step: 0.01, labels: ['U', 'V'] },

      { kind: 'group', key: '@emission', label: 'Emission' },
      { kind: 'color', key: 'emissive', label: 'Color' },
      { kind: 'number', key: 'emissiveIntensity', label: 'Intensity', min: 0, max: 20, step: 0.1 },
      { kind: 'asset', key: 'emissiveMap', label: 'Map', assetType: 'texture' },

      { kind: 'group', key: '@advanced', label: 'Advanced Surface' },
      { kind: 'number', key: 'clearcoat', label: 'Clearcoat', min: 0, max: 1, step: 0.01 },
      ...(component.clearcoat > 0
        ? ([
            {
              kind: 'number',
              key: 'clearcoatRoughness',
              label: 'Coat Rough',
              min: 0,
              max: 1,
              step: 0.01,
            },
          ] as const)
        : []),
      { kind: 'number', key: 'sheen', label: 'Sheen', min: 0, max: 1, step: 0.01 },
      ...(component.sheen > 0
        ? ([
            { kind: 'color', key: 'sheenColor', label: 'Sheen Color' },
            {
              kind: 'number',
              key: 'sheenRoughness',
              label: 'Sheen Rough',
              min: 0,
              max: 1,
              step: 0.01,
            },
          ] as const)
        : []),
      { kind: 'number', key: 'transmission', label: 'Transmission', min: 0, max: 1, step: 0.01 },
      ...(component.transmission > 0
        ? ([
            { kind: 'number', key: 'thickness', label: 'Thickness', min: 0, max: 20, step: 0.05 },
          ] as const)
        : []),
      { kind: 'number', key: 'ior', label: 'IOR', min: 1, max: 2.5, step: 0.01 },
      { kind: 'number', key: 'specularIntensity', label: 'Specular', min: 0, max: 2, step: 0.01 },

      { kind: 'group', key: '@shading', label: 'Shading' },
      { kind: 'boolean', key: 'doubleSided', label: 'Double Sided' },
      { kind: 'boolean', key: 'flatShading', label: 'Flat Shading' },
      { kind: 'boolean', key: 'wireframe', label: 'Wireframe' },
    ];
    return fields;
  },
});
