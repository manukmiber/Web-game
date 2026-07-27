import type { Vec3 } from '../scene/types';

/** A point in a 2D shape, or in a face's own plane after projection. */
export type Vec2 = [number, number];

/**
 * Polygon triangulation by ear clipping.
 *
 * The mesh pipeline keeps n-gons all the way to the GPU (ARCHITECTURE.md §3b), so *something*
 * has to turn them into triangles at the end. Fanning from the first corner is the cheap answer
 * and it is correct — for convex faces only. The moment a face is concave the fan produces
 * triangles that leave the polygon: a five-pointed star fanned from one of its points covers
 * the notches between the others, so the shape renders as a filled decagon.
 *
 * That was invisible while every face came from a primitive generator, because all of those are
 * convex. The 2D shape primitives (Star, Gear, Arc) are not, and a deformer can make any quad
 * concave, so the fan is now a fast path rather than the whole story.
 *
 * This module deliberately knows nothing about MeshData — it works on plain point arrays, which
 * keeps the dependency one-way (MeshData uses it, not the other way round) and makes both the
 * 2D shape library and the render path able to call it.
 */

/** Twice the signed area. Positive when the ring winds counter-clockwise. */
export function signedArea2D(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    total += a[0] * b[1] - b[0] * a[1];
  }
  return total;
}

/** True when every turn goes the same way — the case a fan triangulation is correct for. */
export function isConvex2D(points: readonly Vec2[]): boolean {
  if (points.length < 4) return true;
  let sign = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const c = points[(i + 2) % points.length]!;
    const turn = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(turn) < 1e-12) continue; // Collinear corners do not decide handedness.
    const current = turn > 0 ? 1 : -1;
    if (sign === 0) sign = current;
    else if (sign !== current) return false;
  }
  return true;
}

function cross2(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** Inclusive point-in-triangle, so a corner sitting exactly on an edge still blocks the ear. */
function insideTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  return cross2(a, b, p) >= 0 && cross2(b, c, p) >= 0 && cross2(c, a, p) >= 0;
}

/**
 * Triangulates a simple polygon, concave or convex. Holes are not supported — a MeshData face
 * is a single index loop, so a face cannot have one; annular shapes are built as quad rings
 * instead (see `shapes.ts`).
 *
 * Returns exactly `points.length - 2` triangles as index triples into `points`, wound the same
 * way as the input. The count is guaranteed rather than incidental: `triangleCount()` reports
 * n-2 per face and the perf HUD and Inspector both quote that number, so a triangulator that
 * quietly dropped a degenerate ear would make the reported cost disagree with the real one.
 */
export function triangulatePolygon2D(points: readonly Vec2[]): [number, number, number][] {
  const n = points.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];

  // Work counter-clockwise regardless of how the caller wound the ring, then put the result
  // back into the caller's orientation at the end.
  const ccw = signedArea2D(points) >= 0;
  const ring: number[] = [];
  for (let i = 0; i < n; i += 1) ring.push(ccw ? i : n - 1 - i);

  const triangles: [number, number, number][] = [];

  while (ring.length > 3) {
    let clipped = -1;
    // Widest turn seen this pass, used as the fallback below.
    let widestCorner = 0;
    let widestTurn = -Infinity;

    for (let i = 0; i < ring.length; i += 1) {
      const prev = points[ring[(i + ring.length - 1) % ring.length]!]!;
      const current = points[ring[i]!]!;
      const next = points[ring[(i + 1) % ring.length]!]!;

      const turn = cross2(prev, current, next);
      if (turn > widestTurn) {
        widestTurn = turn;
        widestCorner = i;
      }
      if (turn <= 0) continue; // Reflex or collinear: not an ear.

      // A convex corner is only an ear if no other corner falls inside the triangle it cuts.
      let blocked = false;
      for (let j = 0; j < ring.length && !blocked; j += 1) {
        if (j === i || j === (i + ring.length - 1) % ring.length || j === (i + 1) % ring.length) {
          continue;
        }
        blocked = insideTriangle(points[ring[j]!]!, prev, current, next);
      }
      if (blocked) continue;

      clipped = i;
      break;
    }

    // No ear found. A simple polygon always has one, so reaching here means the input is
    // self-intersecting or numerically degenerate. Clipping the widest corner anyway keeps the
    // triangle count right and terminates; the alternative is an unbounded loop inside the
    // render path, which is a far worse failure than one wrong-looking face.
    if (clipped === -1) clipped = widestCorner;

    const prev = ring[(clipped + ring.length - 1) % ring.length]!;
    const current = ring[clipped]!;
    const next = ring[(clipped + 1) % ring.length]!;
    triangles.push([prev, current, next]);
    ring.splice(clipped, 1);
  }

  triangles.push([ring[0]!, ring[1]!, ring[2]!]);
  return ccw ? triangles : triangles.map(([a, b, c]) => [a, c, b]);
}

