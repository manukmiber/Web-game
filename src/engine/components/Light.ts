import type { Component } from '../scene/types';
import { registerComponent, type FieldSchema } from './registry';

export const LIGHT_TYPES = ['Directional', 'Point', 'Spot'] as const;
export type LightType = (typeof LIGHT_TYPES)[number];

export interface LightComponent extends Component {
  type: 'Light';
  lightType: LightType;
  color: string;
  intensity: number;
  /** Point/Spot falloff distance. 0 means "no limit", which is Three's default. */
  range: number;
  /** Spot cone half-angle in degrees. */
  angle: number;
  /** Spot edge softness, 0..1. */
  penumbra: number;
  castShadow: boolean;
  /**
   * Half-extent of a directional light's shadow frustum, in metres.
   *
   * Exposed rather than fixed because it is the one shadow control that actually matters: a
   * single shadow map stretched over a large area has no usable resolution anywhere, so this
   * is the dial between "sharp shadows near the player" and "shadows everywhere, all mushy".
   * Cascades, which remove the trade-off, arrive with the streaming work (ARCHITECTURE.md §9.4).
   */
  shadowRange: number;
  /** Rounded up to a power of two by the renderer; anything else wastes VRAM. */
  shadowMapSize: number;
  shadowBias: number;
  /**
   * Shadow lookup offset along the surface normal, in world units.
   *
   * The companion to `shadowBias`, and the one that actually fixes shadow acne on curved
   * surfaces. Depth bias alone can only trade acne for peter-panning — push it far enough to
   * clean up a sphere and contact shadows detach from whatever is casting them. Offsetting
   * along the normal instead scales the correction with how obliquely the light hits, which is
   * exactly where the error comes from.
   *
   * Optional in the type because scenes saved before v0.7.3 do not carry it; readers default it.
   */
  shadowNormalBias?: number;
}

export function createLight(overrides: Partial<LightComponent> = {}): LightComponent {
  return {
    type: 'Light',
    lightType: 'Directional',
    color: '#ffffff',
    intensity: 2,
    range: 20,
    angle: 35,
    penumbra: 0.3,
    castShadow: true,
    shadowRange: 30,
    shadowMapSize: 2048,
    shadowBias: -0.0005,
    shadowNormalBias: 0.02,
    ...overrides,
  };
}

registerComponent<LightComponent>({
  type: 'Light',
  label: 'Light',
  create: createLight,
  fields(component) {
    const fields: FieldSchema[] = [
      { kind: 'enum', key: 'lightType', label: 'Type', options: LIGHT_TYPES },
      { kind: 'color', key: 'color', label: 'Color' },
      { kind: 'number', key: 'intensity', label: 'Intensity', min: 0, step: 0.1 },
    ];

    if (component.lightType !== 'Directional') {
      fields.push({ kind: 'number', key: 'range', label: 'Range', min: 0, step: 0.5 });
    }
    if (component.lightType === 'Spot') {
      fields.push(
        { kind: 'number', key: 'angle', label: 'Cone Angle', min: 1, max: 89, step: 1 },
        { kind: 'number', key: 'penumbra', label: 'Penumbra', min: 0, max: 1, step: 0.05 },
      );
    }

    fields.push({ kind: 'boolean', key: 'castShadow', label: 'Cast Shadow' });
    if (component.castShadow) {
      if (component.lightType === 'Directional') {
        fields.push({ kind: 'number', key: 'shadowRange', label: 'Shadow Range', min: 1, step: 1 });
      }
      fields.push(
        {
          kind: 'number',
          key: 'shadowMapSize',
          label: 'Shadow Map',
          min: 256,
          max: 4096,
          step: 256,
          integer: true,
        },
        { kind: 'number', key: 'shadowBias', label: 'Shadow Bias', step: 0.0001 },
        {
          kind: 'number',
          key: 'shadowNormalBias',
          label: 'Normal Bias',
          min: 0,
          max: 1,
          step: 0.005,
        },
      );
    }
    return fields;
  },
});
