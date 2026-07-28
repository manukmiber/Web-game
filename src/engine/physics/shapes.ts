/**
 * Collider components resolved into world-space shapes the solver can reason about.
 *
 * The split matters: a `ColliderComponent` is authored data (local size, local centre, a shape
 * name), and a `WorldShape` is the same volume placed in the world with the entity's transform
 * already folded in. Everything downstream — broadphase, narrowphase, raycasting — sees only
 * the second, so none of it has to know how a collider is authored or where the transform came
 * from.
 */

import type { ColliderComponent } from '../components/Collider';
import type { Vec3 } from '../scene/types';
import {
  DEFAULT_DIMENSIONALITY,
  depthAxis,
  planeAxes,
  type Dimensionality,
} from './dimension';
import {
  add,
  clamp,
  cross,
  dot,
  EPSILON,
  length,
  maxScale,
  normalize,
  quatRotate,
  quatRotateInverse,
  scale,
  sub,
  transformPoint,
  type Quat,
  type RigidTransform,
} from './math';

export type WorldShape =
  | { kind: 'sphere'; center: Vec3; radius: number }
  | { kind: 'box'; center: Vec3; rotation: Quat; halfExtents: Vec3 }
  /** `a` and `b` are the ends of the *inner segment*; the surface is `radius` from it. */
  | { kind: 'capsule'; a: Vec3; b: Vec3; radius: number }
  /** Infinite half-space. Points with `dot(normal, p) < constant` are inside. */
  | { kind: 'plane'; normal: Vec3; constant: number };

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/** Half-extent used to give an infinite plane a finite box for the broadphase grid. */
const PLANE_BOUNDS = 1e6;

/**
 * Depth of a 2D prism when its collider does not say, in metres.
 *
 * Deep enough that a body a little off the plane still collides — sprites get authored at
 * whatever Z the modeller was looking at — and shallow enough that the broadphase still buckets
 * it: at a 4 m cell, 10 m of depth is three cells, not the thousands an "effectively infinite"
 * prism would span.
 */
const DEFAULT_PRISM_DEPTH = 10;

/**
 * Places a collider in the world.
 *
 * Scale is applied differently per shape, and each choice is forced by the shape's own
 * parameterisation rather than chosen for consistency: a box has three extents so it takes all
 * three scale components, while a sphere and a capsule radius have one number between them and
 * must collapse the scale to a single factor (see `maxScale` for why the largest wins).
 */