// ------------------------------------------------------------------- 3D faces

/**
 * Face normal via Newell's method.
 *
 * Newell rather than a cross product of the first three vertices because it is correct for
 * n-gons and for faces that are not perfectly planar — both of which happen constantly once
 * deformers start moving vertices around.
 */
export function newellNormal(points: readonly Vec3[]): Vec3 {
  const normal: Vec3 = [0, 0, 0];
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i]!;
    const next = points[(i + 1) % points.length]!;
    normal[0] += (current[1] - next[1]) * (current[2] + next[2]);
    normal[1] += (current[2] - next[2]) * (current[0] + next[0]);
    normal[2] += (current[0] - next[0]) * (current[1] + next[1]);
  }
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  if (length < 1e-12) return [0, 1, 0];
  return [normal[0] / length, normal[1] / length, normal[2] / length];
}

/**
 * An orthonormal basis on the plane a normal defines, chosen so `u × v === normal`.
 *
 * That handedness is the point: projecting onto (u, v) preserves the polygon's winding, so a
 * face wound counter-clockwise about its normal stays counter-clockwise in 2D and the
 * triangulator hands back triangles facing the same way as the face they came from.
 */
export function planeBasis(normal: Vec3): [Vec3, Vec3] {
  // Any axis not near-parallel to the normal works as a seed.
  const helper: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u: Vec3 = [
    helper[1] * normal[2] - helper[2] * normal[1],
    helper[2] * normal[0] - helper[0] * normal[2],
    helper[0] * normal[1] - helper[1] * normal[0],
  ];
  const length = Math.hypot(u[0], u[1], u[2]) || 1;
  u[0] /= length;
  u[1] /= length;
  u[2] /= length;
  return [
    u,
    [
      normal[1] * u[2] - normal[2] * u[1],
      normal[2] * u[0] - normal[0] * u[2],
      normal[0] * u[1] - normal[1] * u[0],
    ],
  ];
}

/** Flattens a polygon onto its own plane. Non-planar polygons project along the Newell normal. */
export function projectToPlane(points: readonly Vec3[], normal = newellNormal(points)): Vec2[] {
  const [u, v] = planeBasis(normal);
  return points.map(
    (p) =>
      [
        p[0] * u[0] + p[1] * u[1] + p[2] * u[2],
        p[0] * v[0] + p[1] * v[1] + p[2] * v[2],
      ] as Vec2,
  );
}

/**
 * Triangulates a 3D polygon into index triples over its own points, keeping its winding.
 *
 * Convex polygons — every primitive generator's output, and the overwhelming majority of what a
 * modifier stack produces — take the fan, which costs one convexity scan. Only concave faces
 * pay for ear clipping.
 */
export function triangulatePolygon3D(points: readonly Vec3[]): [number, number, number][] {
  const n = points.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];

  const projected = projectToPlane(points);
  if (isConvex2D(projected)) {
    const triangles: [number, number, number][] = [];
    for (let i = 1; i < n - 1; i += 1) triangles.push([0, i, i + 1]);
    return triangles;
  }
  return triangulatePolygon2D(projected);
}
