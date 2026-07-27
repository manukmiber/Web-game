import { SCATTER_SHAPES, type ScatterShape } from '../scatter/generate';
import type { Component } from '../scene/types';
import { registerComponent } from './registry';

export type { ScatterShape };

/**
 * Mass instancing: one Hierarchy row, one draw call per prototype, however many instances.
 *
 * The shape of this data was fixed before the brush existed — ARCHITECTURE.md §9.3 — because at
 * 25 km × 25 km painted vegetation cannot be one entity per instance, and a brush written
 * against the wrong format is a migration rather than a feature. The contract it committed to,
 * and which the rest of the pipeline now keeps: **instance transforms live in packed arrays,
 * not entities.**
 *
 * What v0.7.2 added is everything that reads them. `scatter/codec` packs and unpacks the
 * buffers, `scatter/generate` fills them deterministically from the brush settings below, and
 * `render/RenderBridge` projects each prototype onto one `THREE.InstancedMesh`.
 *
 * The brush settings sit on the component rather than in the editor because they are what makes
 * a forest cheap on disk: a layer is a seed plus a dozen numbers until someone edits an
 * individual instance, and re-opening the scene regenerates exactly what was saved.
 */

/**
 * One kind of thing a layer scatters, and how often relative to the others.
 *
 * `sourceId` names an *entity*, which is what makes the feature composable: the tree you scatter
 * is an object in the scene you can recolour or put a modifier stack on, and every instance
 * follows because the batch borrows its geometry through the ordinary mesh cache.
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

  // -- brush settings: what `generateScatter` reads when the layer is (re)filled ------------

  /** Change it and the whole layer re-rolls; keep it and the layer is reproducible forever. */
  seed: number;
  shape: ScatterShape;
  /** Half-width in metres for Rect; the radius for Disc. */
  extentX: number;
  /** Half-depth in metres for Rect. Ignored by Disc. */
  extentZ: number;
  /** Instances per 100 m². */
  density: number;
  /** Hard cap, so a mistyped density cannot allocate a hundred million transforms. */
  maxInstances: number;
  minScale: number;
  maxScale: number;
  randomYaw: boolean;
  /** Local Y for every instance — there is no terrain to project onto yet. */
  groundHeight: number;
  visible: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
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
    seed: 1,
    shape: 'Rect',
    extentX: 20,
    extentZ: 20,
    density: 4,
    maxInstances: 20000,
    minScale: 0.8,
    maxScale: 1.25,
    randomYaw: true,
    groundHeight: 0,
    visible: true,
    // Off by default, and that is the whole point of the feature: shadow-casting a hundred
    // thousand instances is the single fastest way to turn a forest into a slideshow. Turn it
    // on deliberately, with the perf HUD open.
    castShadow: false,
    receiveShadow: true,
    ...overrides,
  };
}

registerComponent<ScatterLayerComponent>({
  type: 'ScatterLayer',
  label: 'Scatter Layer',
  create: createScatterLayer,
  fields() {
    return [
      { kind: 'enum', key: 'shape', label: 'Shape', options: SCATTER_SHAPES },
      { kind: 'number', key: 'extentX', label: 'Extent X', min: 0, step: 1 },
      { kind: 'number', key: 'extentZ', label: 'Extent Z', min: 0, step: 1 },
      { kind: 'number', key: 'density', label: 'Per 100 m²', min: 0, step: 0.5 },
      { kind: 'number', key: 'maxInstances', label: 'Max', min: 0, step: 1000, integer: true },
      { kind: 'number', key: 'seed', label: 'Seed', min: 1, step: 1, integer: true },
      { kind: 'number', key: 'minScale', label: 'Min Scale', min: 0.001, step: 0.05 },
      { kind: 'number', key: 'maxScale', label: 'Max Scale', min: 0.001, step: 0.05 },
      { kind: 'number', key: 'groundHeight', label: 'Ground Y', step: 0.1 },
      { kind: 'boolean', key: 'randomYaw', label: 'Random Yaw' },
      { kind: 'boolean', key: 'visible', label: 'Visible' },
      { kind: 'boolean', key: 'castShadow', label: 'Cast Shadows' },
      { kind: 'boolean', key: 'receiveShadow', label: 'Receive Shadows' },
    ];
  },
});
