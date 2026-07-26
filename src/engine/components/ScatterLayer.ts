import type { Component } from '../scene/types';
import { registerComponent } from './registry';

/**
 * Reserved for Phase 2's scatter brush. Registered now, not implemented now — the reason is
 * ARCHITECTURE.md §9.3: at 25 km x 25 km, painted vegetation cannot be one entity per instance,
 * so the *shape* of scatter data has to exist before the brush is written, or the brush would
 * be built against a format we'd then have to migrate.
 *
 * The contract that matters: instance transforms live in packed arrays, not entities. One
 * ScatterLayer is one Hierarchy row and one draw call per prototype per chunk, whether it
 * holds ten instances or ten million.
 */
export interface ScatterPrototype {
  id: string;
  /** Entity id used as the source mesh, or an asset id once model import lands. */
  sourceId: string;
  weight: number;
}

export interface ScatterLayerComponent extends Component {
  type: 'ScatterLayer';
  prototypes: ScatterPrototype[];
  /**
   * Instance data, base64-encoded Float32Array, 8 floats per instance:
   * [x, y, z, qx, qy, qz, qw, uniformScale]. Quaternions rather than Euler because these are
   * consumed by the GPU, never edited by hand in the Inspector.
   */
  instances: string;
  /** Prototype index per instance, base64-encoded Uint16Array. */
  variants: string;
  instanceCount: number;
}

export const SCATTER_FLOATS_PER_INSTANCE = 8;

export function createScatterLayer(
  overrides: Partial<ScatterLayerComponent> = {},
): ScatterLayerComponent {
  return {
    type: 'ScatterLayer',
    prototypes: [],
    instances: '',
    variants: '',
    instanceCount: 0,
    ...overrides,
  };
}

registerComponent<ScatterLayerComponent>({
  type: 'ScatterLayer',
  label: 'Scatter Layer',
  create: createScatterLayer,
  // Hidden from "Add Component" until the Phase 2 brush can actually fill one in.
  addable: false,
  fields() {
    return [];
  },
});
