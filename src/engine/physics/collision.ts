/**
 * Narrowphase: two world shapes in, a contact out.
 *
 * **Normal convention: the contact normal points from A towards B.** To separate the pair, A
 * moves along `-normal` and B along `+normal`. Every function here obeys it, `collide` flips it
 * when it reorders a pair, and the solver depends on it — a sign error in one of these is the
 * kind of bug that looks like objects being sucked into walls, so it is stated once and
 * followed everywhere.
 *
 * `depth` is always positive: a returned contact means the shapes overlap. Touching exactly is
 * reported as no contact, which keeps a resting body from being woken by its own resting.
 */

import type { Vec3 } from '../scene/types';
import {
  add,
  closestPointOnSegment,
  closestPointsBetweenSegments,
  dot,
  EPSILON,
  length,
  negate,
  normalize,
  scale,
  sub,
} from './math';
import {
  boxAxes,
  boxProjectedRadius,
  closestPointOnBox,
  escapeFromBox,
  perpendicular,
  type WorldShape,
} from './shapes';

export interface Contact {
  /** Unit vector from A towards B. */
  normal: Vec3;
  /** Overlap along the normal, in metres. Always > 0. */
  depth: number;
  /** A point on the shared surface, used for reporting rather than by the solver. */
  point: Vec3;
}

/**
 * Contact between any two shapes, or null when they do not overlap.
 *
 * The pair is reordered into a canonical shape order so each combination is implemented once
 * rather than twice, and the normal is flipped back on the way out.
 */
export function collide(a: WorldShape, b: WorldShape): Contact | null {
  const order = SHAPE_ORDER[a.kind] - SHAPE_ORDER[b.kind];
  if (order > 0) {
    const flipped = collide(b, a);
    return flipped ? { ...flipped, normal: negate(flipped.normal) } : null;
  }

  if (a.kind === 'sphere' && b.kind === 'sphere') return sphereSphere(a, b);
  if (a.kind === 'sphere' && b.kind === 'capsule') return sphereCapsule(a, b);
  if (a.kind === 'sphere' && b.kind === 'box') return sphereBox(a, b);
  if (a.kind === 'sphere' && b.kind === 'plane') return spherePlane(a, b);
  if (a.kind === 'capsule' && b.kind === 'capsule') return capsuleCapsule(a, b);
  if (a.kind === 'capsule' && b.kind === 'box') return capsuleBox(a, b);
  if (a.kind === 'capsule' && b.kind === 'plane') return capsulePlane(a, b);
  if (a.kind === 'box' && b.kind === 'box') return boxBox(a, b);
  if (a.kind === 'box' && b.kind === 'plane') return boxPlane(a, b);
  // Two planes are two infinite half-spaces; whatever they do to each other, no game needs it.
  return null;
}

/** Lower sorts first, so `collide` only ever implements one direction of each pair. */
const SHAPE_ORDER: Record<WorldShape['kind'], number> = {
  sphere: 0,
  capsule: 1,
  box: 2,
  plane: 3,
};

// ------------------------------------------------------------------ spheres

function sphereSphere(
  a: Extract<WorldShape, { kind: 'sphere' }>,
  b: Extract<WorldShape, { kind: 'sphere' }>,
): Contact | null {
  const delta = sub(b.center, a.center);
  const distance = length(delta);
  const radii = a.radius + b.radius;
  if (distance >= radii) return null;

  // Concentric spheres have no meaningful separation direction; any consistent one will do,
  // and up is the least surprising thing for a stack of spawned-on-top-of-each-other objects.
  const normal = distance < EPSILON ? ([0, 1, 0] as Vec3) : scale(delta, 1 / distance);
  return {
    normal,
    depth: radii - distance,
    point: add(a.center, scale(normal, a.radius)),
  };
}

function sphereCapsule(
  a: Extract<WorldShape, { kind: 'sphere' }>,
  b: Extract<WorldShape, { kind: 'capsule' }>,
): Contact | null {
  const onSegment = closestPointOnSegment(b.a, b.b, a.center);
  return sphereSphere(a, { kind: 'sphere', center: onSegment, radius: b.radius });
}

function sphereBox(
  a: Extract<WorldShape, { kind: 'sphere' }>,
  b: Extract<WorldShape, { kind: 'box' }>,
): Contact | null {
  const closest = closestPointOnBox(b.center, b.rotation, b.halfExtents, a.center);
  const delta = sub(closest, a.center);
  const distance = length(delta);

  if (distance > EPSILON) {
    if (distance >= a.radius) return null;
    const normal = scale(delta, 1 / distance);
    return { normal, depth: a.radius - distance, point: closest };
  }

  // Centre inside the box: push out through the nearest face instead of dividing by zero.
  const escape = escapeFromBox(b.center, b.rotation, b.halfExtents, a.center);
  return {
    normal: negate(escape.normal),
    depth: a.radius + escape.depth,
    point: add(a.center, scale(escape.normal, escape.depth)),
  };
}

function spherePlane(
  a: Extract<WorldShape, { kind: 'sphere' }>,
  b: Extract<WorldShape, { kind: 'plane' }>,
): Contact | null {
  const gap = dot(b.normal, a.center) - b.constant - a.radius;
  if (gap >= 0) return null;
  return {
    normal: negate(b.normal),
    depth: -gap,
    point: sub(a.center, scale(b.normal, a.radius)),
  };
}

// ----------------------------------------------------------------- capsules

function capsuleCapsule(
  a: Extract<WorldShape, { kind: 'capsule' }>,
  b: Extract<WorldShape, { kind: 'capsule' }>,
): Contact | null {
  const pair = closestPointsBetweenSegments(a.a, a.b, b.a, b.b);
  return sphereSphere(
    { kind: 'sphere', center: pair.a, radius: a.radius },
    { kind: 'sphere', center: pair.b, radius: b.radius },
  );
}

