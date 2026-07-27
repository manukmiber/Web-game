import { describe, expect, it } from 'vitest';
import {
  arcShape,
  circleShape,
  ellipseShape,
  fillShape,
  gearShape,
  polygonShape,
  rectangleShape,
  ringShape,
  shapeArea,
  shapeBounds,
  starShape,
  type Shape2D,
} from './shapes';
import { signedArea2D } from './tessellate';
import { faceNormal, meshBounds, triangleCount, vertexCount } from './MeshData';
import { SHAPE_PRIMITIVE_TYPES, generatePrimitive } from './generators';

const shapes: Record<string, Shape2D> = {
  circle: circleShape(1, 32),
  ellipse: ellipseShape(2, 1, 32),
  rectangle: rectangleShape(2, 1),
  rounded: rectangleShape(2, 1, 0.25, 4),
  polygon: polygonShape(1, 6),
  star: starShape(1, 0.4, 5),
  arc: arcShape(1, 0, 270, 16),
  ring: ringShape(1, 0.5, 24),
  gear: gearShape(1, 0.2, 10, 0.3),
};

describe('2D shapes', () => {
  it('winds every outline counter-clockwise', () => {
    // Everything downstream depends on it: the fill faces up because of it, the ear clipper
    // reads it to decide which corners are ears, and Extrude picks its wall direction from it.
    for (const [name, shape] of Object.entries(shapes)) {
      expect(signedArea2D(shape.outline), name).toBeGreaterThan(0);
      if (shape.hole) expect(signedArea2D(shape.hole), `${name} hole`).toBeGreaterThan(0);
    }
  });

  it('gives a hole exactly as many points as its outline', () => {
    // The fill bridges the two rings as quads, which only works one-to-one.
    for (const [name, shape] of Object.entries(shapes)) {
      if (shape.hole) expect(shape.hole.length, name).toBe(shape.outline.length);
    }
  });

  it('converges a circle on its true area as segments rise', () => {
    expect(shapeArea(circleShape(1, 8))).toBeLessThan(Math.PI * 0.95);
    expect(shapeArea(circleShape(1, 256))).toBeCloseTo(Math.PI, 3);
  });

  it('subtracts a hole from the area', () => {
    expect(shapeArea(ringShape(1, 0.5, 256))).toBeCloseTo(Math.PI * (1 - 0.25), 2);
  });

  it('sizes an ellipse by its two semi-axes', () => {
    const { min, max } = shapeBounds(ellipseShape(2, 1, 64));
    expect(max[0] - min[0]).toBeCloseTo(4, 1);
    expect(max[1] - min[1]).toBeCloseTo(2, 1);
  });

  it('gives a square rectangle four corners and a rounded one many more', () => {
    expect(rectangleShape(2, 1).outline).toHaveLength(4);
    expect(rectangleShape(2, 1, 0.25, 4).outline.length).toBeGreaterThan(4);
  });

  it('clamps a corner radius to half the shorter side', () => {
    // Without the clamp the four corner arcs cross each other and the outline self-intersects,
    // which is exactly the input the ear clipper cannot make sense of.
    const shape = rectangleShape(4, 2, 10, 8);
    const { min, max } = shapeBounds(shape);
    expect(max[0] - min[0]).toBeCloseTo(4, 6);
    expect(max[1] - min[1]).toBeCloseTo(2, 6);
    expect(shapeArea(shape)).toBeGreaterThan(0);
    expect(shapeArea(shape)).toBeLessThan(8);
  });

  it('alternates a star between its two radii', () => {
    const shape = starShape(1, 0.4, 6);
    expect(shape.outline).toHaveLength(12);
    const radii = shape.outline.map(([x, y]) => Math.hypot(x, y));
    for (let i = 0; i < radii.length; i += 1) {
      expect(radii[i]!).toBeCloseTo(i % 2 === 0 ? 1 : 0.4, 6);
    }
  });

  it('keeps an arc counter-clockwise even when the sweep runs backwards', () => {
    expect(signedArea2D(arcShape(1, 0, -120, 12).outline)).toBeGreaterThan(0);
  });

  it('collapses a full-sweep arc into a plain circle', () => {
    // Keeping the centre point would leave a stray vertex at the origin and a zero-area sliver.
    const full = arcShape(1, 0, 360, 16);
    expect(full.outline).toHaveLength(16);
    expect(full.outline.every(([x, y]) => Math.abs(Math.hypot(x, y) - 1) < 1e-9)).toBe(true);
  });

  it('collapses a degenerate bore into a solid disc', () => {
    expect(ringShape(1, 0, 16).hole).toBeUndefined();
    expect(gearShape(1, 0.2, 8, 0).hole).toBeUndefined();
  });

  it('gives a gear four points per tooth, alternating between two radii', () => {
    const shape = gearShape(1, 0.25, 9);
    expect(shape.outline).toHaveLength(36);
    const radii = shape.outline.map(([x, y]) => Math.hypot(x, y));
    expect(Math.max(...radii)).toBeCloseTo(1, 6);
    expect(Math.min(...radii)).toBeCloseTo(0.75, 6);
  });
});

