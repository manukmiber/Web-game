import { LIGHT_UNITS, MAX_KELVIN, MIN_KELVIN, canCastShadow } from '../render/lighting';
import type { LightUnit } from '../render/lighting';
import type { Component } from '../scene/types';
import { registerComponent, type FieldSchema } from './registry';

export const LIGHT_TYPES = ['Directional', 'Point', 'Spot', 'Hemisphere', 'Area'] as const;
export type LightType = (typeof LIGHT_TYPES)[number];

export interface LightComponent extends Component {
  type: 'Light';
  lightType: LightType;
  /**
   * Off without being deleted.
   *
   * Worth a field of its own because the alternatives are both bad: setting intensity to zero
   * loses the value you had, and deleting the light loses its position, its cone and its shadow
   * settings. Lighting is an iterative business, and half of it is turning things off to see
   * what the others are doing.
   */
  enabled: boolean;
  color: string;
  /**
   * Tints `color` by a blackbody curve, so a lamp can be described the way lamps are sold.
   *
   * 2700 K is a warm bulb, 4000 K a fluorescent tube, 5600 K midday sun, 7500 K open shade. It
   * multiplies the colour rather than replacing it, so a coloured gel over a warm bulb is
   * expressible — which is how it works in a studio.
   */
  useTemperature: boolean;
  /** Kelvin. Ignored unless `useTemperature`. */
  temperature: number;
  intensity: number;
  /** How `intensity` is read — an arbitrary dial, or lumens and nits. See `LightUnit`. */
  unit: LightUnit;
  /** Point/Spot falloff distance. 0 means "no limit", which is Three's default. */
  range: number;
  /** Spot cone half-angle in degrees. */
  angle: number;
  /** Spot edge softness, 0..1. */
  penumbra: number;
  /** Area light size in metres. A softbox, a window, a strip light in a ceiling. */
  width: number;
  height: number;
  /** Hemisphere light's lower colour — the bounce off whatever the scene is standing on. */
  groundColor: string;
  castShadow: boolean;
  /**
   * Who keeps their shadow when the renderer's shadow budget cannot serve everyone.
   *
   * Higher wins, and it beats every other consideration — see `lightImportance`. The sun in a
   * daylight scene wants a high number, so that walking near a torch never costs the scene its
   * primary shadows.
   */
  shadowPriority: number;
  /**
   * Half-extent of a directional light's shadow frustum, in metres.
   *
   * Exposed rather than fixed because it is the one shadow control that actually matters: a
   * single shadow map stretched over a large area has no usable resolution anywhere, so this
   * is the dial between "sharp shadows near the player" and "shadows everywhere, all mushy".
   * Cascades, which remove the trade-off, arrive with the streaming work (ARCHITECTURE.md §9.4).
   */
  shadowRange: number;
  /** Rounded down to a power of two by the renderer; anything else wastes VRAM. */
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
    enabled: true,
    color: '#ffffff',
    useTemperature: false,
    temperature: 6500,
    intensity: 2,
    unit: 'Artistic',
    range: 20,
    angle: 35,
    penumbra: 0.3,
    width: 2,
    height: 1,
    groundColor: '#3a3630',
    castShadow: true,
    shadowPriority: 0,
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
      { kind: 'boolean', key: 'enabled', label: 'Enabled' },
      { kind: 'color', key: 'color', label: 'Color' },
    ];

    if (component.lightType === 'Hemisphere') {
      fields.push({ kind: 'color', key: 'groundColor', label: 'Ground Color' });
    }

    fields.push({ kind: 'boolean', key: 'useTemperature', label: 'Use Temperature' });
    if (component.useTemperature) {
      fields.push({
        kind: 'number',
        key: 'temperature',
        label: 'Temperature K',
        min: MIN_KELVIN,
        max: MAX_KELVIN,
        step: 100,
        integer: true,
      });
    }

    fields.push({
      kind: 'number',
      key: 'intensity',
      label: unitLabel(component),
      min: 0,
      step: component.unit === 'Physical' ? 10 : 0.1,
    });

    // Only the types whose intensity has a physical meaning are offered the choice. A
    // directional light's is an irradiance multiplier with no bulb behind it.
    if (component.lightType !== 'Directional' && component.lightType !== 'Hemisphere') {
      fields.push({ kind: 'enum', key: 'unit', label: 'Units', options: LIGHT_UNITS });
    }

    if (component.lightType === 'Point' || component.lightType === 'Spot') {
      fields.push({ kind: 'number', key: 'range', label: 'Range', min: 0, step: 0.5 });
    }
    if (component.lightType === 'Spot') {
      fields.push(
        { kind: 'number', key: 'angle', label: 'Cone Angle', min: 1, max: 89, step: 1 },
        { kind: 'number', key: 'penumbra', label: 'Penumbra', min: 0, max: 1, step: 0.05 },
      );
    }
    if (component.lightType === 'Area') {
      fields.push(
        { kind: 'number', key: 'width', label: 'Width', min: 0.01, step: 0.1 },
        { kind: 'number', key: 'height', label: 'Height', min: 0.01, step: 0.1 },
      );
    }

    if (!canCastShadow(component.lightType)) return fields;

    fields.push({ kind: 'boolean', key: 'castShadow', label: 'Cast Shadow' });
    if (component.castShadow) {
      fields.push({
        kind: 'number',
        key: 'shadowPriority',
        label: 'Shadow Priority',
        step: 1,
        integer: true,
      });
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

/** The intensity field says what it is measured in, since that now depends on two other fields. */
function unitLabel(component: LightComponent): string {
  if (component.unit !== 'Physical') return 'Intensity';
  if (component.lightType === 'Area') return 'Luminance (nits)';
  if (component.lightType === 'Point' || component.lightType === 'Spot') return 'Lumens';
  return 'Intensity';
}
