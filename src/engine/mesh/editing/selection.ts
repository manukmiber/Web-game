import { Topology, edgeKey, parseEdgeKey } from '../topology';
import type { MeshData } from '../MeshData';

export const ELEMENT_MODES = ['vertex', 'edge', 'face'] as const;
export type ElementMode = (typeof ELEMENT_MODES)[number];

/**
 * What is selected in edit mode.
 *
 * All three element kinds are carried at once rather than one per mode, because switching
 * modes has to *convert* rather than clear: picking three faces, pressing 2, and getting an
 * empty edge selection is the fastest way to make a modelling tool feel broken. Edges are
 * stored as `"a_b"` vertex-index keys so they survive being compared and de-duplicated
 * without a topology object to hand.
 */
export interface ElementSelection {
  vertices: number[];
  edges: string[];
  faces: number[];
}

export function emptySelection(): ElementSelection {
  return { vertices: [], edges: [], faces: [] };
}

export function isEmptySelection(selection: ElementSelection): boolean {
  return (
    selection.vertices.length === 0 &&
    selection.edges.length === 0 &&
    selection.faces.length === 0
  );
}

export function selectionCount(selection: ElementSelection, mode: ElementMode): number {
  if (mode === 'vertex') return selection.vertices.length;
  if (mode === 'edge') return selection.edges.length;
  return selection.faces.length;
}

/**
 * Rebuilds the other two element kinds from the one the user is actually picking.
 *
 * The rules are Blender's, and they are asymmetric on purpose:
 *
 * - Selecting faces implies every vertex and edge they use.
 * - Selecting edges implies their vertices, and any face whose edges are *all* selected.
 * - Selecting vertices implies any edge whose both ends are selected, and any face whose
 *   vertices are all selected.
 *
 * Going "down" is a union and going "up" needs full coverage — otherwise selecting one vertex
 * of a cube would select the three faces around it, and extruding would do something nobody
 * asked for.
 */
export function normaliseSelection(
  mesh: MeshData,
  selection: ElementSelection,
  mode: ElementMode,
  topology = new Topology(mesh),
): ElementSelection {
  if (mode === 'face') return fromFaces(mesh, selection.faces, topology);
  if (mode === 'edge') return fromEdges(mesh, selection.edges, topology);
  return fromVertices(mesh, selection.vertices, topology);
}

function fromFaces(mesh: MeshData, faces: number[], topology: Topology): ElementSelection {
  const valid = faces.filter((index) => mesh.faces[index]);
  const vertices = new Set<number>();
  const edges = new Set<string>();
  for (const index of valid) {
    for (const vertex of mesh.faces[index]!) vertices.add(vertex);
    for (const edge of topology.faceEdges[index] ?? []) edges.add(topology.edges[edge]!.key);
  }
  return { faces: [...valid], vertices: [...vertices], edges: [...edges] };
}

function fromEdges(mesh: MeshData, edges: string[], topology: Topology): ElementSelection {
  const selected = new Set(edges.filter((key) => topology.edgeAt(...parseEdgeKey(key))));
  const vertices = new Set<number>();
  for (const key of selected) {
    const [a, b] = parseEdgeKey(key);
    vertices.add(a);
    vertices.add(b);
  }
  const faces = mesh.faces
    .map((_, index) => index)
    .filter((index) =>
      (topology.faceEdges[index] ?? []).every((edge) => selected.has(topology.edges[edge]!.key)),
    );
  return { faces, vertices: [...vertices], edges: [...selected] };
}

function fromVertices(mesh: MeshData, vertices: number[], topology: Topology): ElementSelection {
  const selected = new Set(vertices.filter((index) => index >= 0));
  const edges = topology.edges
    .filter((edge) => selected.has(edge.a) && selected.has(edge.b))
    .map((edge) => edge.key);
  const faces = mesh.faces
    .map((_, index) => index)
    .filter((index) => mesh.faces[index]!.every((vertex) => selected.has(vertex)));
  return { faces, vertices: [...selected], edges };
}

/** Faces a face-level operation should act on, given whatever the user has selected. */
export function operableFaces(
  mesh: MeshData,
  selection: ElementSelection,
  mode: ElementMode,
  topology = new Topology(mesh),
): number[] {
  return normaliseSelection(mesh, selection, mode, topology).faces;
}

/** Edge indices for the selected edge keys, skipping any the mesh no longer has. */
export function selectedEdgeIndices(selection: ElementSelection, topology: Topology): number[] {
  const out: number[] = [];
  for (const key of selection.edges) {
    const index = topology.edgeIndexAt(...parseEdgeKey(key));
    if (index !== undefined) out.push(index);
  }
  return out;
}

export function selectionFromFaces(faces: Iterable<number>, mesh: MeshData): ElementSelection {
  return normaliseSelection(mesh, { ...emptySelection(), faces: [...faces] }, 'face');
}

export function selectionFromVertices(vertices: Iterable<number>, mesh: MeshData): ElementSelection {
  return normaliseSelection(mesh, { ...emptySelection(), vertices: [...vertices] }, 'vertex');
}

export function selectionFromEdgePairs(
  pairs: Iterable<[number, number]>,
  mesh: MeshData,
): ElementSelection {
  const edges = [...pairs].map(([a, b]) => edgeKey(a, b));
  return normaliseSelection(mesh, { ...emptySelection(), edges }, 'edge');
}
