import { describe, expect, it } from 'vitest';
import {
  createMeshData,
  edgeCount,
  faceCentroid,
  faceNormal,
  flipFaces,
  meshBounds,
  mergeMeshes,
  pushVertex,
  toBufferGeometry,
  triangleCount,
  vertexCount,
  weldVertices,
} from './MeshData';
import { PRIMITIVE_TYPES, generatePrimitive } from './generators';

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
    // An inside-out solid looks fine untextured and wrong the moment it is lit, so this is
    // checked for all of them rather than spot-checked on the sphere.
    for (const primitive of ['Box', 'Sphere', 'Cylinder', 'Cone', 'Capsule'] as const) {
      const mesh = generatePrimitive(primitive, { radius: 1, radiusTop: 0.6, radiusBottom: 1 });
      for (const face of mesh.faces) {
        const centroid = faceCentroid(mesh, face);
        const normal = faceNormal(mesh, face);
        const dot = centroid[0] * normal[0] + centroid[1] * normal[1] + centroid[2] * normal[2];
        expect(dot, `${primitive} face ${face.join(',')}`).toBeGreaterThan(0);
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

  it('scales triangle count with segments, which is the heavy-geometry lever', () => {
    const light = generatePrimitive('Sphere', { radialSegments: 8, heightSegments: 4 });
    const heavy = generatePrimitive('Sphere', { radialSegments: 64, heightSegments: 32 });
    expect(triangleCount(heavy)).toBeGreaterThan(triangleCount(light) * 20);
  });
});
