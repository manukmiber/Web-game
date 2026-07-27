import { createMeshData, pushVertex, type MeshData } from './MeshData';
import { signedArea2D, type Vec2 } from './tessellate';

export type { Vec2 };

/**
 * A closed 2D profile.
 *
 * Shapes are authored in the ordinary maths convention — +X right, +Y up, counter-clockwise
 * positive — and mapped into 3D by `fillShape`. Keeping the 2D stage genuinely 2D is what makes
 * area, winding and convexity testable as plain numbers instead of as properties of a mesh.
 *
 * A hole is allowed only when it has the same number of points as the outline, because the fill
 * bridges the two as a ring of quads rather than triangulating across them. That restriction is
 * not a limitation in practice — every annular shape here samples both rings at the same angles
 * — and it buys clean all-quad topology, which is what Subdivide, Bevel and Extrude want. The
 * alternative, bridging the hole into the outline with a zero-width slit, produces a face that
 * every one of those modifiers then mangles.
 */
export interface Shape2D {
  /** Outer boundary, wound counter-clockwise. */
  outline: Vec2[];
  /** Optional inner boundary, wound the same way, with `outline.length` points. */
  hole?: Vec2[];
}

const TAU = Math.PI * 2;
const clampCount = (value: number, min: number) => Math.max(min, Math.floor(value) || min);

/** Samples a ring of `segments` points on an ellipse, counter-clockwise from +X. */
function ellipseRing(radiusX: number, radiusY: number, segments: number, phase = 0): Vec2[] {
  const count = clampCount(segments, 3);
  const points: Vec2[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = phase + (i / count) * TAU;
    points.push([Math.cos(angle) * radiusX, Math.sin(angle) * radiusY]);
  }
  return points;
}

export function circleShape(radius: number, segments: number): Shape2D {
  return { outline: ellipseRing(radius, radius, segments) };
}

export function ellipseShape(radiusX: number, radiusY: number, segments: number): Shape2D {
  return { outline: ellipseRing(radiusX, radiusY, segments) };
}

/** Regular n-gon, flat-topped rather than point-topped so a "square" reads as a square. */
export function polygonShape(radius: number, sides: number): Shape2D {
  const count = clampCount(sides, 3);
  return { outline: ellipseRing(radius, radius, count, Math.PI / count + Math.PI / 2) };
}

/**
 * Rectangle, optionally with rounded corners.
 *
 * The corner radius is clamped to half the shorter side. Without that, a radius larger than the
 * rectangle produces arcs that cross each other and a self-intersecting outline — which the ear
 * clipper cannot triangulate meaningfully, and which no amount of downstream cleanup recovers.
 */
export function rectangleShape(
  width: number,
  height: number,
  cornerRadius = 0,
  cornerSegments = 4,
): Shape2D {
  const hw = width / 2;
  const hh = height / 2;
  const radius = Math.max(0, Math.min(cornerRadius, Math.min(hw, hh)));

  if (radius <= 1e-6) {
    return { outline: [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] };
  }

  const steps = clampCount(cornerSegments, 1);
  const outline: Vec2[] = [];
  // Corner centres, counter-clockwise from bottom-right, each swept a quarter turn.
  const corners: [Vec2, number][] = [
    [[hw - radius, -hh + radius], -Math.PI / 2],
    [[hw - radius, hh - radius], 0],
    [[-hw + radius, hh - radius], Math.PI / 2],
    [[-hw + radius, -hh + radius], Math.PI],
  ];
  for (const [[cx, cy], start] of corners) {
    for (let i = 0; i <= steps; i += 1) {
      const angle = start + (i / steps) * (Math.PI / 2);
      outline.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
    }
  }
  return { outline };
}

/**
 * Star with `points` spikes alternating between two radii.
 *
 * Concave by construction, which is exactly why it exists here: it is the shape that proves the
 * ear clipper is doing something a fan cannot.
 */
