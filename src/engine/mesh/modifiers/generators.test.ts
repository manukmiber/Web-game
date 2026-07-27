import { describe, expect, it } from 'vitest';
import {
  createMeshData,
  getVertex,
  meshBounds,
  pushVertex,
  vertexCount,
  type MeshData,
} from '../MeshData';
import { generatePrimitive } from '../generators';
import { boundaryLoops } from '../loops';
import {
  createExtrudeModifier,
  createInsetModifier,
  createLatheModifier,
  createTransformModifier,
  extrude,
  inset,
  lathe,
  transformMesh,
} from './index';

/**
 * Tests for the *generator* modifiers — the ones that build geometry from a profile rather than
 * pushing existing vertices around. Deformers and the stack mechanics live in `modifiers.test.ts`.
 */

/** Enclosed volume via the divergence theorem. Negative means the solid is inside out. */
function volume(mesh: MeshData): number {
  let total = 0;
  for (const face of mesh.faces) {
    for (let i = 1; i < face.length - 1; i += 1) {
      const a = getVertex(mesh, face[0]!);
      const b = getVertex(mesh, face[i]!);
      const c = getVertex(mesh, face[i + 1]!);
      total +=
        a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
  }
  return total / 6;
}

/** Directed edges that are unmatched — holes, or faces wound against their neighbours. */
function nonManifoldEdges(mesh: MeshData): number {
  const directed = new Map<string, number>();
  for (const face of mesh.faces) {
    for (let i = 0; i < face.length; i += 1) {
      const key = `${face[i]}>${face[(i + 1) % face.length]}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const [key, count] of directed) {
    const [a, b] = key.split('>');
    if (count !== 1 || directed.get(`${b}>${a}`) !== 1) bad += 1;
  }
  return bad;
}

/** A unit square in XZ facing up — the simplest possible profile. */
function square(size = 1): MeshData {
  const mesh = createMeshData();
  const h = size / 2;
  pushVertex(mesh, -h, 0, h);
  pushVertex(mesh, h, 0, h);
  pushVertex(mesh, h, 0, -h);
  pushVertex(mesh, -h, 0, -h);
  mesh.faces.push([0, 1, 2, 3]);
  mesh.smoothFaces = [false];
  return mesh;
}

describe('boundaryLoops', () => {
  it('finds the single border of a flat profile, in face order', () => {
    const loops = boundaryLoops(square());
    expect(loops).toHaveLength(1);
    expect(loops[0]).toEqual([0, 1, 2, 3]);
  });

  it('finds both borders of an annulus', () => {
    const ring = generatePrimitive('Ring', { radius: 1, innerRadius: 0.5, radialSegments: 16 });
    expect(boundaryLoops(ring).map((loop) => loop.length)).toEqual([16, 16]);
  });

  it('finds nothing on a closed solid', () => {
    for (const primitive of ['Box', 'Sphere', 'Torus', 'Wedge'] as const) {
      expect(boundaryLoops(generatePrimitive(primitive)), primitive).toHaveLength(0);
    }
  });
});

describe('Extrude', () => {
  it('turns a square profile into a box of the right volume', () => {
    const solid = extrude(square(2), createExtrudeModifier({ distance: 3 }));
    expect(volume(solid)).toBeCloseTo(12, 6);
    expect(nonManifoldEdges(solid)).toBe(0);
  });

  it('turns a circle into a cylinder', () => {
    const circle = generatePrimitive('Circle', { radius: 1, radialSegments: 128 });
    const solid = extrude(circle, createExtrudeModifier({ distance: 2 }));
    expect(volume(solid)).toBeCloseTo(Math.PI * 2, 2);
    expect(nonManifoldEdges(solid)).toBe(0);
  });

  it('keeps a bore open through an extruded annulus', () => {
    const ring = generatePrimitive('Ring', { radius: 1, innerRadius: 0.5, radialSegments: 128 });
    const solid = extrude(ring, createExtrudeModifier({ distance: 1 }));
    // Both borders sweep, so the hole survives instead of being paved over.
    expect(volume(solid)).toBeCloseTo(Math.PI * (1 - 0.25), 2);
    expect(nonManifoldEdges(solid)).toBe(0);
  });

  it('faces outward whichever way the distance runs', () => {
    // A negative distance sweeps against the profile's normal, which winds every wall backwards.
    // The sweep measures that and flips the result, so both directions give a positive volume.
    const up = extrude(square(2), createExtrudeModifier({ distance: 1 }));
    const down = extrude(square(2), createExtrudeModifier({ distance: -1 }));
    expect(volume(up)).toBeCloseTo(4, 6);
    expect(volume(down)).toBeCloseTo(4, 6);
    expect(nonManifoldEdges(down)).toBe(0);
  });

  it('extrudes along the chosen axis', () => {
    const profile = square();
    const before = meshBounds(profile)!;
    for (const [axis, index] of [['X', 0], ['Y', 1], ['Z', 2]] as const) {
      const bounds = meshBounds(extrude(profile, createExtrudeModifier({ axis, distance: 2 })))!;
      const grew = bounds.max[index]! - bounds.min[index]! - (before.max[index]! - before.min[index]!);
      expect(grew, axis).toBeCloseTo(2, 6);
    }
  });

  it('tapers to a pyramid, whose volume is a third of the prism', () => {
    const pyramid = extrude(square(2), createExtrudeModifier({ distance: 3, taper: 0 }));
    expect(volume(pyramid)).toBeCloseTo(4, 3);
  });

  it('narrows toward the profile centre rather than the object origin', () => {
    // A profile authored off to one side should shrink toward itself. Tapering about the origin
    // would slide it sideways as it narrows, which reads as a shear rather than a taper.
    const offset = square(2);
    for (let i = 0; i < offset.positions.length; i += 3) offset.positions[i]! += 10;

    const tapered = extrude(offset, createExtrudeModifier({ distance: 1, taper: 0 }));
    const tip = getVertex(tapered, vertexCount(tapered) - 1);
    expect(tip[0]).toBeCloseTo(10, 6);
  });

  it('twists the far end without moving the near one', () => {
    const twisted = extrude(square(2), createExtrudeModifier({ distance: 1, steps: 4, twist: 90 }));
    const bounds = meshBounds(twisted)!;
    // A 2x2 square turned 45° on its way up sweeps out to its own diagonal.
    expect(bounds.max[0]).toBeCloseTo(Math.SQRT2, 4);
  });

  it('adds one ring of walls per step', () => {
    const one = extrude(square(), createExtrudeModifier({ distance: 1, steps: 1 }));
    const four = extrude(square(), createExtrudeModifier({ distance: 1, steps: 4 }));
    // 4 walls + 2 caps, then 16 walls + 2 caps.
    expect(one.faces).toHaveLength(6);
    expect(four.faces).toHaveLength(18);
  });

  it('leaves the ends open when the caps are turned off', () => {
    const open = extrude(
      square(),
      createExtrudeModifier({ distance: 1, capStart: false, capEnd: false }),
    );
    expect(open.faces).toHaveLength(4);
    expect(boundaryLoops(open)).toHaveLength(2);
  });

  it('passes a closed solid through untouched, because it has no border to sweep', () => {
    const box = generatePrimitive('Box');
    const result = extrude(box, createExtrudeModifier({ distance: 1 }));
    expect(result.faces).toHaveLength(box.faces.length);
    expect(volume(result)).toBeCloseTo(volume(box), 9);
  });
});

describe('Lathe', () => {
  it('revolves an offset circle into a torus', () => {
    const profile = transformMesh(
      generatePrimitive('Circle', { radius: 0.25, radialSegments: 64 }),
      [1, 0, 0],
      [0, 0, 0],
      [1, 1, 1],
    );
    const torus = lathe(profile, createLatheModifier({ axis: 'Z', segments: 96 }));

    // Pappus: the volume of a solid of revolution is the profile's area times the distance its
    // centroid travels.
    expect(volume(torus)).toBeCloseTo(2 * Math.PI * Math.PI * 1 * 0.25 * 0.25, 2);
    expect(nonManifoldEdges(torus)).toBe(0);
  });

  it('welds a full revolution shut instead of leaving a seam', () => {
    const profile = transformMesh(
      generatePrimitive('Polygon', { radius: 0.2, sides: 8 }),
      [1, 0, 0],
      [0, 0, 0],
      [1, 1, 1],
    );
    const ring = lathe(profile, createLatheModifier({ axis: 'Z', segments: 12 }));

    // 8 profile points x 12 rings, and not a thirteenth ring sitting on top of the first —
    // which would look identical until Subdivide or smooth shading turned it into a crease.
    expect(vertexCount(ring)).toBe(96);
    expect(nonManifoldEdges(ring)).toBe(0);
  });

  it('revolves a half disc into a sphere', () => {
    const half = generatePrimitive('Arc', { radius: 1, startAngle: 0, sweepAngle: 180, radialSegments: 64 });
    const sphere = lathe(half, createLatheModifier({ axis: 'X', segments: 64 }));
    expect(volume(sphere)).toBeCloseTo((4 / 3) * Math.PI, 1);
    // The points on the spin axis trace no circle; welding turns that column of duplicates into
    // the single pole it should be, so the surface closes.
    expect(nonManifoldEdges(sphere)).toBe(0);
  });

  it('caps the open ends of a partial revolution', () => {
    const profile = transformMesh(square(0.4), [1, 0, 0], [0, 0, 0], [1, 1, 1]);
    const quarter = lathe(profile, createLatheModifier({ axis: 'Z', angle: 90, segments: 8 }));
    expect(nonManifoldEdges(quarter)).toBe(0);
    expect(volume(quarter)).toBeGreaterThan(0);

    const open = lathe(
      profile,
      createLatheModifier({ axis: 'Z', angle: 90, segments: 8, capStart: false, capEnd: false }),
    );
    expect(boundaryLoops(open)).toHaveLength(2);
  });

  it('turns a revolution into a spring when it rises', () => {
    const profile = transformMesh(
      generatePrimitive('Circle', { radius: 0.1, radialSegments: 12 }),
      [1, 0, 0],
      [0, 0, 0],
      [1, 1, 1],
    );
    const spring = lathe(
      profile,
      createLatheModifier({ axis: 'Z', angle: 720, segments: 96, rise: 2 }),
    );
    const bounds = meshBounds(spring)!;
    // Two turns climbing 2 units, so the coil spans the rise plus the profile's own thickness.
    expect(bounds.max[2] - bounds.min[2]).toBeCloseTo(2.2, 1);
    expect(nonManifoldEdges(spring)).toBe(0);
  });

  it('faces outward with the profile on either side of the axis', () => {
    for (const side of [1, -1]) {
      const profile = transformMesh(square(0.4), [side, 0, 0], [0, 0, 0], [1, 1, 1]);
      const ring = lathe(profile, createLatheModifier({ axis: 'Z', segments: 24 }));
      expect(volume(ring), `x = ${side}`).toBeGreaterThan(0);
    }
  });

  it('passes a closed solid through untouched', () => {
    const box = generatePrimitive('Box');
    expect(lathe(box, createLatheModifier()).faces).toHaveLength(box.faces.length);
  });
});

describe('Inset', () => {
  it('adds an inner face and a rim quad per corner', () => {
    const result = inset(generatePrimitive('Box'), 0.2);
    // Six faces become six inner faces plus four rim quads each.
    expect(result.faces).toHaveLength(6 + 24);
    expect(nonManifoldEdges(result)).toBe(0);
  });

  it('leaves the volume alone at zero depth', () => {
    const box = generatePrimitive('Box', { width: 2, height: 2, depth: 2 });
    expect(volume(inset(box, 0.3))).toBeCloseTo(volume(box), 6);
  });

  it('pushes the inset face along its own normal', () => {
    const raised = inset(generatePrimitive('Box'), 0.2, 0.5);
    const bounds = meshBounds(raised)!;
    // Every face lifts by the depth, so the box grows by that much on all six sides.
    expect(bounds.max[1]).toBeCloseTo(1, 6);
    expect(bounds.min[1]).toBeCloseTo(-1, 6);
  });

  it('mitres corners so a long thin face insets evenly', () => {
    // The property a pull-toward-the-centroid inset gets wrong: on a 10:1 rectangle the centroid
    // is far along the length, so the short edges move much further than the long ones.
    const strip = createMeshData();
    pushVertex(strip, -5, 0, 0.5);
    pushVertex(strip, 5, 0, 0.5);
    pushVertex(strip, 5, 0, -0.5);
    pushVertex(strip, -5, 0, -0.5);
    strip.faces.push([0, 1, 2, 3]);

    const result = inset(strip, 0.2);
    const innerFace = result.faces[0]!;
    const corner = getVertex(result, innerFace[0]!);
    expect(Math.abs(corner[0])).toBeCloseTo(4.8, 6);
    expect(Math.abs(corner[2])).toBeCloseTo(0.3, 6);
  });

  it('never insets past the centre of a small face', () => {
    // An unclamped inset folds the polygon inside out and crosses the rim quads over each other.
    const result = inset(generatePrimitive('Box', { width: 0.1, height: 0.1, depth: 0.1 }), 5);
    expect(result.positions.every(Number.isFinite)).toBe(true);
    expect(volume(result)).toBeCloseTo(0.001, 6);
  });

  it('is a no-op when there is nothing to move', () => {
    const box = generatePrimitive('Box');
    expect(inset(box, 0, 0).faces).toHaveLength(box.faces.length);
  });
});

describe('Transform', () => {
  it('translates, rotates and scales the mesh itself', () => {
    const moved = transformMesh(square(2), [1, 2, 3], [0, 0, 0], [1, 1, 1]);
    const bounds = meshBounds(moved)!;
    expect(bounds.min).toEqual([0, 2, 2]);
    expect(bounds.max).toEqual([2, 2, 4]);

    const scaled = transformMesh(square(2), [0, 0, 0], [0, 0, 0], [3, 1, 1]);
    expect(meshBounds(scaled)!.max[0]).toBeCloseTo(3, 6);

    // 90° about X stands a ground-plane square up into the XY plane.
    const stood = transformMesh(square(2), [0, 0, 0], [90, 0, 0], [1, 1, 1]);
    const uprightBounds = meshBounds(stood)!;
    expect(uprightBounds.max[1] - uprightBounds.min[1]).toBeCloseTo(2, 6);
    expect(uprightBounds.max[2] - uprightBounds.min[2]).toBeCloseTo(0, 6);
  });

  it('keeps a solid the right way out under a negative scale', () => {
    // Mirroring reverses handedness, so without flipping the faces back a `-1` scale produces a
    // solid that is lit from the inside.
    const box = generatePrimitive('Box');
    const mirrored = transformMesh(box, [0, 0, 0], [0, 0, 0], [-1, 1, 1]);
    expect(volume(mirrored)).toBeCloseTo(volume(box), 9);
  });

  it('is the only way to set a lathe radius, because Lathe spins about the origin', () => {
    const profile = generatePrimitive('Circle', { radius: 0.2, radialSegments: 24 });
    const atOrigin = lathe(profile, createLatheModifier({ axis: 'Z', segments: 32 }));
    const movedOut = lathe(
      transformMesh(profile, [2, 0, 0], [0, 0, 0], [1, 1, 1]),
      createLatheModifier({ axis: 'Z', segments: 32 }),
    );

    // A profile straddling the axis sweeps through itself and encloses nothing worth having;
    // moved clear of it, the same profile makes a ring.
    expect(volume(movedOut)).toBeGreaterThan(volume(atOrigin) + 0.4);
  });

  it('registers with defaults that change nothing', () => {
    const modifier = createTransformModifier();
    expect(modifier.translate).toEqual([0, 0, 0]);
    expect(modifier.scale).toEqual([1, 1, 1]);
    const box = generatePrimitive('Box');
    expect(volume(transformMesh(box, modifier.translate, modifier.rotate, modifier.scale)))
      .toBeCloseTo(volume(box), 9);
  });

  it('exposes the inset defaults it registers with', () => {
    expect(createInsetModifier().thickness).toBeGreaterThan(0);
    expect(createInsetModifier({ depth: -0.1 }).depth).toBe(-0.1);
  });
});
