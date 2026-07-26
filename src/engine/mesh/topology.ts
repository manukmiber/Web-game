import { faceCentroid, faceNormal, getVertex, vertexCount, type MeshData } from './MeshData';
import type { Vec3 } from '../scene/types';

/** Undirected edge key, always low index first, so the two directions collapse to one. */
export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

export function parseEdgeKey(key: string): [number, number] {
  const [a, b] = key.split('_');
  return [Number(a), Number(b)];
}

export interface TopologyEdge {
  a: number;
  b: number;
  key: string;
  /** Faces using this edge. One face means a border; more than two means non-manifold. */
  faces: number[];
}

/**
 * Adjacency for an editable mesh: who touches what.
 *
 * `MeshData` stores only positions and face vertex lists, which is the right thing to
 * serialise but the wrong thing to model with — every interesting operation needs to answer
 * "which faces meet at this edge", "which edges leave this vertex", "is this a border". Those
 * answers are derived here, once, rather than rebuilt inside each operation.
 *
 * Rebuilt from scratch per operation rather than maintained incrementally. Operations rewrite
 * indices wholesale, and an incremental structure that has to survive that is a much larger
 * thing to get right than a linear rebuild is to pay for.
 */
export class Topology {
  readonly edges: TopologyEdge[] = [];
  private readonly edgeIndex = new Map<string, number>();
  /** Faces touching each vertex. */
  readonly vertexFaces: number[][];
  /** Edges touching each vertex. */
  readonly vertexEdges: number[][];
  /** Edges of each face, in the same order as the face's vertex pairs. */
  readonly faceEdges: number[][];

  constructor(readonly mesh: MeshData) {
    const count = vertexCount(mesh);
    this.vertexFaces = Array.from({ length: count }, () => []);
    this.vertexEdges = Array.from({ length: count }, () => []);
    this.faceEdges = mesh.faces.map(() => []);

    for (const [faceIndex, face] of mesh.faces.entries()) {
      for (const [i, vertex] of face.entries()) {
        if (this.vertexFaces[vertex]) this.vertexFaces[vertex]!.push(faceIndex);
        const next = face[(i + 1) % face.length]!;
        const edge = this.touchEdge(vertex, next);
        this.faceEdges[faceIndex]!.push(edge);
        if (!this.edges[edge]!.faces.includes(faceIndex)) this.edges[edge]!.faces.push(faceIndex);
      }
    }
  }

  private touchEdge(a: number, b: number): number {
    const key = edgeKey(a, b);
    const existing = this.edgeIndex.get(key);
    if (existing !== undefined) return existing;

    const index = this.edges.length;
    this.edges.push({ a: Math.min(a, b), b: Math.max(a, b), key, faces: [] });
    this.edgeIndex.set(key, index);
    this.vertexEdges[a]?.push(index);
    this.vertexEdges[b]?.push(index);
    return index;
  }

  edgeAt(a: number, b: number): TopologyEdge | undefined {
    const index = this.edgeIndex.get(edgeKey(a, b));
    return index === undefined ? undefined : this.edges[index];
  }

  edgeIndexAt(a: number, b: number): number | undefined {
    return this.edgeIndex.get(edgeKey(a, b));
  }

  /** An edge with a single face is on the mesh's border. */
  isBorderEdge(index: number): boolean {
    return (this.edges[index]?.faces.length ?? 0) < 2;
  }

  /**
   * The face across an edge from `faceIndex`, or undefined at a border.
   *
   * Precondition: `faceIndex` is one of the (at most two) faces already on this edge. Calling
   * it with an unrelated face is a caller bug — the two-face case can't distinguish "the other
   * face" from "not my edge" and will silently hand back `faces[0]`, which is wrong rather
   * than merely imprecise. Every caller in this file gets `edgeIndex` from
   * `faceEdges[faceIndex]`, which satisfies this by construction.
   */
  otherFace(edgeIndex: number, faceIndex: number): number | undefined {
    const faces = this.edges[edgeIndex]?.faces;
    if (!faces || faces.length !== 2) return undefined;
    if (faces[0] !== faceIndex && faces[1] !== faceIndex) return undefined;
    return faces[0] === faceIndex ? faces[1] : faces[0];
  }

