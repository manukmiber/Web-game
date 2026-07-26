import { createMeshData, pushVertex, weldVertices, type MeshData } from './MeshData';

export const PRIMITIVE_TYPES = [
  'Box',
  'Sphere',
  'Icosphere',
  'Plane',
  'Cylinder',
  'Capsule',
  'Cone',
  'Torus',
  'Tube',
] as const;
export type PrimitiveType = (typeof PRIMITIVE_TYPES)[number];

export interface PrimitiveParams {
  width: number;
  height: number;
  depth: number;
  radius: number;
  radiusTop: number;
  radiusBottom: number;
  widthSegments: number;
  heightSegments: number;
  depthSegments: number;
  radialSegments: number;
  capSegments: number;
  /** Torus: radius of the ring cross-section. */
  tubeRadius: number;
  /** Torus: segments around the cross-section. */
  tubularSegments: number;
  /** Tube: inner radius of the bore. */
  innerRadius: number;
  /** Icosphere: recursion depth. Each level quadruples the triangle count. */
  subdivisions: number;
}

export const DEFAULT_PRIMITIVE_PARAMS: PrimitiveParams = {
  width: 1,
  height: 1,
  depth: 1,
  radius: 0.5,
  radiusTop: 0.5,
  radiusBottom: 0.5,
  widthSegments: 1,
  heightSegments: 1,
  depthSegments: 1,
  radialSegments: 24,
  capSegments: 6,
  tubeRadius: 0.2,
  tubularSegments: 16,
  innerRadius: 0.3,
  subdivisions: 2,
};

/** Which params each primitive consumes — drives the Inspector and the geometry cache key. */
const PARAMS_BY_PRIMITIVE: Record<PrimitiveType, (keyof PrimitiveParams)[]> = {
  Box: ['width', 'height', 'depth', 'widthSegments', 'heightSegments', 'depthSegments'],
  Sphere: ['radius', 'radialSegments', 'heightSegments'],
  Plane: ['width', 'depth', 'widthSegments', 'depthSegments'],
  Cylinder: ['radiusTop', 'radiusBottom', 'height', 'radialSegments', 'heightSegments'],
  Capsule: ['radius', 'height', 'radialSegments', 'capSegments'],
  Cone: ['radius', 'height', 'radialSegments', 'heightSegments'],
  Torus: ['radius', 'tubeRadius', 'radialSegments', 'tubularSegments'],
  Tube: ['radius', 'innerRadius', 'height', 'radialSegments', 'heightSegments'],
  Icosphere: ['radius', 'subdivisions'],
};

export function relevantParams(primitive: PrimitiveType): (keyof PrimitiveParams)[] {
  return PARAMS_BY_PRIMITIVE[primitive];
}

const clampSegments = (value: number, min = 1) => Math.max(min, Math.floor(value) || min);

/**
 * Builds a primitive as an editable quad mesh.
 *
 * These are written by hand rather than converted from THREE's geometries for one reason:
 * THREE hands back triangles with no quad structure, and every interesting operation
 * downstream — subdivision, extrude, edge loops — needs the quads. Generating them properly
 * here is what makes the modifier stack behave like Blender's rather than like a mesh
 * decimator.
 */
export function generatePrimitive(
  primitive: PrimitiveType,
  overrides: Partial<PrimitiveParams> = {},
): MeshData {
  const p = { ...DEFAULT_PRIMITIVE_PARAMS, ...overrides };
  switch (primitive) {
    case 'Box':
      return generateBox(p);
    case 'Plane':
      return generatePlane(p);
    case 'Sphere':
      return generateSphere(p);
    case 'Cylinder':
      return generateCylinder(p);
    case 'Cone':
      return generateCone(p);
    case 'Capsule':
      return generateCapsule(p);
    case 'Torus':
      return generateTorus(p);
    case 'Tube':
      return generateTube2(p);
    case 'Icosphere':
      return generateIcosphere(p);
    default:
      return generateBox(p);
  }
}

