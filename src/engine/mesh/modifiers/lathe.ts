import { weldVertices, type MeshData } from '../MeshData';
import { sweepProfile } from '../sweep';
import { registerModifier, type Modifier } from './registry';
import { AXES, type Axis } from './mirror';
import type { Vec3 } from '../../scene/types';

export interface LatheSettings {
  /** Spin axis, through the object origin. */
  axis: Axis;
  /** Degrees swept. 360 closes the surface onto itself. */
  angle: number;
  /** Rings around the sweep. This is the smoothness dial. */
  segments: number;
  /** Travel along the axis over the whole sweep. Non-zero turns a lathe into a screw. */
  rise: number;
  capStart: boolean;
  capEnd: boolean;
}

export interface LatheModifier extends Modifier, LatheSettings {
  type: 'Lathe';
}

export const MAX_LATHE_SEGMENTS = 256;

const AXIS_INDEX: Record<Axis, number> = { X: 0, Y: 1, Z: 2 };
/** The two axes the rotation acts in, ordered so a positive angle turns right-handed. */
const PERPENDICULAR: Record<Axis, [number, number]> = { X: [1, 2], Y: [2, 0], Z: [0, 1] };

/**
 * Revolves a profile's border around an axis: the classic lathe, plus screws and springs.
 *
 * The input is a profile *surface*, not a curve, because that is what the rest of the pipeline
 * deals in — so revolving a Circle 360° gives a torus, a Rectangle gives a square-section ring,
 * and a Star gives a ring with a star cross-section. Sweeping less than a full turn leaves the
 * two ends open, and the caps close them with copies of the profile itself.
 *
 * **The profile has to lie in a plane containing the axis**, or there is nothing to revolve — a
 * ground-plane shape spun about Y only slides around inside its own plane. The 2D shapes are
 * built in XZ, so X and Z work directly and Y wants the profile stood up first, with the
 * object's rotation or a Transform modifier. Z is the default for that reason.
 *
 * `rise` converts the revolution into a helix. One turn plus a rise is a screw thread; several
 * turns (angle beyond 360) plus a rise is a spring.
 */
export function lathe(mesh: MeshData, settings: LatheSettings): MeshData {
  const segments = Math.max(3, Math.min(MAX_LATHE_SEGMENTS, Math.floor(settings.segments) || 3));
  const axis = AXIS_INDEX[settings.axis];
  const [u, v] = PERPENDICULAR[settings.axis];
  const total = (settings.angle * Math.PI) / 180;

  // A full turn with no rise brings the last ring back onto the first, so it shares vertices
  // instead of leaving a seam two vertices thick.
  const closed =
    Math.abs(Math.abs(settings.angle) % 360) < 1e-6 &&
    Math.abs(settings.angle) >= 360 - 1e-6 &&
    Math.abs(settings.rise) < 1e-9;

  const swept = sweepProfile(mesh, {
    steps: segments,
    closed,
    capStart: settings.capStart,
    capEnd: settings.capEnd,
    smoothWalls: true,
    at(point, t) {
      const angle = total * t;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const out: Vec3 = [point[0], point[1], point[2]];
      out[u] = point[u]! * cos - point[v]! * sin;
      out[v] = point[u]! * sin + point[v]! * cos;
      out[axis] = point[axis]! + settings.rise * t;
      return out;
    },
  });

  // Points sitting on the axis trace no circle, so every ring puts a vertex in the same place.
  // Welding turns that column of duplicates into the single pole it should have been — which is
  // what stops a half-disc lathed into a sphere from having a split down its poles.
  return weldVertices(swept, 1e-6);
}

export function createLatheModifier(overrides: Partial<LatheModifier> = {}): LatheModifier {
  return {
    type: 'Lathe',
    enabled: true,
    axis: 'Z',
    angle: 360,
    segments: 24,
    rise: 0,
    capStart: true,
    capEnd: true,
    ...overrides,
  };
}

registerModifier<LatheModifier>({
  type: 'Lathe',
  label: 'Lathe (Revolve / Screw)',
  create: createLatheModifier,
  fields: (modifier) => [
    { kind: 'enum', key: 'axis', label: 'Axis', options: AXES },
    { kind: 'number', key: 'angle', label: 'Angle °', step: 15 },
    {
      kind: 'number',
      key: 'segments',
      label: 'Segments',
      min: 3,
      max: MAX_LATHE_SEGMENTS,
      step: 1,
      integer: true,
    },
    { kind: 'number', key: 'rise', label: 'Rise', step: 0.1 },
    // A closed revolution has no open ends, so offering to cap them would be a lie.
    ...(Math.abs(modifier.angle) >= 360 - 1e-6 && Math.abs(modifier.rise) < 1e-9
      ? []
      : ([
          { kind: 'boolean', key: 'capStart', label: 'Cap Start' },
          { kind: 'boolean', key: 'capEnd', label: 'Cap End' },
        ] as const)),
  ],
  apply: (mesh, modifier) => lathe(mesh, modifier),
});
