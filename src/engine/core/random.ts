/**
 * Seeded pseudo-randomness, in one place.
 *
 * Determinism is a requirement rather than a nicety in three separate corners of the engine,
 * and each had grown its own generator: agents wander (a crowd has to be testable, not merely
 * random), the stress harness places objects (a measurement you cannot repeat is an anecdote),
 * and the scatter brush paints instances (re-opening a scene must produce the forest that was
 * saved, and a seed is far smaller on disk than a million transforms).
 *
 * Two algorithms, because they are wanted for different reasons and neither is a drop-in
 * replacement for the other's recorded numbers.
 */

/**
 * Mulberry32 — small state, good distribution, fast. What agents and the scatter brush use.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Xorshift32 — what the performance harness has always used. Kept as its own function rather
 * than folded into the one above, because the recorded stress-scene layouts are only comparable
 * across runs if the numbers do not move.
 */
export function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

/** FNV-1a over a string, so an entity id or a layer name maps to a stable seed. */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Uniformly sampled point inside a disc — sqrt keeps it uniform by area, not by radius. */
export function randomPointInDisc(
  rng: () => number,
  centreX: number,
  centreZ: number,
  radius: number,
): [number, number] {
  const angle = rng() * Math.PI * 2;
  const distance = Math.sqrt(rng()) * radius;
  return [centreX + Math.cos(angle) * distance, centreZ + Math.sin(angle) * distance];
}