  /**
   * Edges on the outside of a set of faces — used by every region operation.
   *
   * An edge is on the boundary when the set uses it an odd number of times: once from inside
   * the region and, if the neighbour is also selected, once from outside. Counting rather than
   * checking `faces.length` is what makes this correct for a region touching a border.
   */
  regionBoundary(faces: Iterable<number>): number[] {
    const counts = new Map<number, number>();
    for (const faceIndex of faces) {
      for (const edge of this.faceEdges[faceIndex] ?? []) {
        counts.set(edge, (counts.get(edge) ?? 0) + 1);
      }
    }
    return [...counts.entries()].filter(([, count]) => count === 1).map(([edge]) => edge);
  }

  /** Every vertex used by the given faces. */
  verticesOfFaces(faces: Iterable<number>): number[] {
    const out = new Set<number>();
    for (const faceIndex of faces) {
      for (const vertex of this.mesh.faces[faceIndex] ?? []) out.add(vertex);
    }
    return [...out];
  }

  /**
   * Faces around a vertex, ordered by walking from one to the next across shared edges.
   *
   * Bevel needs this: the corner polygon it builds is only convex — only *correct* — if its
   * vertices come round the fan in order. Walking starts from a border edge when there is one
   * so an open fan is traversed end to end rather than from the middle.
   */
  orderedFaceFan(vertex: number): number[] {
    const faces = this.vertexFaces[vertex] ?? [];
    if (faces.length < 2) return [...faces];
    const incident = (this.vertexEdges[vertex] ?? []).filter((edge) => !this.isBorderEdge(edge));
    const border = (this.vertexEdges[vertex] ?? []).find((edge) => this.isBorderEdge(edge));

    const remaining = new Set(faces);
    const start = border ? this.edges[border]!.faces[0] : faces[0];
    if (start === undefined) return [...faces];

    const ordered: number[] = [start];
    remaining.delete(start);
    let current = start;
    let guard = faces.length + 1;

    while (remaining.size > 0 && guard-- > 0) {
      const next = incident
        .map((edge) => this.otherFace(edge, current))
        .find((face) => face !== undefined && remaining.has(face));
      // A vertex whose fan is broken by non-manifold geometry cannot be walked; the remaining
      // faces are appended so no data is lost, and the caller sees an unordered tail.
      if (next === undefined) {
        ordered.push(...remaining);
        break;
      }
      ordered.push(next);
      remaining.delete(next);
      current = next;
    }
    return ordered;
  }
}

/** Cached per-face normals and centroids — every region operation wants both. */
export function faceFrames(mesh: MeshData, faces: Iterable<number>): Map<number, { normal: Vec3; centre: Vec3 }> {
  const out = new Map<number, { normal: Vec3; centre: Vec3 }>();
  for (const index of faces) {
    const face = mesh.faces[index];
    if (!face) continue;
    out.set(index, { normal: faceNormal(mesh, face), centre: faceCentroid(mesh, face) });
  }
  return out;
}

/** Average of several face normals, normalised. Falls back to +Y for a degenerate set. */
export function averageNormal(mesh: MeshData, faces: Iterable<number>): Vec3 {
  const sum: Vec3 = [0, 0, 0];
  for (const index of faces) {
    const face = mesh.faces[index];
    if (!face) continue;
    const normal = faceNormal(mesh, face);
    sum[0] += normal[0];
    sum[1] += normal[1];
    sum[2] += normal[2];
  }
  const length = Math.hypot(sum[0], sum[1], sum[2]);
  if (length < 1e-9) return [0, 1, 0];
  return [sum[0] / length, sum[1] / length, sum[2] / length];
}

/** Midpoint of an edge. */
export function edgeMidpoint(mesh: MeshData, a: number, b: number): Vec3 {
  const va = getVertex(mesh, a);
  const vb = getVertex(mesh, b);
  return [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2];
}
