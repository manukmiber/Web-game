import { describe, expect, it } from 'vitest';
import {
  isConvex2D,
  newellNormal,
  planeBasis,
  signedArea2D,
  triangulatePolygon2D,
  triangulatePolygon3D,
  type Vec2,
} from './tessellate';
import type { Vec3 } from '../scene/types';

const SQUARE: Vec2[] = [
  [0, 0],
  [2, 0],
  [2, 2],
  [0, 2],
];

/** Five-pointed star, alternating radii. The canonical concave polygon. */
function star(points = 5, outer = 1, inner = 0.4): Vec2[] {
  const ring: Vec2[] = [];
  for (let i = 0; i < points * 2; i += 1) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = (i / (points * 2)) * Math.PI * 2;
    ring.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  return ring;
}

function triangleArea(a: Vec2, b: Vec2, c: Vec2): number {
  return ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
}

function coveredArea(points: readonly Vec2[], triangles: [number, number, number][]): number {
  return triangles.reduce(
    (total, [a, b, c]) => total + triangleArea(points[a]!, points[b]!, points[c]!),
    0,
  );
}

/**
 * Area painted, counting a triangle that faces backwards as painted rather than as cancelling
 * out the one underneath it.
 *
 * Signed area cannot tell the two triangulations apart: a fan's signed areas telescope to the
 * polygon's own area for *any* simple polygon, concave included, because the triangles that
 * spill outside the border come back with the opposite sign. That identity is exactly why the
 * bug survived — the arithmetic balances while the rendered surface does not.
 */
function paintedArea(points: readonly Vec2[], triangles: [number, number, number][]): number {
  return triangles.reduce(
    (total, [a, b, c]) => total + Math.abs(triangleArea(points[a]!, points[b]!, points[c]!)),
    0,
  );
}

/** What the old fan-from-the-first-corner triangulation produced. */
function fan(points: readonly Vec2[]): [number, number, number][] {
  const triangles: [number, number, number][] = [];
  for (let i = 1; i < points.length - 1; i += 1) triangles.push([0, i, i + 1]);
  return triangles;
}

describe('signedArea2D', () => {
  it('is positive counter-clockwise and negative clockwise', () => {
    expect(signedArea2D(SQUARE) / 2).toBeCloseTo(4);
    expect(signedArea2D([...SQUARE].reverse()) / 2).toBeCloseTo(-4);
  });
});

describe('isConvex2D', () => {
  it('accepts a square and rejects a star', () => {
    expect(isConvex2D(SQUARE)).toBe(true);
    expect(isConvex2D(star())).toBe(false);
  });

  it('ignores collinear corners rather than calling them a reversal', () => {
    // A square with an extra point halfway along one side is still convex.
    expect(isConvex2D([[0, 0], [1, 0], [2, 0], [2, 2], [0, 2]])).toBe(true);
  });
});

describe('triangulatePolygon2D', () => {
  it('produces exactly n-2 triangles', () => {
    // Not incidental: triangleCount() reports n-2 per face and the Inspector and perf HUD both
    // quote that number, so dropping a degenerate ear would make the reported cost a lie.
    for (const polygon of [SQUARE, star(), star(8, 1, 0.2)]) {
      expect(triangulatePolygon2D(polygon)).toHaveLength(polygon.length - 2);
    }
  });

  it('covers a convex polygon exactly once', () => {
    const triangles = triangulatePolygon2D(SQUARE);
    expect(coveredArea(SQUARE, triangles)).toBeCloseTo(signedArea2D(SQUARE) / 2);
  });

  it('covers a concave polygon exactly once, which a fan does not', () => {
    // The regression this module exists for. Fanning a star from one of its points paves over
    // the notches between the others and lays triangles back-to-front on top of them — geometry
    // that looks plausible in a wireframe and renders wrong the moment it is lit.
    const polygon = star();
    const area = signedArea2D(polygon) / 2;

    expect(paintedArea(polygon, triangulatePolygon2D(polygon))).toBeCloseTo(area, 6);
    expect(paintedArea(polygon, fan(polygon))).toBeGreaterThan(area * 1.3);
  });

  it('emits no back-facing triangle where a fan emits several', () => {
    const polygon = star();
    const backwards = (triangles: [number, number, number][]) =>
      triangles.filter(([a, b, c]) => triangleArea(polygon[a]!, polygon[b]!, polygon[c]!) < 0);

    expect(backwards(triangulatePolygon2D(polygon))).toHaveLength(0);
    expect(backwards(fan(polygon)).length).toBeGreaterThan(0);
    // Signed area is blind to this: the surplus and the back-facing triangles cancel exactly.
    expect(coveredArea(polygon, fan(polygon))).toBeCloseTo(signedArea2D(polygon) / 2, 6);
  });

  it('never emits a triangle that leaves the polygon', () => {
    // Every ear of a counter-clockwise polygon is itself counter-clockwise. A triangle with the
    // opposite sign is one that folded outside the border.
    const polygon = star(7, 1, 0.15);
    for (const [a, b, c] of triangulatePolygon2D(polygon)) {
      expect(triangleArea(polygon[a]!, polygon[b]!, polygon[c]!)).toBeGreaterThan(0);
    }
  });

  it("keeps the caller's winding", () => {
    const clockwise = [...star()].reverse();
    for (const [a, b, c] of triangulatePolygon2D(clockwise)) {
      expect(triangleArea(clockwise[a]!, clockwise[b]!, clockwise[c]!)).toBeLessThan(0);
    }
  });

  it('terminates on a degenerate ring instead of spinning', () => {
    // A polygon folded flat onto a line has no ear at all. The fallback clips the widest corner
    // so the loop always shrinks; an unbounded loop here would hang the render path.
    const collapsed: Vec2[] = [[0, 0], [1, 0], [2, 0], [1, 0]];
    expect(triangulatePolygon2D(collapsed)).toHaveLength(2);
  });

  it('handles too few points', () => {
    expect(triangulatePolygon2D([[0, 0], [1, 1]])).toHaveLength(0);
  });
});

describe('planeBasis', () => {
  it('builds a right-handed frame, so projection preserves winding', () => {
    for (const normal of [[0, 1, 0], [0, 0, 1], [1, 0, 0], [0.6, 0.8, 0]] as Vec3[]) {
      const [u, v] = planeBasis(normal);
      const cross: Vec3 = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
      ];
      // u × v === normal is the property that makes a counter-clockwise face stay
      // counter-clockwise once it is flattened.
      for (let axis = 0; axis < 3; axis += 1) expect(cross[axis]).toBeCloseTo(normal[axis]!, 6);
      expect(u[0] * v[0] + u[1] * v[1] + u[2] * v[2]).toBeCloseTo(0, 6);
    }
  });
});

describe('triangulatePolygon3D', () => {
  it('keeps every triangle facing the same way as the polygon', () => {
    // A concave polygon standing in an arbitrary plane, not axis-aligned.
    const points: Vec3[] = star(6, 1, 0.3).map(([x, y]) => [x, y * 0.6, x * 0.5 + y * 0.8]);
    const normal = newellNormal(points);

    for (const [a, b, c] of triangulatePolygon3D(points)) {
      const triangle = newellNormal([points[a]!, points[b]!, points[c]!]);
      const dot = triangle[0] * normal[0] + triangle[1] * normal[1] + triangle[2] * normal[2];
      expect(dot).toBeGreaterThan(0.5);
    }
  });

  it('fans a convex face without going near the ear clipper', () => {
    const points: Vec3[] = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]];
    expect(triangulatePolygon3D(points)).toEqual([
      [0, 1, 2],
      [0, 2, 3],
    ]);
  });
});
