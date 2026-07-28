import type { Component } from '../scene/types';
import { registerComponent, type FieldSchema } from './registry';

export const BACKGROUND_MODES = ['Color', 'Sky'] as const;
export type BackgroundMode = (typeof BACKGROUND_MODES)[number];

export const FOG_MODES = ['None', 'Linear', 'Exponential'] as const;
export type FogMode = (typeof FOG_MODES)[number];

/**
 * Scene-wide rendering settings: background, ambient light and fog.
 *
 * A component on an entity rather than a field on the Scene, which is worth justifying because
 * the alternative looks tidier at first. Making it a component means it round-trips through the
 * existing serializer, gets an Inspector for free from its field schema, and undoes through the
 * existing `SetComponentProperty` command — all with no new code. A `scene.environment` field
 * would need a schema migration, a bespoke panel and a bespoke command. Godot's WorldEnvironment
 * node makes the same call for the same reason.
 *
 * The first Environment component in scene order wins; the rest are ignored.
 */
export interface EnvironmentComponent extends Component {
  type: 'Environment';
  background: BackgroundMode;
  /** Flat background colour, and the clear colour behind a Sky. */
  backgroundColor: string;
  skyTopColor: string;
  skyHorizonColor: string;
  groundColor: string;
  ambientColor: string;
  ambientIntensity: number;
  fog: FogMode;
  fogColor: string;
  fogNear: number;
  fogFar: number;
  fogDensity: number;
  /**
   * Prefilter the sky into an environment map and light the scene with it.
   *
   * Not a nicety: `metalness = 1` means "the base colour is the reflection", so a metal with no
   * environment to reflect renders black however many lights are pointed at it. This is what
   * makes the PBR sliders behave the way an artist expects, and it is on by default for exactly
   * that reason — a new scene should show a believable metal, not a debugging exercise.
   *
   * Costs a handful of small render passes whenever the sky colours change, and nothing per
   * frame. Turn it off for a stylised look, or on a scene whose lighting is entirely analytic.
   */
  ibl: boolean;
  /** Multiplier on the environment's contribution. 0 is the same as turning `ibl` off. */
  iblIntensity: number;
}

export function createEnvironment(
  overrides: Partial<EnvironmentComponent> = {},
): EnvironmentComponent {
  return {
    type: 'Environment',
    background: 'Sky',
    backgroundColor: '#2b2b2b',
    skyTopColor: '#3f6fb5',
    skyHorizonColor: '#cfd9e6',
    groundColor: '#3a3630',
    ambientColor: '#8899bb',
    ambientIntensity: 0.5,
    fog: 'None',
    fogColor: '#c3cddb',
    fogNear: 20,
    fogFar: 300,
    fogDensity: 0.01,
    ibl: true,
    iblIntensity: 1,
    ...overrides,
  };
}

registerComponent<EnvironmentComponent>({
  type: 'Environment',
  label: 'Environment',
  create: createEnvironment,
  fields(component) {
    const fields: FieldSchema[] = [
      { kind: 'enum', key: 'background', label: 'Background', options: BACKGROUND_MODES },
    ];
    if (component.background === 'Sky') {
      fields.push(
        { kind: 'color', key: 'skyTopColor', label: 'Sky Top' },
        { kind: 'color', key: 'skyHorizonColor', label: 'Horizon' },
        { kind: 'color', key: 'groundColor', label: 'Ground' },
      );
    } else {
      fields.push({ kind: 'color', key: 'backgroundColor', label: 'Color' });
    }
    fields.push(
      { kind: 'color', key: 'ambientColor', label: 'Ambient Color' },
      { kind: 'number', key: 'ambientIntensity', label: 'Ambient', min: 0, max: 4, step: 0.05 },
      { kind: 'enum', key: 'fog', label: 'Fog', options: FOG_MODES },
    );
    if (component.fog === 'Linear') {
      fields.push(
        { kind: 'color', key: 'fogColor', label: 'Fog Color' },
        { kind: 'number', key: 'fogNear', label: 'Fog Start', min: 0, step: 1 },
        { kind: 'number', key: 'fogFar', label: 'Fog End', min: 0, step: 1 },
      );
    } else if (component.fog === 'Exponential') {
      fields.push(
        { kind: 'color', key: 'fogColor', label: 'Fog Color' },
        { kind: 'number', key: 'fogDensity', label: 'Density', min: 0, max: 1, step: 0.001 },
      );
    }
    fields.push(
      { kind: 'group', key: '@ibl', label: 'Environment Lighting' },
      { kind: 'boolean', key: 'ibl', label: 'From Sky' },
    );
    if (component.ibl) {
      fields.push({
        kind: 'number',
        key: 'iblIntensity',
        label: 'Intensity',
        min: 0,
        max: 4,
        step: 0.05,
      });
    }
    return fields;
  },
});
