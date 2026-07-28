/**
 * Ray against world shape.
 *
 * Raycasting is not a nicety bolted onto a physics engine, it is half of what one is for: a
 * character stands on the ground because a ray found it, a gun hits because a ray hit, and a
 * camera stops at a wall because a ray stopped there. All of that goes through this file.
 *
 * Every function takes a **unit** direction and returns the distance along it, so a caller can
 * compare hits from different shapes without normalising anything twice.
 */

import type { Vec3 } from '../scene/types';
import {
  add,
  clamp,
  dot,
  EPSILON,
  length,
  normalize,
  quatRotate,
  quatRotateInverse,
  scale,
  sub,
} from './math';
import { closestPointOnSegment } from './math';
import type { WorldShape } from './shapes';

export interface RayHitGeometry {
  /** Distance along the ray, in metres. */
  distance: number;
  point: Vec3;
  /** Surface normal at the hit, pointing back out of the shape. */
  normal: Vec3;
}

/**
 * Nearest intersection with `shape`, or null.
 *
 * A ray that starts inside a solid reports a hit at distance zero with the normal facing the
 * ray. Reporting nothing would be the other option and it is the wrong one: "am I inside
 * something" is a question worth being able to answer, and a silent miss makes a stuck
 * character look like a missing collider.
 */
export function raycastShape(
  shape: WorldShape,
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
): RayHitGeometry | null {
  switch (shape.kind) {
    case 'sphere':
      return raySphere(origin, direction, maxDistance, shape.center, shape.radius);
    case 'box':
      return rayBox(origin, direction, maxDistance, shape);
    case 'capsule':
      return rayCapsule(origin, direction, maxDistance, shape);
    case 'plane':
    default:
      return rayPlane(origin, direction, maxDistance, shape);
  }
}

function raySphere(
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  center: Vec3,
  radius: number,
): RayHitGeometry | null {
  const toCenter = sub(origin, center);
  const b = dot(toCenter, direction);
  const c = dot(toCenter, toCenter) - radius * radius;

  // Pointing away from a sphere the ray is outside of: no need for the discriminant.
  if (c > 0 && b > 0) return null;

  const discriminant = b * b - c;
  if (discriminant < 0) return null;

  const root = Math.sqrt(discriminant);
  // Near root first; if it is behind the origin the ray started inside, so clamp to zero.
  const distance = Math.max(0, -b - root);
  if (distance > maxDistance) return null;

  const point = add(origin, scale(direction, distance));
  return { distance, point, normal: normalize(sub(point, center), scale(direction, -1)) };
}

function rayBox(
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  shape: Extract<WorldShape, { kind: 'box' }>,
): RayHitGeometry | null {
  // Slab test in the box's own frame, which turns an oriented box back into an axis-aligned one.
  const localOrigin = quatRotateInverse(shape.rotation, sub(origin, shape.center));
  const localDirection = quatRotateInverse(shape.rotation, direction);

  let near = 0;
  let far = maxDistance;
  let axis = 0;
  let sign = 1;

  for (let i = 0; i < 3; i += 1) {
    const half = shape.halfExtents[i]!;
    const o = localOrigin[i]!;
    const d = localDirection[i]!;

    if (Math.abs(d) < EPSILON) {
      // Parallel to this slab: either always inside it or never.
      if (o < -half || o > half) return null;
      continue;
    }

    const inverse = 1 / d;
    let t1 = (-half - o) * inverse;
    let t2 = (half - o) * inverse;
    /**
     * The entry face is decided by the direction alone: a ray travelling down the axis enters
     * through the +half face, one travelling up enters through -half. The swap below only
     * orders the interval — flipping the sign along with it (which this did) reported the far
     * face's normal, so a ray cast straight down at a box came back with a normal pointing
     * down through it.
     */
    const entrySign = d > 0 ? -1 : 1;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > near) {
      near = t1;
      axis = i;
      sign = entrySign;
    }
    if (t2 < far) far = t2;
    if (near > far) return null;
  }

  if (near > maxDistance) return null;

  const localNormal: Vec3 = [0, 0, 0];
  localNormal[axis] = sign;
  return {
    distance: near,
    point: add(origin, scale(direction, near)),
    // Starting inside gives near === 0 and no meaningful face; face the ray back out.
    normal: near <= 0 ? scale(direction, -1) : quatRotate(shape.rotation, localNormal),
  };
}

/**
 * Ray against capsule, as the infinite cylinder around the segment plus the two end caps.
 *
 * The cylinder solution is the quadratic with the axial component projected out; the caps are
 * two sphere tests. Taking the nearest of the three is exact, and short enough to be obviously
 * correct — which matters, because this is the shape characters are made of.
 */
function rayCapsule(
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  shape: Extract<WorldShape, { kind: 'capsule' }>,
): RayHitGeometry | null {
  const axis = sub(shape.b, shape.a);
  const axisLength = length(axis);

  // Degenerate capsule (height at or below the diameter) is exactly a sphere.
  if (axisLength < EPSILON) {
    return raySphere(origin, direction, maxDistance, shape.a, shape.radius);
  }

  const unitAxis = scale(axis, 1 / axisLength);
  const toStart = sub(origin, shape.a);

  const dPara = dot(direction, unitAxis);
  const oPara = dot(toStart, unitAxis);
  const dPerp = sub(direction, scale(unitAxis, dPara));
  const oPerp = sub(toStart, scale(unitAxis, oPara));

  const a = dot(dPerp, dPerp);
  const b = 2 * dot(dPerp, oPerp);
  const c = dot(oPerp, oPerp) - shape.radius * shape.radius;

  let best: RayHitGeometry | null = null;

  if (a > EPSILON) {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
        if (t < 0 || t > maxDistance) continue;
        const along = oPara + t * dPara;
        // Outside the barrel's length is a cap's problem, handled below.
        if (along < 0 || along > axisLength) continue;
        const point = add(origin, scale(direction, t));
        const onAxis = add(shape.a, scale(unitAxis, along));
        best = { distance: t, point, normal: normalize(sub(point, onAxis), scale(direction, -1)) };
        break;
      }
    }
  }

  for (const cap of [shape.a, shape.b]) {
    const hit = raySphere(origin, direction, maxDistance, cap, shape.radius);
    if (hit && (!best || hit.distance < best.distance)) best = hit;
  }

  // Starting inside: the quadratic's near root is behind us and both caps may miss, but the
  // point is genuinely in the volume, so report the degenerate contact rather than nothing.
  if (!best) {
    const closest = closestPointOnSegment(shape.a, shape.b, origin);
    if (length(sub(origin, closest)) < shape.radius) {
      return { distance: 0, point: [...origin], normal: scale(direction, -1) };
    }
  }

  return best;
}

function rayPlane(
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  shape: Extract<WorldShape, { kind: 'plane' }>,
): RayHitGeometry | null {
  const denominator = dot(shape.normal, direction);
  if (Math.abs(denominator) < EPSILON) return null;

  const distance = (shape.constant - dot(shape.normal, origin)) / denominator;
  if (distance < 0 || distance > maxDistance) return null;

  return {
    distance,
    point: add(origin, scale(direction, distance)),
    // A plane hit from below reports its underside, so a ray cast upward at a floor gets a
    // normal pointing down at it rather than one pointing away through the geometry.
    normal: denominator < 0 ? [...shape.normal] : scale(shape.normal, -1),
  };
}

/** Clamps a ray parameter into the segment the caller asked about. Shared by the queries. */
export function clampDistance(distance: number, maxDistance: number): number {
  return clamp(distance, 0, maxDistance);
}