describe('fillShape', () => {
  it('lays a shape flat in XZ, facing up', () => {
    const mesh = fillShape(circleShape(1, 16));
    const bounds = meshBounds(mesh)!;
    expect(bounds.min[1]).toBe(0);
    expect(bounds.max[1]).toBe(0);
    expect(faceNormal(mesh, mesh.faces[0]!)[1]).toBeCloseTo(1);
  });

  it('fills a hole-free shape as a single n-gon rather than a fan', () => {
    // One face keeps the profile intact for Extrude to cap with, and gives Subdivide and Bevel
    // a polygon to work on instead of a pile of triangles sharing a hub.
    const mesh = fillShape(starShape(1, 0.4, 5));
    expect(mesh.faces).toHaveLength(1);
    expect(mesh.faces[0]).toHaveLength(10);
    expect(triangleCount(mesh)).toBe(8);
  });

  it('fills an annulus as a ring of quads, all facing up', () => {
    const mesh = fillShape(ringShape(1, 0.5, 12));
    expect(mesh.faces).toHaveLength(12);
    expect(mesh.faces.every((face) => face.length === 4)).toBe(true);
    expect(vertexCount(mesh)).toBe(24);
    for (const face of mesh.faces) expect(faceNormal(mesh, face)[1]).toBeCloseTo(1);
  });

  it('carries UVs normalised over the shape bounds', () => {
    const mesh = fillShape(rectangleShape(2, 4));
    expect(mesh.uvs).toBeDefined();
    for (const uv of mesh.uvs!) {
      expect(uv).toBeGreaterThanOrEqual(0);
      expect(uv).toBeLessThanOrEqual(1);
    }
  });

  it('returns nothing for a shape with too few points', () => {
    expect(fillShape({ outline: [[0, 0], [1, 0]] }).faces).toHaveLength(0);
  });
});

describe('2D primitives', () => {
  it('builds every shape primitive flat, non-empty and facing up', () => {
    for (const primitive of SHAPE_PRIMITIVE_TYPES) {
      const mesh = generatePrimitive(primitive);
      const bounds = meshBounds(mesh)!;
      expect(mesh.faces.length, primitive).toBeGreaterThan(0);
      expect(bounds.min[1], primitive).toBeCloseTo(0);
      expect(bounds.max[1], primitive).toBeCloseTo(0);
      for (const face of mesh.faces) {
        expect(faceNormal(mesh, face)[1], primitive).toBeCloseTo(1);
      }
    }
  });

  it('sizes a circle by radius and an ellipse by width and depth', () => {
    const circle = meshBounds(generatePrimitive('Circle', { radius: 2, radialSegments: 128 }))!;
    expect(circle.max[0]).toBeCloseTo(2, 2);

    const ellipse = meshBounds(
      generatePrimitive('Ellipse', { width: 4, depth: 2, radialSegments: 128 }),
    )!;
    expect(ellipse.max[0] - ellipse.min[0]).toBeCloseTo(4, 2);
    expect(ellipse.max[2] - ellipse.min[2]).toBeCloseTo(2, 2);
  });
});
