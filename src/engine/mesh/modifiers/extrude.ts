import { meshBounds, type MeshData } from '../MeshData';
import { sweepProfile } from '../sweep';
import { registerModifier, type Modifier } from './registry';
import { AXES, type Axis } from './mirror';
import type { Vec3 } from '../../scene/types';

export interface ExtrudeSettings {
  axis: Axis;
  /** How far the profile travels. Negative extrudes the other way. */
  distance: number;
  /** Rings along the way. Only worth raising when taper or twist is in play. */
  steps: number;
  /** Cross-section scale at the far end. 1 leaves it alone, 0 collapses it to a point. */
  taper: number;
  /** Degrees of rotation about the axis across the whole extrusion. */
  twist: number;
  capStart: boolean;
  capEnd: boolean;
}

export interface ExtrudeModifier extends Modifier, ExtrudeSettings {
  type: 'Extrude';
}

export const MAX_EXTRUDE_STEPS = 64;

/** The two axes perpendicular to `axis`, ordered so a positive twist is right-handed about it. */
const PERPENDICULAR: Record<Axis, [number, number]> = { X: [1, 2], Y: [2, 0], Z: [0, 1] };
const AXIS_INDEX: Record<Axis, number> = { X: 0, Y: 1, Z: 2 };

/**
 * Pushes a flat profile into a solid.
 *
 * This is the modifier that makes the 2D shapes worth having: a Star is a flat decoration until
 * it is extruded, and then it is a badge. Taper and twist turn the same operation into a spike,
 * a pyramid or a twisted column without needing a separate modifier for each.
 *
 * Taper and twist work about the profile's own centre rather than the object origin, so a shape
 * authored off to one side narrows toward itself instead of sliding sideways as it narrows.
 *
 * A closed solid has no border to sweep and passes through untouched. That is usually a sign the
 * intended operation was Solidify, which is what gives a *closed* surface thickness.
 */
export function extrude(mesh: MeshData, settings: ExtrudeSettings): MeshData {
  const steps = Math.max(1, Math.min(MAX_EXTRUDE_STEPS, Math.floor(settings.steps) || 1));
  const axis = AXIS_INDEX[settings.axis];
  const [u, v] = PERPENDICULAR[settings.axis];
  const taper = Math.max(0, settings.taper);
  const twist = (settings.twist * Math.PI) / 180;

  const bounds = meshBounds(mesh);
  const centreU = bounds ? (bounds.min[u]! + bounds.max[u]!) / 2 : 0;
  const centreV = bounds ? (bounds.min[v]! + bounds.max[v]!) / 2 : 0;

  return sweepProfile(mesh, {
    steps,
    capStart: settings.capStart,
    capEnd: settings.capEnd,
    at(point, t) {
      const scale = 1 + (taper - 1) * t;
      const angle = twist * t;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const du = (point[u]! - centreU) * scale;
      const dv = (point[v]! - centreV) * scale;

      const out: Vec3 = [point[0], point[1], point[2]];
      out[u] = centreU + du * cos - dv * sin;
      out[v] = centreV + du * sin + dv * cos;
      out[axis] = point[axis]! + settings.distance * t;
      return out;
    },
  });
}

export function createExtrudeModifier(overrides: Partial<ExtrudeModifier> = {}): ExtrudeModifier {
  return {
    type: 'Extrude',
    enabled: true,
    axis: 'Y',
    distance: 0.5,
    steps: 1,
    taper: 1,
    twist: 0,
    capStart: true,
    capEnd: true,
    ...overrides,
  };
}

registerModifier<ExtrudeModifier>({
  type: 'Extrude',
  label: 'Extrude',
  create: createExtrudeModifier,
  fields: () => [
    { kind: 'enum', key: 'axis', label: 'Axis', options: AXES },
    { kind: 'number', key: 'distance', label: 'Distance', step: 0.1 },
    {
      kind: 'number',
      key: 'steps',
      label: 'Steps',
      min: 1,
      max: MAX_EXTRUDE_STEPS,
      step: 1,
      integer: true,
    },
    { kind: 'number', key: 'taper', label: 'Taper', min: 0, step: 0.05 },
    { kind: 'number', key: 'twist', label: 'Twist °', step: 5 },
    { kind: 'boolean', key: 'capStart', label: 'Cap Start' },
    { kind: 'boolean', key: 'capEnd', label: 'Cap End' },
  ],
  apply: (mesh, modifier) => extrude(mesh, modifier),
});
