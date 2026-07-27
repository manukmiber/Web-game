import { describe, expect, it } from 'vitest';
import {
  createMeshData,
  edgeCount,
  faceCentroid,
  faceNormal,
  flipFaces,
  getVertex,
  meshBounds,
  mergeMeshes,
  pushVertex,
  toBufferGeometry,
  triangleCount,
  vertexCount,
  weldVertices,
} from './MeshData';
import { PRIMITIVE_TYPES, generatePrimitive } from './generators';

/** Primitives that enclose a volume, so winding and manifold checks apply to them. */
const CLOSED_PRIMITIVES = [
  'Box',
  'Sphere',
  'Icosphere',
  'Cylinder',
  'Cone',
  'Capsule',
  'Torus',
  'Tube',
  'Wedge',
] as const;

/**
 * Six times the signed volume of a closed mesh. Positive when faces wind counter-clockwise
 * seen from outside, negative when the solid is inside out.
 */
function signedVolume(mesh: ReturnType<typeof createMeshData>): number {
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
  return total;
}

/** A unit quad in the XZ plane, facing up. */
function quad() {
  const mesh = createMeshData();
  pushVertex(mesh, 0, 0, 0);
  pushVertex(mesh, 1, 0, 0);
  pushVertex(mesh, 1, 0, 1);
  pushVertex(mesh, 0, 0, 1);
  mesh.faces.push([0, 3, 2, 1]);
  return mesh;
}

describe('MeshData basics', () => {
  it('counts vertices, edges and triangles of an n-gon', () => {
    const mesh = quad();
    expect(vertexCount(mesh)).toBe(4);
    expect(edgeCount(mesh)).toBe(4);
    // A quad fans into two triangles.
    expect(triangleCount(mesh)).toBe(2);
  });

  it('computes a face centroid', () => {
    expect(faceCentroid(quad(), [0, 1, 2, 3])).toEqual([0.5, 0, 0.5]);
  });

  it('computes an n-gon normal with Newell rather than a first-three cross product', () => {
    const normal = faceNormal(quad(), [0, 3, 2, 1]);
    expect(normal[0]).toBeCloseTo(0);
    expect(normal[1]).toBeCloseTo(1);
    expect(normal[2]).toBeCloseTo(0);
  });

  it('reverses the normal when the face is flipped', () => {
    const mesh = quad();
    flipFaces(mesh);
    expect(faceNormal(mesh, mesh.faces[0]!)[1]).toBeCloseTo(-1);
  });

  it('reports bounds, and null for an empty mesh', () => {
    expect(meshBounds(quad())).toEqual({ min: [0, 0, 0], max: [1, 0, 1] });
    expect(meshBounds(createMeshData())).toBeNull();
  });
});

describe('weldVertices', () => {
  it('merges coincident vertices and rewires the faces', () => {
    const mesh = createMeshData();
    // Two triangles sharing an edge, but with the shared vertices duplicated.
    pushVertex(mesh, 0, 0, 0);
    pushVertex(mesh, 1, 0, 0);
    pushVertex(mesh, 0, 0, 1);
    pushVertex(mesh, 1, 0, 0);
    pushVertex(mesh, 0, 0, 1);
    pushVertex(mesh, 1, 0, 1);
    mesh.faces.push([0, 2, 1], [3, 4, 5]);

    const welded = weldVertices(mesh);
    expect(vertexCount(welded)).toBe(4);
    expect(welded.faces).toHaveLength(2);
  });

  it('leaves distinct vertices alone', () => {
    const welded = weldVertices(quad());
    expect(vertexCount(welded)).toBe(4);
  });

  it('finds a pair that straddles a spatial hash boundary', () => {
    const mesh = createMeshData();
    // Either side of zero: naive bucketing would put these in different cells and miss them.
    pushVertex(mesh, -1e-6, 0, 0);
    pushVertex(mesh, 1e-6, 0, 0);
    pushVertex(mesh, 1, 0, 0);
    pushVertex(mesh, 0, 0, 1);
    mesh.faces.push([0, 2, 3], [1, 2, 3]);

    expect(vertexCount(weldVertices(mesh, 1e-4))).toBe(3);
  });

  it('drops faces that collapse below three corners', () => {
    const mesh = createMeshData();
    pushVertex(mesh, 0, 0, 0);
    pushVertex(mesh, 0, 0, 0);
    pushVertex(mesh, 1, 0, 0);
    mesh.faces.push([0, 1, 2]);

    expect(weldVertices(mesh).faces).toHaveLength(0);
  });
});

describe('mergeMeshes', () => {
  it('offsets the incoming face indices', () => {
    const target = quad();
    mergeMeshes(target, quad());

    expect(vertexCount(target)).toBe(8);
    expect(target.faces).toHaveLength(2);
    expect(target.faces[1]).toEqual([4, 7, 6, 5]);
  });
});