/** A rectangular grid of quads, produced in a local basis and mapped into world axes. */
function grid(
  mesh: MeshData,
  uSegments: number,
  vSegments: number,
  place: (u: number, v: number) => [number, number, number],
  smooth: boolean,
): void {
  const base = mesh.positions.length / 3;
  mesh.uvs ??= [];
  for (let v = 0; v <= vSegments; v += 1) {
    for (let u = 0; u <= uSegments; u += 1) {
      const [x, y, z] = place(u / uSegments, v / vSegments);
      pushVertex(mesh, x, y, z);
      mesh.uvs.push(u / uSegments, v / vSegments);
    }
  }
  mesh.smoothFaces ??= [];
  const stride = uSegments + 1;
  for (let v = 0; v < vSegments; v += 1) {
    for (let u = 0; u < uSegments; u += 1) {
      const a = base + v * stride + u;
      mesh.faces.push([a, a + 1, a + stride + 1, a + stride]);
      mesh.smoothFaces.push(smooth);
    }
  }
}

function generateBox(p: PrimitiveParams): MeshData {
  const mesh = createMeshData();
  const hw = p.width / 2;
  const hh = p.height / 2;
  const hd = p.depth / 2;
  const ws = clampSegments(p.widthSegments);
  const hs = clampSegments(p.heightSegments);
  const ds = clampSegments(p.depthSegments);

  // Six faces, each a quad grid so a segmented box subdivides and deforms properly.
  grid(mesh, ws, hs, (u, v) => [(u - 0.5) * p.width, (v - 0.5) * p.height, hd], false); // +Z
  grid(mesh, ws, hs, (u, v) => [(0.5 - u) * p.width, (v - 0.5) * p.height, -hd], false); // -Z
  grid(mesh, ds, hs, (u, v) => [hw, (v - 0.5) * p.height, (0.5 - u) * p.depth], false); // +X
  grid(mesh, ds, hs, (u, v) => [-hw, (v - 0.5) * p.height, (u - 0.5) * p.depth], false); // -X
  grid(mesh, ws, ds, (u, v) => [(u - 0.5) * p.width, hh, (0.5 - v) * p.depth], false); // +Y
  grid(mesh, ws, ds, (u, v) => [(u - 0.5) * p.width, -hh, (v - 0.5) * p.depth], false); // -Y

  // The six grids meet at shared corners; welding makes it one watertight surface so mirror,
  // subdivide and solidify all behave.
  return weldVertices(mesh, 1e-5);
}

function generatePlane(p: PrimitiveParams): MeshData {
  const mesh = createMeshData();
  grid(
    mesh,
    clampSegments(p.widthSegments),
    clampSegments(p.depthSegments),
    (u, v) => [(u - 0.5) * p.width, 0, (v - 0.5) * p.depth],
    false,
  );
  // Authored lying flat like Unity's Plane; the grid above builds it in XZ already, but the
  // winding from that basis faces down, so flip it to point at the sky.
  for (const face of mesh.faces) face.reverse();
  return mesh;
}

function generateSphere(p: PrimitiveParams): MeshData {
  const mesh = createMeshData();
  const radial = clampSegments(p.radialSegments, 3);
  const rings = clampSegments(p.heightSegments, 2);
  mesh.uvs = [];
  mesh.smoothFaces = [];

  // Rings of vertices from south to north. Poles are single vertices, so the top and bottom
  // bands are triangles and everything between them is quads — standard UV-sphere topology.
  const southPole = pushVertex(mesh, 0, -p.radius, 0);
  mesh.uvs.push(0.5, 0);

  const ringStart: number[] = [];
  for (let ring = 1; ring < rings; ring += 1) {
    const phi = (ring / rings) * Math.PI;
    const y = -Math.cos(phi) * p.radius;
    const r = Math.sin(phi) * p.radius;
    ringStart.push(mesh.positions.length / 3);
    for (let i = 0; i < radial; i += 1) {
      const theta = (i / radial) * Math.PI * 2;
      pushVertex(mesh, Math.cos(theta) * r, y, Math.sin(theta) * r);
      mesh.uvs.push(i / radial, ring / rings);
    }
  }

  const northPole = pushVertex(mesh, 0, p.radius, 0);
  mesh.uvs.push(0.5, 1);

  buildRingedSurface(mesh, ringStart, radial, southPole, northPole);
  return mesh;
}