export function starShape(outerRadius: number, innerRadius: number, points: number): Shape2D {
  const count = clampCount(points, 3);
  const inner = Math.max(1e-4, Math.min(innerRadius, outerRadius));
  const outline: Vec2[] = [];
  for (let i = 0; i < count * 2; i += 1) {
    const radius = i % 2 === 0 ? outerRadius : inner;
    const angle = Math.PI / 2 + (i / (count * 2)) * TAU;
    outline.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  return { outline };
}

/**
 * Pie wedge from `startAngle` through `sweepAngle`, both in degrees.
 *
 * A full sweep drops the centre point and degenerates into a circle — keeping it would leave a
 * duplicate vertex at the origin and a zero-area sliver where the ends meet.
 */
export function arcShape(
  radius: number,
  startAngle: number,
  sweepAngle: number,
  segments: number,
): Shape2D {
  const sweep = Math.max(-TAU, Math.min(TAU, (sweepAngle * Math.PI) / 180));
  if (Math.abs(Math.abs(sweep) - TAU) < 1e-6) return circleShape(radius, segments);

  const steps = clampCount(segments, 2);
  const start = (startAngle * Math.PI) / 180;
  const outline: Vec2[] = [[0, 0]];
  for (let i = 0; i <= steps; i += 1) {
    const angle = start + (i / steps) * sweep;
    outline.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  // A negative sweep traces the arc clockwise, so the wedge comes out wound the wrong way.
  if (signedArea2D(outline) < 0) outline.reverse();
  return { outline };
}

/** Annulus. Collapses to a disc when the bore is degenerate. */
export function ringShape(radius: number, innerRadius: number, segments: number): Shape2D {
  const inner = Math.max(0, Math.min(innerRadius, radius - 1e-4));
  if (inner <= 1e-4) return circleShape(radius, segments);
  return {
    outline: ellipseRing(radius, radius, segments),
    hole: ellipseRing(inner, inner, segments),
  };
}

/**
 * Spur gear: `teeth` trapezoidal teeth, optionally with a bore.
 *
 * Included because it is the cheapest shape that is concave *and* has a hole *and* has a lot of
 * corners — so if extrude, bevel and subdivide all survive a gear, they survive most things.
 */
export function gearShape(
  radius: number,
  toothDepth: number,
  teeth: number,
  boreRadius = 0,
): Shape2D {
  const count = clampCount(teeth, 3);
  const root = Math.max(radius * 0.1, radius - Math.max(0, toothDepth));
  const step = TAU / count;
  const outline: Vec2[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = i * step;
    // Tooth occupies the first half of its slot, the gap the second half.
    outline.push(
      [Math.cos(base) * radius, Math.sin(base) * radius],
      [Math.cos(base + step / 2) * radius, Math.sin(base + step / 2) * radius],
      [Math.cos(base + step / 2) * root, Math.sin(base + step / 2) * root],
      [Math.cos(base + step) * root, Math.sin(base + step) * root],
    );
  }

  const bore = Math.max(0, Math.min(boreRadius, root - 1e-4));
  if (bore <= 1e-4) return { outline };
  // The bore has to match the outline's point count, but it is spaced evenly rather than
  // copying the tooth angles — two of those coincide on every radial flank, which would put a
  // pair of identical points in the bore and collapse a quad of the ring to a sliver.
  return { outline, hole: ellipseRing(bore, bore, outline.length) };
}

// -------------------------------------------------------------------- filling

/** Bounding box of every contour in a shape. */
export function shapeBounds(shape: Shape2D): { min: Vec2; max: Vec2 } {
  const min: Vec2 = [Infinity, Infinity];
  const max: Vec2 = [-Infinity, -Infinity];
  for (const point of [...shape.outline, ...(shape.hole ?? [])]) {
    for (const axis of [0, 1] as const) {
      if (point[axis] < min[axis]) min[axis] = point[axis];
      if (point[axis] > max[axis]) max[axis] = point[axis];
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0], max: [0, 0] };
  return { min, max };
}

/** Enclosed area, holes subtracted. */
export function shapeArea(shape: Shape2D): number {
  const outer = Math.abs(signedArea2D(shape.outline)) / 2;
  const inner = shape.hole ? Math.abs(signedArea2D(shape.hole)) / 2 : 0;
  return outer - inner;
}

/**
 * Turns a 2D shape into a flat mesh lying in the XZ plane, facing up.
 *
 * XZ rather than XY because that is where the ground is, where Plane already lives, and where a
 * building footprint or a floor plan belongs. Extrude then runs up +Y, which is the common case.
 * Lathe wants its profile in a plane *containing* the spin axis instead, so it takes an axis
 * parameter and the shape gets rotated into place by the object's own transform or a Transform
 * modifier.
 *
 * The mapping is (x, y) → (x, 0, -y), which is what turns counter-clockwise-in-2D into
 * counter-clockwise-seen-from-above, so the fill faces +Y rather than into the ground.
 */
export function fillShape(shape: Shape2D): MeshData {
  const mesh = createMeshData();
  if (shape.outline.length < 3) return mesh;
  mesh.uvs = [];
  mesh.smoothFaces = [];

  const { min, max } = shapeBounds(shape);
  const spanX = max[0] - min[0] || 1;
  const spanY = max[1] - min[1] || 1;
  const place = ([x, y]: Vec2) => {
    const index = pushVertex(mesh, x, 0, -y);
    mesh.uvs!.push((x - min[0]) / spanX, (y - min[1]) / spanY);
    return index;
  };

  const outer = shape.outline.map(place);

  if (!shape.hole || shape.hole.length !== shape.outline.length) {
    // One n-gon rather than a triangle fan: it keeps the profile as a single face, which is what
    // Extrude caps with and what Subdivide and Bevel want to see.
    mesh.faces.push(outer);
    mesh.smoothFaces.push(false);
    return mesh;
  }

  const inner = shape.hole.map(place);
  for (let i = 0; i < outer.length; i += 1) {
    const next = (i + 1) % outer.length;
    mesh.faces.push([outer[i]!, outer[next]!, inner[next]!, inner[i]!]);
    mesh.smoothFaces.push(false);
  }
  return mesh;
}