export function resolveShape(
  collider: ColliderComponent,
  transform: RigidTransform,
  dimensionality: Dimensionality = DEFAULT_DIMENSIONALITY,
): WorldShape {
  const center = transformPoint(transform, collider.center ?? [0, 0, 0]);

  switch (collider.shape) {
    /**
     * The two 2D shapes, resolved as prisms rather than as a new pair of primitives.
     *
     * A `Circle` becomes a capsule whose segment runs along the depth axis, and a `Rect` becomes
     * a box whose depth half-extent is `depth / 2`. Their cross-section in the simulation plane
     * is exactly a circle and exactly a rectangle, so the narrowphase gives the right 2D answer
     * with no 2D code in it — and because they are extruded rather than flat, a 2D gameplay
     * layer still works inside a 3D scene where bodies are not perfectly coplanar. That is the
     * whole trick, and it is why `collision.ts` did not gain a line for this release.
     */
    case 'Circle': {
      const factor = maxScale(transform.scale);
      const radius = Math.max(EPSILON, collider.radius * factor);
      const half = Math.max(EPSILON, (collider.depth ?? DEFAULT_PRISM_DEPTH) / 2);
      const axis: Vec3 = [0, 0, 0];
      // Extruded along the *world* depth axis, deliberately unrotated: tilting the extrusion
      // would take the prism out of the plane it exists to fill.
      axis[depthAxis(dimensionality.plane)] = half;
      return { kind: 'capsule', a: sub(center, axis), b: add(center, axis), radius };
    }

    case 'Rect': {
      const size = collider.size ?? [1, 1, 1];
      const [u, v] = planeAxes(dimensionality.plane);
      const depth = depthAxis(dimensionality.plane);
      const halfExtents: Vec3 = [EPSILON, EPSILON, EPSILON];
      // The rect is authored as size X/Y regardless of which plane it lands in — a 2D scene
      // switched from XY to XZ keeps the shapes it had rather than collapsing them.
      halfExtents[u] = Math.max(
        EPSILON,
        (Math.abs(size[0]) * Math.abs(transform.scale[u]!)) / 2,
      );
      halfExtents[v] = Math.max(
        EPSILON,
        (Math.abs(size[1]) * Math.abs(transform.scale[v]!)) / 2,
      );
      halfExtents[depth] = Math.max(EPSILON, (collider.depth ?? DEFAULT_PRISM_DEPTH) / 2);
      return { kind: 'box', center, rotation: transform.rotation, halfExtents };
    }

    case 'Sphere':
      return {
        kind: 'sphere',
        center,
        radius: Math.max(EPSILON, collider.radius * maxScale(transform.scale)),
      };

    case 'Capsule': {
      const factor = maxScale(transform.scale);
      const radius = Math.max(EPSILON, collider.radius * factor);
      // The barrel is what is left after the two hemispherical caps. A capsule whose height is
      // less than its diameter is a sphere, and clamping to zero here is what stops it becoming
      // an inside-out segment rather than degenerating gracefully.
      const half = Math.max(0, (collider.height * factor) / 2 - radius);
      const axis = quatRotate(transform.rotation, [0, half, 0]);
      return { kind: 'capsule', a: sub(center, axis), b: add(center, axis), radius };
    }

    case 'Plane': {
      // Faces local +Y, so an unrotated Plane collider is a floor — which is what a Plane
      // primitive looks like in the viewport, and the only convention that does not surprise.
      const normal = normalize(quatRotate(transform.rotation, [0, 1, 0]), [0, 1, 0]);
      return { kind: 'plane', normal, constant: dot(normal, center) };
    }

    case 'Box':
    default: {
      const size = collider.size ?? [1, 1, 1];
      return {
        kind: 'box',
        center,
        rotation: transform.rotation,
        halfExtents: [
          Math.max(EPSILON, (Math.abs(size[0]) * Math.abs(transform.scale[0])) / 2),
          Math.max(EPSILON, (Math.abs(size[1]) * Math.abs(transform.scale[1])) / 2),
          Math.max(EPSILON, (Math.abs(size[2]) * Math.abs(transform.scale[2])) / 2),
        ],
      };
    }
  }
}

/** Axis-aligned bounds, grown by `margin` — the broadphase uses a margin, queries do not. */
export function shapeBounds(shape: WorldShape, margin = 0): Aabb {
  switch (shape.kind) {
    case 'sphere': {
      const r = shape.radius + margin;
      return {
        min: [shape.center[0] - r, shape.center[1] - r, shape.center[2] - r],
        max: [shape.center[0] + r, shape.center[1] + r, shape.center[2] + r],
      };
    }
    case 'capsule': {
      const r = shape.radius + margin;
      return {
        min: [
          Math.min(shape.a[0], shape.b[0]) - r,
          Math.min(shape.a[1], shape.b[1]) - r,
          Math.min(shape.a[2], shape.b[2]) - r,
        ],
        max: [
          Math.max(shape.a[0], shape.b[0]) + r,
          Math.max(shape.a[1], shape.b[1]) + r,
          Math.max(shape.a[2], shape.b[2]) + r,
        ],
      };
    }
    case 'box': {
      // The extent of a rotated box along a world axis is the row of |R| dotted with the half
      // extents — the standard OBB-to-AABB projection, and much cheaper than the eight corners.
      const [ex, ey, ez] = obbWorldExtents(shape.rotation, shape.halfExtents);
      return {
        min: [
          shape.center[0] - ex - margin,
          shape.center[1] - ey - margin,
          shape.center[2] - ez - margin,
        ],
        max: [
          shape.center[0] + ex + margin,
          shape.center[1] + ey + margin,
          shape.center[2] + ez + margin,
        ],
      };
    }
    case 'plane':
    default:
      return {
        min: [-PLANE_BOUNDS, -PLANE_BOUNDS, -PLANE_BOUNDS],
        max: [PLANE_BOUNDS, PLANE_BOUNDS, PLANE_BOUNDS],
      };
  }
}