/**
 * Stitches a stack of equal-sized vertex rings into quads, capped by triangle fans at the two
 * poles. Shared by the sphere and the capsule, which differ only in how the rings are placed.
 *
 * Winding runs lower-ring vertex, up, across, back down. Rings are generated with theta
 * increasing, which reads clockwise from outside, so going *up* first is what produces an
 * outward-facing normal — the opposite order silently builds an inside-out solid that looks
 * correct until it is lit.
 */
function buildRingedSurface(
  mesh: MeshData,
  ringStart: number[],
  radial: number,
  southPole: number,
  northPole: number,
): void {
  mesh.smoothFaces ??= [];
  const first = ringStart[0]!;
  for (let i = 0; i < radial; i += 1) {
    mesh.faces.push([southPole, first + i, first + ((i + 1) % radial)]);
    mesh.smoothFaces.push(true);
  }
  for (let ring = 0; ring < ringStart.length - 1; ring += 1) {
    const lower = ringStart[ring]!;
    const upper = ringStart[ring + 1]!;
    for (let i = 0; i < radial; i += 1) {
      const next = (i + 1) % radial;
      mesh.faces.push([lower + i, upper + i, upper + next, lower + next]);
      mesh.smoothFaces.push(true);
    }
  }
  const last = ringStart[ringStart.length - 1]!;
  for (let i = 0; i < radial; i += 1) {
    mesh.faces.push([northPole, last + ((i + 1) % radial), last + i]);
    mesh.smoothFaces.push(true);
  }
}

/** Shared body for cylinder and cone: a tube with independent top and bottom radii. */
function generateTube(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  radialSegments: number,
  heightSegments: number,
): MeshData {
  const mesh = createMeshData();
  const radial = clampSegments(radialSegments, 3);
  const rings = clampSegments(heightSegments);
  const half = height / 2;
  mesh.uvs = [];
  mesh.smoothFaces = [];

  const ringStart: number[] = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const t = ring / rings;
    const y = -half + height * t;
    const r = radiusBottom + (radiusTop - radiusBottom) * t;
    ringStart.push(mesh.positions.length / 3);
    for (let i = 0; i < radial; i += 1) {
      const theta = (i / radial) * Math.PI * 2;
      pushVertex(mesh, Math.cos(theta) * r, y, Math.sin(theta) * r);
      mesh.uvs.push(i / radial, t);
    }
  }

  for (let ring = 0; ring < rings; ring += 1) {
    const lower = ringStart[ring]!;
    const upper = ringStart[ring + 1]!;
    for (let i = 0; i < radial; i += 1) {
      const next = (i + 1) % radial;
      // A zero radius collapses the ring to a point, which would make a degenerate quad; emit
      // a triangle instead so a cone's tip is clean.
      if (radiusTop === 0 && ring === rings - 1) {
        mesh.faces.push([lower + i, upper + i, lower + next]);
      } else if (radiusBottom === 0 && ring === 0) {
        mesh.faces.push([lower + i, upper + i, upper + next]);
      } else {
        mesh.faces.push([lower + i, upper + i, upper + next, lower + next]);
      }
      mesh.smoothFaces.push(true);
    }
  }

  // Caps as n-gons rather than fans: one face each, which keeps the topology clean for
  // subdivision and gives inset/extrude something sensible to work on.
  // Caps wind opposite to each other so both point away from the body.
  if (radiusBottom > 0) {
    const bottom = ringStart[0]!;
    const face: number[] = [];
    for (let i = 0; i < radial; i += 1) face.push(bottom + i);
    mesh.faces.push(face);
    mesh.smoothFaces.push(false);
  }
  if (radiusTop > 0) {
    const top = ringStart[rings]!;
    const face: number[] = [];
    for (let i = radial - 1; i >= 0; i -= 1) face.push(top + i);
    mesh.faces.push(face);
    mesh.smoothFaces.push(false);
  }

  return weldVertices(mesh, 1e-5);
}