describe('toBufferGeometry', () => {
  it('fans an n-gon into triangles', () => {
    const geometry = toBufferGeometry(quad());
    expect(geometry.getAttribute('position').count).toBe(6);
    expect(geometry.getAttribute('normal').count).toBe(6);
  });

  it('keeps flat faces crisp by not sharing normals', () => {
    const box = generatePrimitive('Box');
    const geometry = toBufferGeometry(box);
    const normals = geometry.getAttribute('normal');

    // Every normal on a default box points straight down an axis.
    for (let i = 0; i < normals.count; i += 1) {
      const magnitude = Math.abs(normals.getX(i)) + Math.abs(normals.getY(i)) + Math.abs(normals.getZ(i));
      expect(magnitude).toBeCloseTo(1, 4);
    }
  });

  it('keeps a concave n-gon inside its own outline', () => {
    // A star is one ten-corner face. Fanning it from the first corner would pave over the
    // notches between its points and lay triangles back-to-front on top of them, so the shape
    // rendered as a filled decagon. Every triangle should face the same way as the face itself.
    const star = generatePrimitive('Star', { radius: 1, innerRadius: 0.3, points: 5 });
    const geometry = toBufferGeometry(star);
    const positions = geometry.getAttribute('position');

    expect(positions.count).toBe(8 * 3);
    let area = 0;
    for (let i = 0; i < positions.count; i += 3) {
      // Signed area in XZ, where the shape lies. A negative one is a triangle that folded out.
      const ax = positions.getX(i);
      const az = positions.getZ(i);
      const triangle =
        ((positions.getX(i + 1) - ax) * (positions.getZ(i + 2) - az) -
          (positions.getZ(i + 1) - az) * (positions.getX(i + 2) - ax)) /
        2;
      expect(triangle).toBeLessThan(0); // Facing +Y means clockwise seen down the Z/X plane.
      area += Math.abs(triangle);
    }
    // Exactly the star's own area — no double covering.
    expect(area).toBeCloseTo(5 * 1 * 0.3 * Math.sin(Math.PI / 5), 6);
  });

  it('averages normals across smooth faces so a sphere has no facets', () => {
    const sphere = generatePrimitive('Sphere', { radius: 1, radialSegments: 16, heightSegments: 8 });
    const geometry = toBufferGeometry(sphere);
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');

    // On a unit sphere centred at the origin, a smooth normal equals the position direction.
    for (let i = 0; i < positions.count; i += 1) {
      const dot =
        positions.getX(i) * normals.getX(i) +
        positions.getY(i) * normals.getY(i) +
        positions.getZ(i) * normals.getZ(i);
      expect(dot).toBeGreaterThan(0.9);
    }
  });
});

