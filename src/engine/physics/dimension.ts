/**
 * What makes the solver two-dimensional.
 *
 * The engine has one physics engine, not two. A separate 2D solver is the obvious way to ship 2D
 * — it is what Unity did, and it left that project with two collider hierarchies, two sets of
 * layer settings, two raycast APIs and a permanent question about which one a component belongs
 * to. Everything a 2D game needs from a solver is already here: circles are spheres, rectangles
 * are boxes, and sequential impulses do not care how many axes they run over.
 *
 * So 2D is a *constraint on the 3D world* rather than a parallel implementation. Four things
 * happen when a scene declares itself 2D, and nothing else in the simulation changes:
 *
 * 1. Bodies are held on the simulation plane — the depth coordinate is snapped, not integrated.
 * 2. The depth axis is locked, in velocity and in positional correction alike.
 * 3. Gravity is projected into the plane, so an XY scene with default gravity still falls down.
 * 4. Contact normals and query directions are projected into the plane and renormalised, so
 *    nothing is ever pushed out of it by a contact with a shape that has depth.
 *
 * The payoff is that every feature reaches both dimensions at once. Triggers, layers, sleeping,
 * restitution, the character controller, the script API, `explode` — none of them has a 2D
 * variant to write, because none of them knows which mode it is running in.
 */

import type { Vec3 } from '../scene/types';
import { EPSILON, length, scale } from './math';

export const PHYSICS_MODES = ['3D', '2D'] as const;
export type PhysicsMode = (typeof PHYSICS_MODES)[number];

/**
 * Which world plane a 2D scene lives in.
 *
 * `XY` is the platformer: gravity down the screen, depth along Z, and a scene authored looking
 * down -Z with an orthographic-feeling camera. `XZ` is the top-down: gravity out of the plane, so
 * it is usually set to zero, and the world is a floor. Both are common enough that picking one
 * would make the other awkward, and the cost of supporting both is this enum plus an axis index.
 */
export const SIMULATION_PLANES = ['XY', 'XZ'] as const;
export type SimulationPlane = (typeof SIMULATION_PLANES)[number];

export interface Dimensionality {
  mode: PhysicsMode;
  plane: SimulationPlane;
  /** Where the plane sits along the depth axis. Bodies are held here in 2D. */
  depth: number;
}

export const DEFAULT_DIMENSIONALITY: Dimensionality = { mode: '3D', plane: 'XY', depth: 0 };

/** Index into a Vec3 of the axis a 2D world does *not* simulate. */
export function depthAxis(plane: SimulationPlane): 0 | 1 | 2 {
  return plane === 'XZ' ? 1 : 2;
}

/** The two axes a 2D world does simulate, in order. */
export function planeAxes(plane: SimulationPlane): [0 | 1 | 2, 0 | 1 | 2] {
  return plane === 'XZ' ? [0, 2] : [0, 1];
}

export function is2D(dimensionality: Dimensionality): boolean {
  return dimensionality.mode === '2D';
}

/** A copy of `v` with the depth component zeroed. Returns `v` untouched in 3D. */
export function flatten(v: Vec3, dimensionality: Dimensionality): Vec3 {
  if (dimensionality.mode !== '2D') return v;
  const out: Vec3 = [v[0], v[1], v[2]];
  out[depthAxis(dimensionality.plane)] = 0;
  return out;
}

/** A copy of `p` moved onto the simulation plane. Returns `p` untouched in 3D. */
export function onPlane(p: Vec3, dimensionality: Dimensionality): Vec3 {
  if (dimensionality.mode !== '2D') return p;
  const out: Vec3 = [p[0], p[1], p[2]];
  out[depthAxis(dimensionality.plane)] = dimensionality.depth;
  return out;
}

/**
 * Projects a unit vector into the plane and renormalises it.
 *
 * Needed for contact normals, which come out of a narrowphase that knows nothing about the mode:
 * a circle resting on the top face of a box that has depth can produce a normal with a depth
 * component, and using it unprojected would push the body off the plane — where the snap would
 * drag it straight back, once per step, forever. Returns null when the normal is entirely along
 * the depth axis, which is a contact a 2D world has no business resolving.
 */
export function flattenNormal(normal: Vec3, dimensionality: Dimensionality): Vec3 | null {
  if (dimensionality.mode !== '2D') return normal;
  const flat = flatten(normal, dimensionality);
  const len = length(flat);
  if (len < EPSILON) return null;
  return scale(flat, 1 / len);
}

/** True when a Vec3 lies on the simulation plane, within `tolerance`. Always true in 3D. */
export function isOnPlane(p: Vec3, dimensionality: Dimensionality, tolerance = 1e-6): boolean {
  if (dimensionality.mode !== '2D') return true;
  return Math.abs(p[depthAxis(dimensionality.plane)]! - dimensionality.depth) <= tolerance;
}

/**
 * Axis locks a body gets from the world's dimensionality, merged with its own.
 *
 * Merged rather than replaced: a 2D body may still lock X to make a lift that only moves
 * vertically, and the depth lock is added to whatever it asked for.
 */
export function withDepthLock(
  locks: readonly [boolean, boolean, boolean],
  dimensionality: Dimensionality,
): [boolean, boolean, boolean] {
  const out: [boolean, boolean, boolean] = [locks[0], locks[1], locks[2]];
  if (dimensionality.mode === '2D') out[depthAxis(dimensionality.plane)] = true;
  return out;
}
