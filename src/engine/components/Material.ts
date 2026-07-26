import type { Component } from '../scene/types';
import { registerComponent } from './registry';

/** Mirrors Unity's shader rendering modes. Phase 1 renders all three; only Opaque is exercised. */
export const BLEND_MODES = ['Opaque', 'Transparent', 'Cutout'] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

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
  /** Asset id of the base/albedo map. Phase 2. */
  map: string | null;
  doubleSided: boolean;
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
    ...overrides,
  };
}

registerComponent<MaterialComponent>({
  type: 'Material',
  label: 'Material',
  create: createMaterial,
  fields(component) {
    return [
      { kind: 'color', key: 'color', label: 'Base Color' },
      { kind: 'enum', key: 'mode', label: 'Rendering Mode', options: BLEND_MODES },
      { kind: 'number', key: 'alpha', label: 'Alpha', min: 0, max: 1, step: 0.01 },
      // Only meaningful in Cutout; hidden otherwise to keep the Inspector honest.
      ...(component.mode === 'Cutout'
        ? ([{ kind: 'number', key: 'cutoff', label: 'Alpha Cutoff', min: 0, max: 1, step: 0.01 }] as const)
        : []),
      { kind: 'number', key: 'metalness', label: 'Metallic', min: 0, max: 1, step: 0.01 },
      { kind: 'number', key: 'roughness', label: 'Roughness', min: 0, max: 1, step: 0.01 },
      { kind: 'asset', key: 'map', label: 'Base Map', assetType: 'texture' },
      { kind: 'boolean', key: 'doubleSided', label: 'Double Sided' },
    ];
  },
});
