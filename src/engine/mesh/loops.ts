import type { MeshData } from './MeshData';

/**
 * The border of an open mesh, as ordered vertex loops.
 *
 * An edge is on the border when the faces using it never traverse it in both directions: a
 * quad's edge `a → b` is interior only if its neighbour walks `b → a`. Collecting the unmatched
 * directed edges and chaining them gives loops that are already oriented the way the faces run,
 * which is what lets a swept wall inherit the profile's winding instead of guessing at it.
 *
 * A closed solid has no border and returns nothing — that is the signal Extrude and Lathe use to
 * decide they have nothing to sweep.
 */
export function boundaryLoops(mesh: MeshData): number[][] {
  const directed = new Set<string>();
  for (const face of mesh.faces) {
    for (let i = 0; i < face.length; i += 1) {
      directed.add(`${face[i]}>${face[(i + 1) % face.length]}`);
    }
  }

  // Outgoing border edges per vertex. A list rather than a single value because a pinched
  // ("bowtie") vertex legitimately has two, and dropping one would leave a loop unclosed.
  const outgoing = new Map<number, number[]>();
  for (const face of mesh.faces) {
    for (let i = 0; i < face.length; i += 1) {
      const a = face[i]!;
      const b = face[(i + 1) % face.length]!;
      if (directed.has(`${b}>${a}`)) continue;
      const list = outgoing.get(a);
      if (list) list.push(b);
      else outgoing.set(a, [b]);
    }
  }

  let remaining = 0;
  for (const list of outgoing.values()) remaining += list.length;

  const take = (from: number): number | undefined => {
    const list = outgoing.get(from);
    if (!list || list.length === 0) return undefined;
    const next = list.pop()!;
    if (list.length === 0) outgoing.delete(from);
    remaining -= 1;
    return next;
  };

  const loops: number[][] = [];
  for (const seed of [...outgoing.keys()]) {
    // A bowtie vertex starts more than one loop, so keep going until it has no edges left.
    while (outgoing.has(seed)) {
      const loop: number[] = [seed];
      let current = take(seed)!;
      // Every step consumes an edge, so the walk is bounded by the border's size even if the
      // mesh is malformed enough that the chain never returns to where it started.
      let budget = remaining + 1;
      while (current !== seed && budget > 0) {
        loop.push(current);
        const next = take(current);
        if (next === undefined) break; // Dangling chain: not a loop, so drop it.
        current = next;
        budget -= 1;
      }
      if (current === seed && loop.length >= 3) loops.push(loop);
    }
  }

  return loops;
}