function generateCylinder(p: PrimitiveParams): MeshData {
  return generateTube(p.radiusTop, p.radiusBottom, p.height, p.radialSegments, p.heightSegments);
}

function generateCone(p: PrimitiveParams): MeshData {
  return generateTube(0, p.radius, p.height, p.radialSegments, p.heightSegments);
}

function generateCapsule(p: PrimitiveParams): MeshData {
  const mesh = createMeshData();
  const radial = clampSegments(p.radialSegments, 3);
  const caps = clampSegments(p.capSegments, 1);
  const half = p.height / 2;
  mesh.uvs = [];
  mesh.smoothFaces = [];

  const ringStart: number[] = [];
  const pushRing = (y: number, r: number, v: number) => {
    ringStart.push(mesh.positions.length / 3);
    for (let i = 0; i < radial; i += 1) {
      const theta = (i / radial) * Math.PI * 2;
      pushVertex(mesh, Math.cos(theta) * r, y, Math.sin(theta) * r);
      mesh.uvs!.push(i / radial, v);
    }
  };

  const southPole = pushVertex(mesh, 0, -half - p.radius, 0);
  mesh.uvs.push(0.5, 0);

  // Bottom hemisphere, straight section, top hemisphere — one continuous set of rings.
  for (let i = 1; i <= caps; i += 1) {
    const phi = (i / caps) * (Math.PI / 2);
    pushRing(-half - Math.cos(phi) * p.radius, Math.sin(phi) * p.radius, i / (caps * 4));
  }
  pushRing(half, p.radius, 0.5);
  for (let i = 1; i <= caps; i += 1) {
    const phi = (i / caps) * (Math.PI / 2);
    pushRing(half + Math.sin(phi) * p.radius, Math.cos(phi) * p.radius, 0.5 + i / (caps * 4));
  }

  const northPole = pushVertex(mesh, 0, half + p.radius, 0);
  mesh.uvs.push(0.5, 1);

  buildRingedSurface(mesh, ringStart, radial, southPole, northPole);
  return weldVertices(mesh, 1e-5);
}

/**
 * Torus: a ring of cross-section rings, stitched into an all-quad surface with no poles.
 *
 * The cleanest topology of any primitive here — every vertex has valence four and there are no
 * triangle fans, so it subdivides and deforms without artefacts. Useful as the reference shape
 * when checking whether a modifier misbehaves on quads.
 */
function generateTorus(p: PrimitiveParams): MeshData {
  const mesh = createMeshData();
  const major = clampSegments(p.radialSegments, 3);
  const minor = clampSegments(p.tubularSegments, 3);
  mesh.uvs = [];
  mesh.smoothFaces = [];

  for (let i = 0; i < major; i += 1) {
    const theta = (i / major) * Math.PI * 2;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);
    for (let j = 0; j < minor; j += 1) {
      const phi = (j / minor) * Math.PI * 2;
      const r = p.radius + p.tubeRadius * Math.cos(phi);
      pushVertex(mesh, cosTheta * r, p.tubeRadius * Math.sin(phi), sinTheta * r);
      mesh.uvs.push(i / major, j / minor);
    }
  }

  for (let i = 0; i < major; i += 1) {
    const ring = i * minor;
    const nextRing = ((i + 1) % major) * minor;
    for (let j = 0; j < minor; j += 1) {
      const next = (j + 1) % minor;
      // Around the cross-section first, then along the ring: the opposite order winds the
      // whole torus inside out, which no convex-shape test would catch.
      mesh.faces.push([ring + j, ring + next, nextRing + next, nextRing + j]);
      mesh.smoothFaces.push(true);
    }
  }

  return mesh;
}

/**
 * Tube: a cylinder with a bore through it.
 *
 * Outer wall, inner wall wound the other way so it faces into the hole, and annular caps
 * bridging the two at each end. A degenerate `innerRadius` falls back to a solid cylinder
 * rather than producing a zero-width shell.
 */
