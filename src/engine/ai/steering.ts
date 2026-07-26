import type { Vec3 } from '../scene/types';

/**
 * Movement and orientation maths for agents, as pure functions.
 *
 * Separated from the NpcSystem so the interesting parts — shortest-arc turning, wander
 * sampling, arrival — are testable without a Scene, an Engine or a frame loop. The system
 * itself then reduces to a state machine that calls these.
 *
 * **Facing convention: -Z is forward**, matching Three.js cameras. Everything that points
 * somewhere in this engine agrees on it — cameras, directional lights, characters — so a
 * camera parented behind a character needs no rotation of its own to look where the character
 * is looking.
 */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/** Folds an angle in degrees into (-180, 180]. */
export function wrapAngle(degrees: number): number {
  let angle = degrees % 360;
  if (angle > 180) angle -= 360;
  if (angle <= -180) angle += 360;
  return angle;
}

/** Signed shortest rotation from `from` to `to`, in degrees. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Unit forward vector for a yaw in degrees, in the XZ plane. */
export function forwardFromYaw(yawDegrees: number): [number, number] {
  const yaw = yawDegrees * DEG2RAD;
  return [-Math.sin(yaw), -Math.cos(yaw)];
}

/** Yaw in degrees that makes `forwardFromYaw` point along (dx, dz). Zero for a zero vector. */
export function yawTowards(dx: number, dz: number): number {
  if (dx === 0 && dz === 0) return 0;
  return Math.atan2(-dx, -dz) * RAD2DEG;
}

/** Turns `current` toward `target` by at most `maxDelta` degrees, the short way round. */
export function stepAngle(current: number, target: number, maxDelta: number): number {
  const delta = angleDelta(current, target);
  if (Math.abs(delta) <= maxDelta) return wrapAngle(target);
  return wrapAngle(current + Math.sign(delta) * maxDelta);
}

/** Ground-plane distance. Height is ignored everywhere in the AI — there is no navmesh yet. */
export function distanceXZ(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

export interface StepResult {
  x: number;
  z: number;
  /** True when the destination was reached this step. */
  arrived: boolean;
}

/**
 * Moves toward a point at constant speed, stopping exactly on it rather than overshooting.
 *
 * Overshoot is what makes a naive `position += direction * speed * dt` agent vibrate around
 * its destination once it gets close, and at low frame rates the vibration is metres wide.
 */
export function stepTowards(
  x: number,
  z: number,
  targetX: number,
  targetZ: number,
  speed: number,
  dt: number,
  arriveRadius = 0,
): StepResult {
  const dx = targetX - x;
  const dz = targetZ - z;
  const distance = Math.hypot(dx, dz);
  if (distance <= Math.max(arriveRadius, 1e-6)) return { x, z, arrived: true };

  const travel = speed * dt;
  if (travel >= distance - arriveRadius) {
    const remaining = distance - arriveRadius;
    return { x: x + (dx / distance) * remaining, z: z + (dz / distance) * remaining, arrived: true };
  }
  return { x: x + (dx / distance) * travel, z: z + (dz / distance) * travel, arrived: false };
}

/** Moves directly away from a point. Used by fleeing agents. */
export function stepAway(
  x: number,
  z: number,
  fromX: number,
  fromZ: number,
  speed: number,
  dt: number,
): StepResult {
  const dx = x - fromX;
  const dz = z - fromZ;
  const distance = Math.hypot(dx, dz);
  // Standing exactly on the threat: pick a fixed direction rather than dividing by zero.
  if (distance < 1e-6) return { x: x + speed * dt, z, arrived: false };
  return { x: x + (dx / distance) * speed * dt, z: z + (dz / distance) * speed * dt, arrived: false };
}

/**
 * Deterministic PRNG, seeded per agent from its entity id.
 *
 * Determinism is not decoration here: a wandering crowd is the hardest thing in the engine to
 * write a test for, and an unseeded `Math.random` would make "does this agent stay inside its
 * wander radius" a flaky test rather than an exact one.
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

/** FNV-1a over a string, so an entity id maps to a stable seed. */
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
