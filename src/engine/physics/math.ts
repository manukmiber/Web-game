/**
 * Vector, quaternion and transform maths for the physics solver.
 *
 * Deliberately not Three.js. The solver has to run in a Worker and in a headless test
 * (ARCHITECTURE.md §9.5), and `three` pulls a renderer's worth of module graph behind it for
 * what amounts to twenty lines of arithmetic. It is also the difference between a physics test
 * that runs in single-digit milliseconds and one that spends longer importing than simulating.
 *
 * Everything here operates on plain `Vec3` tuples — the same type the scene stores — so nothing
 * has to be converted on the way in or out.
 */

import type { Vec3 } from '../scene/types';

/** Quaternion as `[x, y, z, w]`, matching Three's component order. */
export type Quat = [number, number, number, number];

/**
 * Module-private rather than exported: `ai/steering` already owns the public pair, and two
 * modules exporting the same constant through `engine/index` is an ambiguity TypeScript is
 * right to refuse.
 */
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Below this, a length is treated as zero rather than divided by. */
export const EPSILON = 1e-9;

// ------------------------------------------------------------------- vectors

export function vec(x = 0, y = 0, z = 0): Vec3 {
  return [x, y, z];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function mul(a: Vec3, b: Vec3): Vec3 {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function lengthSq(a: Vec3): number {
  return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
}

export function length(a: Vec3): number {
  return Math.sqrt(lengthSq(a));
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Unit vector, or `fallback` when the input is too short to have a direction. */
export function normalize(a: Vec3, fallback: Vec3 = [0, 1, 0]): Vec3 {
  const len = length(a);
  if (len < EPSILON) return [...fallback];
  return [a[0] / len, a[1] / len, a[2] / len];
}

export function negate(a: Vec3): Vec3 {
  return [-a[0], -a[1], -a[2]];
}

export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** True when every component is finite. Guards the solver against a NaN entering the scene. */
export function isFiniteVec(a: Vec3): boolean {
  return Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);
}

// --------------------------------------------------------------- quaternions

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

/**
 * Euler angles in degrees, XYZ order — the convention the Transform stores and the Inspector
 * shows — converted to a quaternion.
 *
 * XYZ means the rotations compose as `R = Rx · Ry · Rz` applied to a column vector, which is
 * Three's `Euler` default. Getting this order wrong is invisible on a single axis and obviously
 * wrong the moment two are combined, so it is worth stating rather than inferring.
 */
export function quatFromEuler(euler: Vec3): Quat {
  const hx = euler[0] * DEG2RAD * 0.5;
  const hy = euler[1] * DEG2RAD * 0.5;
  const hz = euler[2] * DEG2RAD * 0.5;
  const cx = Math.cos(hx);
  const sx = Math.sin(hx);
  const cy = Math.cos(hy);
  const sy = Math.sin(hy);
  const cz = Math.cos(hz);
  const sz = Math.sin(hz);

  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

/** Hamilton product — `a` then `b` read right to left, matching matrix composition. */
export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Unit quaternions are their own inverse but for the sign of the vector part. */
export function quatConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function quatRotate(q: Quat, v: Vec3): Vec3 {
  // t = 2 * (qv × v); result = v + q.w * t + qv × t. Two crosses rather than building a matrix.
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** Rotates by the inverse — world space back into a body's local frame. */
export function quatRotateInverse(q: Quat, v: Vec3): Vec3 {
  return quatRotate(quatConjugate(q), v);
}

export function quatNormalize(q: Quat): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (len < EPSILON) return [...IDENTITY_QUAT];
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/**
 * Quaternion back to XYZ Euler degrees, for writing a rotation into a Transform.
 *
 * The gimbal-lock branch matters: at ±90° of pitch the other two angles become degenerate, and
 * without the clamp the `atan2` pair returns NaN for a perfectly valid orientation.
 */
export function eulerFromQuat(q: Quat): Vec3 {
  const [x, y, z, w] = quatNormalize(q);

  const m13 = 2 * (x * z + w * y);
  const clamped = clamp(m13, -1, 1);
  const yAngle = Math.asin(clamped);

  if (Math.abs(clamped) < 0.9999999) {
    const m23 = 2 * (y * z - w * x);
    const m33 = 1 - 2 * (x * x + y * y);
    const m12 = 2 * (x * y - w * z);
    const m11 = 1 - 2 * (y * y + z * z);
    return [
      Math.atan2(-m23, m33) * RAD2DEG,
      yAngle * RAD2DEG,
      Math.atan2(-m12, m11) * RAD2DEG,
    ];
  }

  const m32 = 2 * (y * z + w * x);
  const m22 = 1 - 2 * (x * x + z * z);
  return [Math.atan2(m32, m22) * RAD2DEG, yAngle * RAD2DEG, 0];
}

// ---------------------------------------------------------------- transforms

/** A position/orientation/scale triple, the form the solver actually works in. */
export interface RigidTransform {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

export function identityTransform(): RigidTransform {
  return { position: [0, 0, 0], rotation: [...IDENTITY_QUAT], scale: [1, 1, 1] };
}

/** Local point to world space. Scale first, then rotation, then translation. */
export function transformPoint(t: RigidTransform, point: Vec3): Vec3 {
  return add(t.position, quatRotate(t.rotation, mul(point, t.scale)));
}

/** World point back into the transform's local space. */
export function inverseTransformPoint(t: RigidTransform, point: Vec3): Vec3 {
  const local = quatRotateInverse(t.rotation, sub(point, t.position));
  return [
    t.scale[0] !== 0 ? local[0] / t.scale[0] : 0,
    t.scale[1] !== 0 ? local[1] / t.scale[1] : 0,
    t.scale[2] !== 0 ? local[2] / t.scale[2] : 0,
  ];
}

/** Directions ignore translation, and ignore scale — a normal stays a unit vector. */
export function transformDirection(t: RigidTransform, direction: Vec3): Vec3 {
  return quatRotate(t.rotation, direction);
}

/**
 * `parent` composed with `child`, the same order a scene graph applies them.
 *
 * Non-uniform parent scale combined with child rotation is not exactly representable as another
 * position/quaternion/scale triple — it shears. This composes the closest thing that is, which
 * is precisely what Three's own `Object3D` hierarchy does when it decomposes a world matrix, so
 * the physics body and the rendered mesh agree even in the case where both are approximating.
 */
export function composeTransforms(parent: RigidTransform, child: RigidTransform): RigidTransform {
  return {
    position: transformPoint(parent, child.position),
    rotation: quatNormalize(quatMultiply(parent.rotation, child.rotation)),
    scale: mul(parent.scale, child.scale),
  };
}

/**
 * Largest of a scale's three components.
 *
 * Spheres and capsules have one radius, so a non-uniformly scaled one has to pick a number.
 * Picking the largest keeps the collider fully enclosing the mesh it was authored around, which
 * is the safe direction to be wrong in: objects stop slightly early rather than sinking in.
 */
export function maxScale(s: Vec3): number {
  return Math.max(Math.abs(s[0]), Math.abs(s[1]), Math.abs(s[2]));
}

// ------------------------------------------------------------- segment maths

/** Closest point on the segment `a`→`b` to `point`. */
export function closestPointOnSegment(a: Vec3, b: Vec3, point: Vec3): Vec3 {
  const ab = sub(b, a);
  const lenSq = lengthSq(ab);
  if (lenSq < EPSILON) return [...a];
  const t = clamp(dot(sub(point, a), ab) / lenSq, 0, 1);
  return add(a, scale(ab, t));
}

/**
 * Closest pair of points between two segments.
 *
 * The parallel case is the one that has to be handled explicitly: the usual determinant
 * solution divides by zero when the segments line up, which is exactly the configuration two
 * upright capsules standing next to each other are in.
 */
export function closestPointsBetweenSegments(
  p1: Vec3,
  q1: Vec3,
  p2: Vec3,
  q2: Vec3,
): { a: Vec3; b: Vec3 } {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = lengthSq(d1);
  const e = lengthSq(d2);
  const f = dot(d2, r);

  let s: number;
  let t: number;

  if (a < EPSILON && e < EPSILON) return { a: [...p1], b: [...p2] };
  if (a < EPSILON) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = dot(d1, r);
    if (e < EPSILON) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > EPSILON ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }

  return { a: add(p1, scale(d1, s)), b: add(p2, scale(d2, t)) };
}
