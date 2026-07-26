import * as THREE from 'three';
import type { Vec3 } from '@engine/scene/types';

export const RAD2DEG = 180 / Math.PI;
export const DEG2RAD = Math.PI / 180;
export const TWO_PI = Math.PI * 2;

/**
 * The pure geometry behind the transform gizmo.
 *
 * Split out from the Three.js handle meshes so every rule that decides *what a drag means*
 * can be tested without a renderer, a canvas or a pointer. The previous gizmo drove
 * everything through a proxy object and re-derived each entity's transform by decomposing a
 * matrix product every frame, which is where its two worst bugs came from — see
 * `eulerDegreesNear` and `scaleFactorsForFrame` below.
 */

// --------------------------------------------------------------------- rays

/**
 * Point on the infinite line `(origin, direction)` closest to `ray`.
 *
 * This is what makes an axis drag track the pointer: the handle can only move along its own
 * axis, so the pointer's ray is projected onto that axis rather than intersected with it —
 * the two almost never actually meet in 3D.
 *
 * Returns null when the ray is within `epsilon` of parallel to the line, where the closest
 * point is unbounded and any answer would be a wild jump.
 */
export function closestPointOnLine(
  ray: THREE.Ray,
  lineOrigin: THREE.Vector3,
  lineDirection: THREE.Vector3,
  target = new THREE.Vector3(),
  epsilon = 1e-4,
): THREE.Vector3 | null {
  const u = ray.direction;
  const v = lineDirection;
  const w0 = _v1.copy(ray.origin).sub(lineOrigin);

  const b = u.dot(v);
  const denominator = 1 - b * b;
  if (Math.abs(denominator) < epsilon) return null;

  const d = u.dot(w0);
  const e = v.dot(w0);
  const s = (e - b * d) / denominator;
  return target.copy(lineDirection).multiplyScalar(s).add(lineOrigin);
}

/** Ray/plane intersection, or null when the ray runs parallel to the plane. */
export function intersectPlane(
  ray: THREE.Ray,
  planePoint: THREE.Vector3,
  planeNormal: THREE.Vector3,
  target = new THREE.Vector3(),
): THREE.Vector3 | null {
  _plane.setFromNormalAndCoplanarPoint(planeNormal, planePoint);
  return ray.intersectPlane(_plane, target);
}

/** Signed angle from `from` to `to` measured about `axis`, in radians, range (-π, π]. */
export function signedAngle(
  from: THREE.Vector3,
  to: THREE.Vector3,
  axis: THREE.Vector3,
): number {
  const cross = _v2.crossVectors(from, to);
  return Math.atan2(cross.dot(axis), from.dot(to));
}

/**
 * Shifts `angle` by whole turns so it lands within half a turn of `previous`.
 *
 * Rotation handles are dragged past ±180° all the time, and `signedAngle` wraps there. Without
 * unwrapping, a ring drag snaps to the opposite direction the moment it crosses the seam.
 */
export function unwrapAngle(angle: number, previous: number): number {
  return angle + TWO_PI * Math.round((previous - angle) / TWO_PI);
}

/** Quantises to the nearest multiple of `increment`. A non-positive increment is a no-op. */
export function snap(value: number, increment: number): number {
  if (!(increment > 0)) return value;
  return Math.round(value / increment) * increment;
}

// ------------------------------------------------------------------- euler

/**
 * Euler angles in degrees (XYZ order) for `quaternion`, choosing the representation closest
 * to `previous`.
 *
 * This is the fix for the single most visible bug in the old gizmo. `Euler.setFromQuaternion`
 * always returns the branch with Y in [-90°, 90°], so rotating a box 94° about Y came back as
 * `(-180, 86.2, -180)` — the same orientation, written in a way that is useless to read and
 * impossible to continue dragging smoothly.
 *
 * Every XYZ orientation has exactly two Euler solutions modulo full turns:
 *
 *     (x, y, z)  ≡  (x + 180°, 180° − y, z + 180°)
 *
 * Both are generated, each angle is then shifted by whole turns toward the previous value, and
 * whichever total is nearest the previous reading wins. That keeps the Inspector readable, lets
 * angles run continuously past 180° instead of flipping sign, and stops a second drag from
 * starting out of a different branch than the first one ended in.
 */