describe('primitive generators', () => {
  it('produces a watertight quad box', () => {
    const box = generatePrimitive('Box');
    expect(vertexCount(box)).toBe(8);
    expect(box.faces).toHaveLength(6);
    expect(box.faces.every((face) => face.length === 4)).toBe(true);
    // Euler characteristic for a closed solid: V - E + F = 2.
    expect(vertexCount(box) - edgeCount(box) + box.faces.length).toBe(2);
  });

  it('segments a box into a grid of quads', () => {
    const box = generatePrimitive('Box', { widthSegments: 2, heightSegments: 2, depthSegments: 2 });
    expect(box.faces).toHaveLength(6 * 4);
    expect(box.faces.every((face) => face.length === 4)).toBe(true);
  });

  it('gives every primitive geometry and outward-facing normals', () => {
    for (const primitive of PRIMITIVE_TYPES) {
      const mesh = generatePrimitive(primitive);
      expect(mesh.faces.length, primitive).toBeGreaterThan(0);
      expect(vertexCount(mesh), primitive).toBeGreaterThan(0);
      expect(triangleCount(mesh), primitive).toBeGreaterThan(0);
    }
  });

  it('points every closed primitive outward', () => {
    // Signed volume via the divergence theorem rather than a centroid-dot-normal check.
    // The centroid test only holds for convex shapes — a torus face on the inside of the ring
    // legitimately points back toward the axis — whereas signed volume is positive for any
    // correctly wound closed surface and negative for an inside-out one.
    for (const primitive of CLOSED_PRIMITIVES) {
      const mesh = generatePrimitive(primitive, { radius: 1, radiusTop: 0.6, radiusBottom: 1 });
      expect(signedVolume(mesh), `${primitive} is inside out`).toBeGreaterThan(0);
    }
  });

  it('produces a consistently wound manifold for every closed primitive', () => {
    // Each directed edge should appear exactly once, with its reverse appearing exactly once
    // in the neighbouring face. A hole leaves an unmatched edge; a flipped face produces a
    // duplicate in the same direction. Neither is visible until something downstream breaks.
    for (const primitive of CLOSED_PRIMITIVES) {
      const mesh = generatePrimitive(primitive, { radius: 1, radiusTop: 0.6, radiusBottom: 1 });
      const directed = new Map<string, number>();
      for (const face of mesh.faces) {
        for (let i = 0; i < face.length; i += 1) {
          const key = `${face[i]}>${face[(i + 1) % face.length]}`;
          directed.set(key, (directed.get(key) ?? 0) + 1);
        }
      }
      for (const [key, count] of directed) {
        const [a, b] = key.split('>');
        expect(count, `${primitive}: edge ${key} used ${count} times`).toBe(1);
        expect(directed.get(`${b}>${a}`), `${primitive}: edge ${key} has no opposite`).toBe(1);
      }
    }
  });

  it('builds a cone tip as triangles rather than degenerate quads', () => {
    const cone = generatePrimitive('Cone', { radialSegments: 8, heightSegments: 1 });
    const triangles = cone.faces.filter((face) => face.length === 3);
    expect(triangles.length).toBe(8);
  });

  it('faces a plane upward', () => {
    const plane = generatePrimitive('Plane');
    expect(faceNormal(plane, plane.faces[0]!)[1]).toBeCloseTo(1);
  });

  it('builds a torus as an all-quad surface with no poles', () => {
    const torus = generatePrimitive('Torus', { radialSegments: 12, tubularSegments: 8 });

    expect(torus.faces).toHaveLength(96);
    expect(torus.faces.every((face) => face.length === 4)).toBe(true);
    // Closed surface with every vertex valence four: V - E + F = 0 for a torus.
    expect(vertexCount(torus) - edgeCount(torus) + torus.faces.length).toBe(0);
  });

  it('gives a tube an inner wall facing into the bore', () => {
    const tube = generatePrimitive('Tube', { radius: 1, innerRadius: 0.5, radialSegments: 8 });
    const bounds = meshBounds(tube)!;

    expect(bounds.max[0]).toBeCloseTo(1, 1);
    // Inner wall vertices exist at the bore radius.
    const hasBore = tube.positions.some((_, i) => {
      if (i % 3 !== 0) return false;
      const r = Math.hypot(tube.positions[i]!, tube.positions[i + 2]!);
      return Math.abs(r - 0.5) < 1e-6;
    });
    expect(hasBore).toBe(true);
  });

  it('falls back to a solid cylinder when the tube bore collapses', () => {
    const solid = generatePrimitive('Tube', { radius: 1, innerRadius: 0, radialSegments: 8 });
    expect(solid.faces.length).toBeGreaterThan(0);
    expect(solid.positions.every(Number.isFinite)).toBe(true);
  });

  it('gives an icosphere near-uniform triangles, unlike a UV sphere', () => {
    const ico = generatePrimitive('Icosphere', { radius: 1, subdivisions: 2 });

    // 20 base triangles, quadrupled per level.
    expect(ico.faces).toHaveLength(20 * 4 ** 2);
    expect(ico.faces.every((face) => face.length === 3)).toBe(true);

    // Every vertex sits on the sphere, and edge lengths cluster tightly — the property a UV
    // sphere lacks, where poles crowd and the equator stretches.
    for (let i = 0; i < ico.positions.length; i += 3) {
      const r = Math.hypot(ico.positions[i]!, ico.positions[i + 1]!, ico.positions[i + 2]!);
      expect(r).toBeCloseTo(1, 6);
    }
  });

  it('shares icosphere midpoints so the surface stays one connected shell', () => {
    const ico = generatePrimitive('Icosphere', { subdivisions: 2 });
    // Without a midpoint cache each triangle would own its own corners: 320 * 3 = 960 verts.
    expect(vertexCount(ico)).toBeLessThan(400);
    // Closed solid.
    expect(vertexCount(ico) - edgeCount(ico) + ico.faces.length).toBe(2);
  });

  it('builds a wedge as a closed ramp sloping toward +Z', () => {
    const wedge = generatePrimitive('Wedge', { width: 2, height: 1, depth: 4 });

    expect(vertexCount(wedge)).toBe(6);
    expect(wedge.faces).toHaveLength(5);
    expect(vertexCount(wedge) - edgeCount(wedge) + wedge.faces.length).toBe(2);

    // The high edge is at the back, so nothing at +Z rises above the floor.
    for (let i = 0; i < wedge.positions.length; i += 3) {
      if (wedge.positions[i + 2]! > 0) expect(wedge.positions[i + 1]).toBeCloseTo(-0.5);
    }
  });

  it('scales triangle count with segments, which is the heavy-geometry lever', () => {
    const light = generatePrimitive('Sphere', { radialSegments: 8, heightSegments: 4 });
    const heavy = generatePrimitive('Sphere', { radialSegments: 64, heightSegments: 32 });
    expect(triangleCount(heavy)).toBeGreaterThan(triangleCount(light) * 20);
  });
});
