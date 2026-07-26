import { describe, expect, it } from 'vitest';
import {
  createMeshData,
  edgeCount,
  faceCentroid,
  faceNormal,
  meshBounds,
  pushVertex,
  triangleCount,
  vertexCount,
} from '../MeshData';
import { generatePrimitive } from '../generators';
import {
  applyModifiers,
  createArrayModifier,
  createBendModifier,
  createMirrorModifier,
  createNoiseModifier,
  createSolidifyModifier,
  createSubdivideModifier,
  createTaperModifier,
  createTwistModifier,
  listModifierDefinitions,
  subdivide,
  type Modifier,
} from './index';

/** Distance of the furthest vertex from the origin. */
function maxRadius(mesh: ReturnType<typeof createMeshData>): number {
  let max = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    max = Math.max(max, Math.hypot(mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!));
  }
  return max;
}

describe('Subdivide', () => {
  it('turns every n-gon into one quad per corner', () => {
    const box = generatePrimitive('Box');
    const result = subdivide(box, 1);

    expect(result.faces).toHaveLength(24);
    expect(result.faces.every((face) => face.length === 4)).toBe(true);
  });

  it('quadruples faces per level', () => {
    const box = generatePrimitive('Box');
    expect(subdivide(box, 1).faces).toHaveLength(24);
    expect(subdivide(box, 2).faces).toHaveLength(96);
    expect(subdivide(box, 3).faces).toHaveLength(384);
  });

  it('converges a cube toward a sphere, which is what Catmull-Clark is for', () => {
    const box = generatePrimitive('Box', { width: 2, height: 2, depth: 2 });
    const before = maxRadius(box);
    const after = maxRadius(subdivide(box, 3));

    // The corners pull in substantially; a naive split-and-average would barely move them.
    expect(after).toBeLessThan(before * 0.85);
    expect(after).toBeGreaterThan(before * 0.5);
  });

  it('keeps an open mesh from shrinking away from its own border', () => {
    // The boundary rules are the whole reason this is tested: without them a Plane loses its
    // edges a little more on every level.
    const plane = generatePrimitive('Plane', { width: 2, depth: 2 });
    const bounds = meshBounds(subdivide(plane, 3))!;

    expect(bounds.min[0]).toBeCloseTo(-1, 1);
    expect(bounds.max[0]).toBeCloseTo(1, 1);
  });

  it('stays watertight', () => {
    const result = subdivide(generatePrimitive('Box'), 2);
    expect(vertexCount(result) - edgeCount(result) + result.faces.length).toBe(2);
  });

  it('is a no-op at zero levels', () => {
    const box = generatePrimitive('Box');
    expect(subdivide(box, 0).faces).toHaveLength(box.faces.length);
  });

  it('caps levels so a slider cannot lock the tab up', () => {
    const capped = subdivide(generatePrimitive('Box'), 99);
    expect(capped.faces).toHaveLength(6 * 4 ** 4);
  });

  it('preserves uvs through subdivision', () => {
    const result = subdivide(generatePrimitive('Box'), 1);
    expect(result.uvs).toBeDefined();
    expect(result.uvs!.length).toBe(vertexCount(result) * 2);
  });
});

