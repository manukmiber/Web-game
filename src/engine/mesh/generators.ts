import { createMeshData, pushVertex, weldVertices, type MeshData } from './MeshData';

export const PRIMITIVE_TYPES = ['Box', 'Sphere', 'Plane', 'Cylinder', 'Capsule', 'Cone'] as const;
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
};

/** Which params each primitive consumes — drives the Inspector and the geometry cache key. */
const PARAMS_BY_PRIMITIVE: Record<PrimitiveType, (keyof PrimitiveParams)[]> = {
  Box: ['width', 'height', 'depth', 'widthSegments', 'heightSegments', 'depthSegments'],
  Sphere: ['radius', 'radialSegments', 'heightSegments'],
  Plane: ['width', 'depth', 'widthSegments', 'depthSegments'],
  Cylinder: ['radiusTop', 'radiusBottom', 'height', 'radialSegments', 'heightSegments'],
  Capsule: ['radius', 'height', 'radialSegments', 'capSegments'],
  Cone: ['radius', 'height', 'radialSegments', 'heightSegments'],
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