export function eulerDegreesNear(quaternion: THREE.Quaternion, previous: Vec3): Vec3 {
  const base = _euler.setFromQuaternion(quaternion, 'XYZ');
  const candidates: Vec3[] = [
    [base.x * RAD2DEG, base.y * RAD2DEG, base.z * RAD2DEG],
    [base.x * RAD2DEG + 180, 180 - base.y * RAD2DEG, base.z * RAD2DEG + 180],
  ];

  let best: Vec3 = candidates[0]!;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const shifted: Vec3 = [
      nearestTurn(candidate[0], previous[0]),
      nearestTurn(candidate[1], previous[1]),
      nearestTurn(candidate[2], previous[2]),
    ];
    const distance =
      Math.abs(shifted[0] - previous[0]) +
      Math.abs(shifted[1] - previous[1]) +
      Math.abs(shifted[2] - previous[2]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = shifted;
    }
  }
  return best;
}

function nearestTurn(degrees: number, previous: number): number {
  return degrees + 360 * Math.round((previous - degrees) / 360);
}

/** Quaternion for a transform's Euler degrees, in the XYZ order the Scene stores. */
export function quaternionFromDegrees(
  rotation: Vec3,
  target = new THREE.Quaternion(),
): THREE.Quaternion {
  _euler.set(rotation[0] * DEG2RAD, rotation[1] * DEG2RAD, rotation[2] * DEG2RAD, 'XYZ');
  return target.setFromEuler(_euler);
}

// ------------------------------------------------------------------- scale

/**
 * Maps a per-axis scale factor expressed in the gizmo's frame onto an entity's own axes.
 *
 * Scale is stored per object in its *local* frame, so a non-uniform factor only makes sense
 * when the object's axes line up with the gizmo's. When they do — the overwhelmingly common
 * case, including every single-object drag in local space — the factors are permuted onto the
 * matching local axes and the result is exact.
 *
 * When they do not (a rotated object dragged in world space, or a multi-selection of
 * differently rotated objects), a per-axis factor would need shear, which a
 * position/rotation/scale transform cannot store. The old gizmo tried anyway: it built the
 * sheared matrix and let `Matrix4.decompose` throw the shear away, which silently rotated the
 * object — dragging the X scale handle on a 45°-rotated box moved its rotation from 45° to
 * 42.7°. Falling back to the uniform mean keeps the drag honest: the object grows, and nothing
 * that was not asked for changes.
 */
export function scaleFactorsForFrame(
  factors: Vec3,
  gizmoQuaternion: THREE.Quaternion,
  entityQuaternion: THREE.Quaternion,
  epsilon = 1e-3,
): Vec3 {
  // Rotation taking the gizmo's frame to the entity's.
  const relative = _q1.copy(gizmoQuaternion).invert().multiply(entityQuaternion);
  const out: Vec3 = [1, 1, 1];

  for (let localAxis = 0; localAxis < 3; localAxis += 1) {
    _v1.set(localAxis === 0 ? 1 : 0, localAxis === 1 ? 1 : 0, localAxis === 2 ? 1 : 0);
    _v1.applyQuaternion(relative);

    // Which gizmo axis is this local axis parallel to, if any?
    let matched = -1;
    for (let gizmoAxis = 0; gizmoAxis < 3; gizmoAxis += 1) {
      const component = Math.abs(_v1.getComponent(gizmoAxis));
      if (component > 1 - epsilon) matched = gizmoAxis;
      else if (component > epsilon) return uniform(factors);
    }
    if (matched === -1) return uniform(factors);
    out[localAxis] = factors[matched]!;
  }
  return out;
}

function uniform(factors: Vec3): Vec3 {
  const product = Math.abs(factors[0] * factors[1] * factors[2]);
  const mean = Math.cbrt(product) * Math.sign(factors[0] * factors[1] * factors[2] || 1);
  return [mean, mean, mean];
}

/**
 * Trims float noise so the Inspector reads "1" rather than "0.9999999999999998" and a snapped
 * drag lands exactly on its increment.
 */
export function tidy(value: number): number {
  return Math.abs(value) < 1e-9 ? 0 : Number(value.toFixed(5));
}

export function tidyVec(value: THREE.Vector3 | Vec3): Vec3 {
  const [x, y, z] = Array.isArray(value) ? value : [value.x, value.y, value.z];
  return [tidy(x!), tidy(y!), tidy(z!)];
}

// Module-scope scratch. The gizmo runs these on every pointer move for every selected entity,
// and allocating vectors in that path is exactly the kind of per-frame garbage the frame
// budget in ARCHITECTURE.md §9.7 is measured against.
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _plane = new THREE.Plane();