/** Half-extent of a rotated box along each world axis. */
export function obbWorldExtents(rotation: Quat, halfExtents: Vec3): Vec3 {
  const x = quatRotate(rotation, [halfExtents[0], 0, 0]);
  const y = quatRotate(rotation, [0, halfExtents[1], 0]);
  const z = quatRotate(rotation, [0, 0, halfExtents[2]]);
  return [
    Math.abs(x[0]) + Math.abs(y[0]) + Math.abs(z[0]),
    Math.abs(x[1]) + Math.abs(y[1]) + Math.abs(z[1]),
    Math.abs(x[2]) + Math.abs(y[2]) + Math.abs(z[2]),
  ];
}

export function aabbOverlaps(a: Aabb, b: Aabb): boolean {
  return (
    a.min[0] <= b.max[0] &&
    a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] &&
    a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] &&
    a.max[2] >= b.min[2]
  );
}

/** Closest point on (or in) an oriented box to a world point. */
export function closestPointOnBox(
  center: Vec3,
  rotation: Quat,
  halfExtents: Vec3,
  point: Vec3,
): Vec3 {
  const local = quatRotateInverse(rotation, sub(point, center));
  const clamped: Vec3 = [
    clamp(local[0], -halfExtents[0], halfExtents[0]),
    clamp(local[1], -halfExtents[1], halfExtents[1]),
    clamp(local[2], -halfExtents[2], halfExtents[2]),
  ];
  return add(center, quatRotate(rotation, clamped));
}

/**
 * Pushes a point that is *inside* a box out through its nearest face.
 *
 * `closestPointOnBox` returns the point itself when it is inside, which gives a zero-length
 * separation direction and a contact with no normal. Deep contacts are exactly where a solver
 * has to behave, so the nearest face is picked explicitly.
 */
export function escapeFromBox(
  center: Vec3,
  rotation: Quat,
  halfExtents: Vec3,
  point: Vec3,
): { normal: Vec3; depth: number } {
  const local = quatRotateInverse(rotation, sub(point, center));

  let axis = 0;
  let best = halfExtents[0] - Math.abs(local[0]);
  for (let i = 1; i < 3; i += 1) {
    const gap = halfExtents[i]! - Math.abs(local[i]!);
    if (gap < best) {
      best = gap;
      axis = i;
    }
  }

  const localNormal: Vec3 = [0, 0, 0];
  localNormal[axis] = local[axis]! >= 0 ? 1 : -1;
  return { normal: quatRotate(rotation, localNormal), depth: Math.max(0, best) };
}

/** The three local axes of an oriented box, in world space. */
export function boxAxes(rotation: Quat): [Vec3, Vec3, Vec3] {
  return [
    quatRotate(rotation, [1, 0, 0]),
    quatRotate(rotation, [0, 1, 0]),
    quatRotate(rotation, [0, 0, 1]),
  ];
}

/** Half-width of a box's projection onto `axis`, which must be unit length. */
export function boxProjectedRadius(axes: [Vec3, Vec3, Vec3], halfExtents: Vec3, axis: Vec3): number {
  return (
    Math.abs(dot(axes[0], axis)) * halfExtents[0] +
    Math.abs(dot(axes[1], axis)) * halfExtents[1] +
    Math.abs(dot(axes[2], axis)) * halfExtents[2]
  );
}

/**
 * A unit vector perpendicular to `v`.
 *
 * Needed wherever a contact has a normal but no tangent frame — friction, and the degenerate
 * SAT axes where two box edges are parallel and their cross product vanishes.
 */
export function perpendicular(v: Vec3): Vec3 {
  const reference: Vec3 = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const out = cross(v, reference);
  return length(out) < EPSILON ? [0, 0, 1] : scale(out, 1 / length(out));
}