function generateTube2(p: PrimitiveParams): MeshData {
  const inner = Math.max(0, Math.min(p.innerRadius, p.radius - 1e-4));
  if (inner <= 1e-4) {
    return generateTube(p.radius, p.radius, p.height, p.radialSegments, p.heightSegments);
  }

  const mesh = createMeshData();
  const radial = clampSegments(p.radialSegments, 3);
  const rings = clampSegments(p.heightSegments);
  const half = p.height / 2;
  mesh.uvs = [];
  mesh.smoothFaces = [];

  const wallStart: number[][] = [];
  for (const radius of [p.radius, inner]) {
    const starts: number[] = [];
    for (let ring = 0; ring <= rings; ring += 1) {
      const y = -half + p.height * (ring / rings);
      starts.push(mesh.positions.length / 3);
      for (let i = 0; i < radial; i += 1) {
        const theta = (i / radial) * Math.PI * 2;
        pushVertex(mesh, Math.cos(theta) * radius, y, Math.sin(theta) * radius);
        mesh.uvs.push(i / radial, ring / rings);
      }
    }
    wallStart.push(starts);
  }

  const [outer, bore] = wallStart as [number[], number[]];

  for (let ring = 0; ring < rings; ring += 1) {
    for (let i = 0; i < radial; i += 1) {
      const next = (i + 1) % radial;
      // Outer wall faces out; the bore is wound the opposite way so it faces inward.
      mesh.faces.push([outer[ring]! + i, outer[ring + 1]! + i, outer[ring + 1]! + next, outer[ring]! + next]);
      mesh.smoothFaces.push(true);
      mesh.faces.push([bore[ring]! + i, bore[ring]! + next, bore[ring + 1]! + next, bore[ring + 1]! + i]);
      mesh.smoothFaces.push(true);
    }
  }

  // Annular caps: quads spanning the gap between the two walls.
  for (let i = 0; i < radial; i += 1) {
    const next = (i + 1) % radial;
    mesh.faces.push([outer[0]! + i, outer[0]! + next, bore[0]! + next, bore[0]! + i]);
    mesh.smoothFaces.push(false);
    mesh.faces.push([outer[rings]! + i, bore[rings]! + i, bore[rings]! + next, outer[rings]! + next]);
    mesh.smoothFaces.push(false);
  }

  return mesh;
}

/**
 * Icosphere: an icosahedron subdivided and projected onto the sphere.
 *
 * Worth having alongside the UV sphere because its triangles are near-uniform everywhere,
 * while a UV sphere crowds vertices at the poles and stretches them at the equator. That
 * matters for displacement, physics hulls and anything that samples the surface evenly.
 *
 * Triangles rather than quads here is correct, not a compromise — an icosahedron has no quad
 * subdivision that stays uniform.
 */
function generateIcosphere(p: PrimitiveParams): MeshData {
  const mesh = createMeshData();
  mesh.smoothFaces = [];

  const t = (1 + Math.sqrt(5)) / 2;
  const base: [number, number, number][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  let faces: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  const points = base.map(([x, y, z]) => {
    const length = Math.hypot(x, y, z);
    return [x / length, y / length, z / length] as [number, number, number];
  });

  // Cache midpoints per edge so neighbouring triangles share them; without it the surface
  // splits into disconnected shells and smooth shading breaks along every seam.
  const levels = Math.max(0, Math.min(5, Math.floor(p.subdivisions)));
  for (let level = 0; level < levels; level += 1) {
    const midpoints = new Map<string, number>();
    const next: [number, number, number][] = [];

    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const cached = midpoints.get(key);
      if (cached !== undefined) return cached;
      const pa = points[a]!;
      const pb = points[b]!;
      const x = (pa[0] + pb[0]) / 2;
      const y = (pa[1] + pb[1]) / 2;
      const z = (pa[2] + pb[2]) / 2;
      const length = Math.hypot(x, y, z);
      points.push([x / length, y / length, z / length]);
      const index = points.length - 1;
      midpoints.set(key, index);
      return index;
    };

    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }

  for (const [x, y, z] of points) pushVertex(mesh, x * p.radius, y * p.radius, z * p.radius);
  for (const face of faces) {
    mesh.faces.push([...face]);
    mesh.smoothFaces.push(true);
  }

  return mesh;
}