describe('Mirror', () => {
  it('doubles the mesh across the chosen axis', () => {
    const box = generatePrimitive('Box', { width: 1, height: 1, depth: 1 });
    // Shift off the mirror plane so the halves do not overlap.
    for (let i = 0; i < box.positions.length; i += 3) box.positions[i] = box.positions[i]! + 2;

    const result = applyModifiers(box, [createMirrorModifier({ axis: 'X' })]);
    const bounds = meshBounds(result)!;

    expect(bounds.min[0]).toBeCloseTo(-2.5);
    expect(bounds.max[0]).toBeCloseTo(2.5);
    expect(result.faces).toHaveLength(12);
  });

  it('keeps the mirrored half facing outward rather than inside out', () => {
    const box = generatePrimitive('Box');
    for (let i = 0; i < box.positions.length; i += 3) box.positions[i] = box.positions[i]! + 2;

    const result = applyModifiers(box, [createMirrorModifier({ axis: 'X', merge: false })]);
    for (const face of result.faces) {
      const centroid = faceCentroid(result, face);
      const normal = faceNormal(result, face);
      // Each half is a box centred at +-2, so measure outwardness relative to its own centre.
      const cx = centroid[0] > 0 ? 2 : -2;
      const dot = (centroid[0] - cx) * normal[0] + centroid[1] * normal[1] + centroid[2] * normal[2];
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('welds the seam when the halves touch', () => {
    const box = generatePrimitive('Box', { width: 1 });
    // Sits against the mirror plane, so the seam vertices coincide.
    for (let i = 0; i < box.positions.length; i += 3) box.positions[i] = box.positions[i]! + 0.5;

    const merged = applyModifiers(box, [createMirrorModifier({ axis: 'X', merge: true })]);
    const unmerged = applyModifiers(box, [createMirrorModifier({ axis: 'X', merge: false })]);

    expect(vertexCount(merged)).toBeLessThan(vertexCount(unmerged));
  });
});

describe('Array', () => {
  it('repeats the mesh with relative spacing', () => {
    const box = generatePrimitive('Box', { width: 1 });
    const result = applyModifiers(box, [createArrayModifier({ count: 4, relativeX: 1 })]);

    expect(result.faces).toHaveLength(24);
    const bounds = meshBounds(result)!;
    expect(bounds.max[0] - bounds.min[0]).toBeCloseTo(4);
  });

  it('adds constant offset on top of the relative one', () => {
    const box = generatePrimitive('Box', { width: 1 });
    const result = applyModifiers(box, [
      createArrayModifier({ count: 2, relativeX: 1, constantX: 1 }),
    ]);
    const bounds = meshBounds(result)!;
    expect(bounds.max[0] - bounds.min[0]).toBeCloseTo(3);
  });

  it('is a no-op at count 1', () => {
    const box = generatePrimitive('Box');
    expect(applyModifiers(box, [createArrayModifier({ count: 1 })]).faces).toHaveLength(6);
  });

  it('caps the count so a slider cannot explode memory', () => {
    const box = generatePrimitive('Box');
    const result = applyModifiers(box, [createArrayModifier({ count: 100000 })]);
    expect(result.faces.length).toBe(6 * 256);
  });
});

describe('Solidify', () => {
  it('adds an inner shell to a closed mesh', () => {
    const box = generatePrimitive('Box');
    const result = applyModifiers(box, [createSolidifyModifier({ thickness: 0.1 })]);

    expect(vertexCount(result)).toBe(16);
    // Closed mesh: shell only, no rim needed.
    expect(result.faces).toHaveLength(12);
  });

  it('closes the border of an open mesh with rim faces', () => {
    const plane = generatePrimitive('Plane');
    const result = applyModifiers(plane, [createSolidifyModifier({ thickness: 0.1 })]);

    // Top, bottom, and four rim quads around the border.
    expect(result.faces).toHaveLength(6);
  });

  it('is a no-op at zero thickness', () => {
    const plane = generatePrimitive('Plane');
    expect(applyModifiers(plane, [createSolidifyModifier({ thickness: 0 })]).faces).toHaveLength(1);
  });
});

describe('deformers', () => {
  it('twists vertices progressively along the axis', () => {
    const box = generatePrimitive('Box', { height: 2, heightSegments: 4 });
    const result = applyModifiers(box, [createTwistModifier({ axis: 'Y', angle: 180 })]);

    // The bottom stays put and the top rotates, so the silhouette widens.
    const bounds = meshBounds(result)!;
    expect(bounds.max[0]).toBeGreaterThan(0.5);
    expect(vertexCount(result)).toBe(vertexCount(box));
  });

  it('leaves the mesh untouched at zero angle', () => {
    const box = generatePrimitive('Box');
    const result = applyModifiers(box, [createTwistModifier({ angle: 0 })]);
    expect(result.positions).toEqual(box.positions);
  });

  it('bends without producing NaN at a near-zero angle', () => {
    const box = generatePrimitive('Box', { height: 2 });
    const result = applyModifiers(box, [createBendModifier({ angle: 0 })]);
    expect(result.positions.every(Number.isFinite)).toBe(true);
    expect(result.positions).toEqual(box.positions);
  });

  it('bends into an arc without NaN at a real angle', () => {
    const box = generatePrimitive('Box', { height: 4, heightSegments: 8 });
    const result = applyModifiers(box, [createBendModifier({ axis: 'Y', angle: 120 })]);
    expect(result.positions.every(Number.isFinite)).toBe(true);
  });

  it('tapers toward the far end of the axis', () => {
    const box = generatePrimitive('Box', { height: 2, heightSegments: 2 });
    const result = applyModifiers(box, [createTaperModifier({ axis: 'Y', amount: 0 })]);
    const bounds = meshBounds(result)!;

    // The top collapses to a point, so the widest part is now at the bottom only.
    expect(bounds.max[0]).toBeCloseTo(0.5);
    expect(result.positions.every(Number.isFinite)).toBe(true);
  });

  it('displaces identical positions identically, so seams do not tear', () => {
    const mesh = createMeshData();
    // Two coincident vertices, as a welded seam would produce.
    pushVertex(mesh, 1, 2, 3);
    pushVertex(mesh, 1, 2, 3);
    pushVertex(mesh, 5, 0, 0);
    mesh.faces.push([0, 1, 2]);

    const result = applyModifiers(mesh, [createNoiseModifier({ strength: 1 })]);
    expect(result.positions.slice(0, 3)).toEqual(result.positions.slice(3, 6));
  });

  it('is deterministic for a given seed', () => {
    const box = generatePrimitive('Box');
    const a = applyModifiers(box, [createNoiseModifier({ seed: 7 })]);
    const b = applyModifiers(box, [createNoiseModifier({ seed: 7 })]);
    expect(a.positions).toEqual(b.positions);
  });
});

describe('modifier stack', () => {
  it('applies in order, and order changes the result', () => {
    const box = generatePrimitive('Box', { width: 1 });
    for (let i = 0; i < box.positions.length; i += 3) box.positions[i] = box.positions[i]! + 2;

    const mirrorThenArray = applyModifiers(box, [
      createMirrorModifier({ axis: 'X' }),
      createArrayModifier({ count: 2, relativeX: 1 }),
    ]);
    const arrayThenMirror = applyModifiers(box, [
      createArrayModifier({ count: 2, relativeX: 1 }),
      createMirrorModifier({ axis: 'X' }),
    ]);

    expect(meshBounds(mirrorThenArray)).not.toEqual(meshBounds(arrayThenMirror));
  });

  it('skips disabled entries', () => {
    const box = generatePrimitive('Box');
    const result = applyModifiers(box, [createSubdivideModifier({ enabled: false, levels: 2 })]);
    expect(result.faces).toHaveLength(6);
  });

  it('skips unknown types instead of throwing, so a newer scene still opens', () => {
    const box = generatePrimitive('Box');
    const unknown: Modifier = { type: 'FluidSim', enabled: true };
    expect(() => applyModifiers(box, [unknown])).not.toThrow();
    expect(applyModifiers(box, [unknown]).faces).toHaveLength(6);
  });

  it('does not mutate its input, so the stack stays non-destructive', () => {
    const box = generatePrimitive('Box');
    const before = [...box.positions];
    applyModifiers(box, [
      createSubdivideModifier({ levels: 2 }),
      createTwistModifier({ angle: 90 }),
      createSolidifyModifier({ thickness: 0.1 }),
    ]);
    expect(box.positions).toEqual(before);
  });

  it('composes into genuinely heavy geometry', () => {
    const box = generatePrimitive('Box');
    const result = applyModifiers(box, [
      createSubdivideModifier({ levels: 3 }),
      createArrayModifier({ count: 8, relativeX: 1.2 }),
    ]);
    expect(triangleCount(result)).toBeGreaterThan(6000);
  });

  it('registers every built-in modifier with a create and fields function', () => {
    const definitions = listModifierDefinitions();
    expect(definitions.length).toBeGreaterThanOrEqual(7);
    for (const definition of definitions) {
      const instance = definition.create();
      expect(instance.type, definition.type).toBe(definition.type);
      expect(Array.isArray(definition.fields(instance)), definition.type).toBe(true);
    }
  });
});