/**
 * Segment against oriented box, by alternating projection.
 *
 * The exact answer is a GJK query. Two refinement passes get within a fraction of a millimetre
 * for the configurations that occur — a capsule standing on, leaning against or wedged into a
 * box — for a fraction of the code, and the positional-correction loop absorbs the rest over
 * the following steps. It is worth being explicit that this is an approximation rather than
 * having it look exact and quietly fail on an edge-on capsule.
 */
function capsuleBox(
  a: Extract<WorldShape, { kind: 'capsule' }>,
  b: Extract<WorldShape, { kind: 'box' }>,
): Contact | null {
  let onSegment = closestPointOnSegment(a.a, a.b, b.center);
  for (let i = 0; i < 2; i += 1) {
    const onBox = closestPointOnBox(b.center, b.rotation, b.halfExtents, onSegment);
    onSegment = closestPointOnSegment(a.a, a.b, onBox);
  }
  return sphereBox({ kind: 'sphere', center: onSegment, radius: a.radius }, b);
}

function capsulePlane(
  a: Extract<WorldShape, { kind: 'capsule' }>,
  b: Extract<WorldShape, { kind: 'plane' }>,
): Contact | null {
  const gapA = dot(b.normal, a.a) - b.constant;
  const gapB = dot(b.normal, a.b) - b.constant;
  // The deeper end drives the contact. A capsule lying flat has both ends at the same depth and
  // either answer is right; a leaning one is held up by its lower cap, which is this branch.
  const deepest = gapA <= gapB ? a.a : a.b;
  const gap = Math.min(gapA, gapB) - a.radius;
  if (gap >= 0) return null;
  return {
    normal: negate(b.normal),
    depth: -gap,
    point: sub(deepest, scale(b.normal, a.radius)),
  };
}

// -------------------------------------------------------------------- boxes

function boxPlane(
  a: Extract<WorldShape, { kind: 'box' }>,
  b: Extract<WorldShape, { kind: 'plane' }>,
): Contact | null {
  const axes = boxAxes(a.rotation);
  const radius = boxProjectedRadius(axes, a.halfExtents, b.normal);
  const gap = dot(b.normal, a.center) - b.constant - radius;
  if (gap >= 0) return null;
  return {
    normal: negate(b.normal),
    depth: -gap,
    point: sub(a.center, scale(b.normal, radius)),
  };
}

/**
 * Oriented box against oriented box, by the separating axis theorem.
 *
 * Fifteen candidate axes: three face normals from each box, and the nine cross products of
 * their edge directions. If any axis separates the projections, there is no contact; otherwise
 * the axis of least overlap is the contact normal, because that is the shortest push that ends
 * the intersection.
 *
 * The near-parallel edge pairs need care. Their cross product tends to zero, and a normalised
 * near-zero vector is numerical noise that reports a spuriously tiny overlap — which the "least
 * overlap wins" rule then picks, sending a box sideways off a floor it was resting on. Those
 * axes are skipped rather than normalised.
 */
function boxBox(
  a: Extract<WorldShape, { kind: 'box' }>,
  b: Extract<WorldShape, { kind: 'box' }>,
): Contact | null {
  const axesA = boxAxes(a.rotation);
  const axesB = boxAxes(b.rotation);
  const delta = sub(b.center, a.center);

  let bestAxis: Vec3 | null = null;
  let bestDepth = Infinity;

  const test = (axis: Vec3): boolean => {
    const len = length(axis);
    if (len < 1e-6) return true; // Degenerate axis carries no information; not a separation.
    const unit = scale(axis, 1 / len);
    const overlap =
      boxProjectedRadius(axesA, a.halfExtents, unit) +
      boxProjectedRadius(axesB, b.halfExtents, unit) -
      Math.abs(dot(delta, unit));
    if (overlap <= 0) return false;
    if (overlap < bestDepth) {
      bestDepth = overlap;
      // Always point from A towards B, whichever side of the axis B happens to be on.
      bestAxis = dot(delta, unit) < 0 ? negate(unit) : unit;
    }
    return true;
  };

  for (const axis of axesA) if (!test(axis)) return null;
  for (const axis of axesB) if (!test(axis)) return null;
  for (const axisA of axesA) {
    for (const axisB of axesB) {
      if (!test(crossOf(axisA, axisB))) return null;
    }
  }

  if (!bestAxis || bestDepth === Infinity) return null;
  const normal = normalize(bestAxis, [0, 1, 0]);

  // No torque in this solver, so a single representative point is enough: the midpoint of the
  // two closest surface points reads correctly in `onCollision` and costs two box queries.
  const pointOnB = closestPointOnBox(b.center, b.rotation, b.halfExtents, a.center);
  const pointOnA = closestPointOnBox(a.center, a.rotation, a.halfExtents, b.center);
  return {
    normal,
    depth: bestDepth,
    point: scale(add(pointOnA, pointOnB), 0.5),
  };
}

function crossOf(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * Two unit vectors spanning the plane perpendicular to `normal`.
 *
 * Friction acts in that plane, and it needs a basis to act along. Any basis will do — friction
 * is isotropic — so the cheapest stable one is used.
 */
export function tangentBasis(normal: Vec3): [Vec3, Vec3] {
  const t1 = perpendicular(normal);
  const t2: Vec3 = [
    normal[1] * t1[2] - normal[2] * t1[1],
    normal[2] * t1[0] - normal[0] * t1[2],
    normal[0] * t1[1] - normal[1] * t1[0],
  ];
  return [t1, normalize(t2, [0, 0, 1])];
}
