import {
  cloneMeshData,
  createMeshData,
  triangulateFace,
  weldVertices,
  type MeshData,
} from '../MeshData';
import { registerModifier, type Modifier } from './registry';

// -------------------------------------------------------------------- Weld

export interface WeldModifier extends Modifier {
  type: 'Weld';
  distance: number;
}

export function createWeldModifier(overrides: Partial<WeldModifier> = {}): WeldModifier {
  return { type: 'Weld', enabled: true, distance: 0.01, ...overrides };
}

registerModifier<WeldModifier>({
  type: 'Weld',
  label: 'Weld (Merge by Distance)',
  create: createWeldModifier,
  fields: () => [{ kind: 'number', key: 'distance', label: 'Distance', min: 0, step: 0.001 }],
  /**
   * Cleans up duplicate vertices left by other modifiers.
   *
   * Mirror and Array can both leave two vertices sitting on top of each other where copies
   * meet. They look fine flat-shaded and turn into a visible crease the moment Subdivide or
   * smooth shading runs, so having this as an explicit stack entry lets the seam be closed at
   * the point in the pipeline where it appears.
   */
  apply: (mesh, modifier) => weldVertices(mesh, Math.max(0, modifier.distance)),
});

// ------------------------------------------------------------- Triangulate

export interface TriangulateModifier extends Modifier {
  type: 'Triangulate';
}

export function createTriangulateModifier(
  overrides: Partial<TriangulateModifier> = {},
): TriangulateModifier {
  return { type: 'Triangulate', enabled: true, ...overrides };
}

/**
 * Splits every n-gon into triangles as actual mesh data.
 *
 * The renderer triangulates anyway on its way to the GPU, through the same code, so this changes
 * nothing visually. What it changes is the *topology downstream*: once triangulated, Subdivide
 * behaves like a triangle subdivider and Bevel sees three edges per face instead of four. That is
 * occasionally what you want, and it is what an exporter or a physics hull needs.
 */
export function triangulate(mesh: MeshData): MeshData {
  const out = createMeshData();
  out.positions = [...mesh.positions];
  if (mesh.uvs) out.uvs = [...mesh.uvs];
  out.smoothFaces = [];

  for (const [faceIndex, face] of mesh.faces.entries()) {
    const smooth = mesh.smoothFaces?.[faceIndex] ?? false;
    for (const triangle of triangulateFace(mesh, face)) {
      out.faces.push([...triangle]);
      out.smoothFaces.push(smooth);
    }
  }

  return out;
}

registerModifier<TriangulateModifier>({
  type: 'Triangulate',
  label: 'Triangulate',
  create: createTriangulateModifier,
  fields: () => [],
  apply: (mesh) => triangulate(mesh),
});

// ------------------------------------------------------------ Shade Smooth

export interface ShadeModifier extends Modifier {
  type: 'Shade';
  smooth: boolean;
}

export function createShadeModifier(overrides: Partial<ShadeModifier> = {}): ShadeModifier {
  return { type: 'Shade', enabled: true, smooth: true, ...overrides };
}

registerModifier<ShadeModifier>({
  type: 'Shade',
  label: 'Shade Smooth / Flat',
  create: createShadeModifier,
  fields: () => [{ kind: 'boolean', key: 'smooth', label: 'Smooth' }],
  /**
   * Overrides per-face shading for the whole mesh.
   *
   * Cheap but disproportionately useful: a box is flat-shaded by default and a bevelled box
   * usually wants to be smooth, and without this the only way to get there was to add a
   * Subdivide purely for its smooth flag.
   */
  apply: (mesh, modifier) => {
    const out = cloneMeshData(mesh);
    out.smoothFaces = out.faces.map(() => modifier.smooth);
    return out;
  },
});
