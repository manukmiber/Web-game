import { cloneMeshData, deformVertices, meshBounds, type MeshData } from '../MeshData';
import { registerModifier, type Modifier } from './registry';
import { AXES, type Axis } from './mirror';
import type { Vec3 } from '../../scene/types';

const AXIS_INDEX: Record<Axis, number> = { X: 0, Y: 1, Z: 2 };
const DEG2RAD = Math.PI / 180;

/**
 * Normalised position along an axis across the mesh's own bounds, 0 at the low end and 1 at
 * the high end.
 *
 * Deformers are parameterised this way so their strength means the same thing regardless of
 * how large the object is — a 90° twist is a 90° twist on a 1 m box and on a 40 m tower.
 */
function axisFactor(mesh: MeshData, axis: Axis): (v: Vec3) => number {
  const bounds = meshBounds(mesh);
  const index = AXIS_INDEX[axis];
  if (!bounds) return () => 0;
  const min = bounds.min[index]!;
  const span = bounds.max[index]! - min;
  if (Math.abs(span) < 1e-9) return () => 0;
  return (v) => (v[index]! - min) / span;
}

// ------------------------------------------------------------------- Twist

export interface TwistModifier extends Modifier {
  type: 'Twist';
  axis: Axis;
  /** Total rotation from one end of the object to the other, in degrees. */
  angle: number;
}

export function twist(mesh: MeshData, axis: Axis, angle: number): MeshData {
  const out = cloneMeshData(mesh);
  const factor = axisFactor(out, axis);
  const total = angle * DEG2RAD;
  const index = AXIS_INDEX[axis];
  // The two axes perpendicular to the twist axis are the ones that rotate.
  const [u, w] = index === 0 ? [1, 2] : index === 1 ? [0, 2] : [0, 1];

  deformVertices(out, (v) => {
    const theta = total * factor(v);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const next: Vec3 = [...v];
    next[u] = v[u]! * cos - v[w]! * sin;
    next[w] = v[u]! * sin + v[w]! * cos;
    return next;
  });
  return out;
}

export function createTwistModifier(overrides: Partial<TwistModifier> = {}): TwistModifier {
  return { type: 'Twist', enabled: true, axis: 'Y', angle: 90, ...overrides };
}

registerModifier<TwistModifier>({
  type: 'Twist',
  label: 'Twist',
  create: createTwistModifier,
  fields: () => [
    { kind: 'enum', key: 'axis', label: 'Axis', options: AXES },
    { kind: 'number', key: 'angle', label: 'Angle', step: 5 },
  ],
  apply: (mesh, modifier) => twist(mesh, modifier.axis, modifier.angle),
});

// -------------------------------------------------------------------- Bend

export interface BendModifier extends Modifier {
  type: 'Bend';
  axis: Axis;
  angle: number;
}

/**
 * Bends the mesh into an arc of `angle` degrees along `axis`.
 *
 * Implemented as a wrap onto a circle whose radius is derived from the object's length, so
 * 180° folds it into a half-ring regardless of size. A near-zero angle short-circuits: the
 * radius goes to infinity and the arithmetic would produce NaN positions.
 */
export function bend(mesh: MeshData, axis: Axis, angle: number): MeshData {
  const out = cloneMeshData(mesh);
  const radians = angle * DEG2RAD;
  if (Math.abs(radians) < 1e-6) return out;

  const bounds = meshBounds(out);
  if (!bounds) return out;

  const index = AXIS_INDEX[axis];
  const min = bounds.min[index]!;
  const span = bounds.max[index]! - min;
  if (Math.abs(span) < 1e-9) return out;

  // Bend within the plane of the axis and the next one round.
  const bendInto = (index + 1) % 3;
  const radius = span / radians;

  deformVertices(out, (v) => {
    const t = (v[index]! - min) / span - 0.5;
    const theta = t * radians;
    const offset = v[bendInto]!;
    const next: Vec3 = [...v];
    next[index] = Math.sin(theta) * (radius - offset);
    next[bendInto] = radius - Math.cos(theta) * (radius - offset);
    return next;
  });
  return out;
}

export function createBendModifier(overrides: Partial<BendModifier> = {}): BendModifier {
  return { type: 'Bend', enabled: true, axis: 'Y', angle: 45, ...overrides };
}

registerModifier<BendModifier>({
  type: 'Bend',
  label: 'Bend',
  create: createBendModifier,
  fields: () => [
    { kind: 'enum', key: 'axis', label: 'Axis', options: AXES },
    { kind: 'number', key: 'angle', label: 'Angle', step: 5 },
  ],
  apply: (mesh, modifier) => bend(mesh, modifier.axis, modifier.angle),
});

// ------------------------------------------------------------------- Taper

export interface TaperModifier extends Modifier {
  type: 'Taper';
  axis: Axis;
  /** Scale at the high end of the axis. 0 collapses it to a point, 2 doubles it. */
  amount: number;
}

export function taper(mesh: MeshData, axis: Axis, amount: number): MeshData {
  const out = cloneMeshData(mesh);
  const factor = axisFactor(out, axis);
  const index = AXIS_INDEX[axis];
  const [u, w] = index === 0 ? [1, 2] : index === 1 ? [0, 2] : [0, 1];

  deformVertices(out, (v) => {
    const scale = 1 + (amount - 1) * factor(v);
    const next: Vec3 = [...v];
    next[u] = v[u]! * scale;
    next[w] = v[w]! * scale;
    return next;
  });
  return out;
}

export function createTaperModifier(overrides: Partial<TaperModifier> = {}): TaperModifier {
  return { type: 'Taper', enabled: true, axis: 'Y', amount: 0.5, ...overrides };
}

registerModifier<TaperModifier>({
  type: 'Taper',
  label: 'Taper',
  create: createTaperModifier,
  fields: () => [
    { kind: 'enum', key: 'axis', label: 'Axis', options: AXES },
    { kind: 'number', key: 'amount', label: 'Amount', min: 0, step: 0.05 },
  ],
  apply: (mesh, modifier) => taper(mesh, modifier.axis, modifier.amount),
});

// ------------------------------------------------------------------- Noise

export interface NoiseModifier extends Modifier {
  type: 'Noise';
  strength: number;
  scale: number;
  seed: number;
}

/**
 * Deterministic value noise, hashed from the vertex position.
 *
 * Position-hashed rather than index-hashed so that welded or subdivided vertices in the same
 * place get the same displacement — an index-based hash would tear a seam apart.
 */
function hashNoise(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(Math.round(x * 8192) ^ seed, 0x27d4eb2d);
  h = Math.imul(h ^ Math.round(y * 8192), 0x85ebca6b);
  h = Math.imul(h ^ Math.round(z * 8192), 0xc2b2ae35);
  h ^= h >>> 15;
  return ((h >>> 0) % 100000) / 50000 - 1;
}

export function noise(mesh: MeshData, strength: number, scale: number, seed: number): MeshData {
  const out = cloneMeshData(mesh);
  const frequency = Math.max(1e-4, scale);
  deformVertices(out, (v) => [
    v[0] + hashNoise(v[0] / frequency, v[1] / frequency, v[2] / frequency, seed) * strength,
    v[1] + hashNoise(v[0] / frequency, v[1] / frequency, v[2] / frequency, seed + 1) * strength,
    v[2] + hashNoise(v[0] / frequency, v[1] / frequency, v[2] / frequency, seed + 2) * strength,
  ]);
  return out;
}

export function createNoiseModifier(overrides: Partial<NoiseModifier> = {}): NoiseModifier {
  return { type: 'Noise', enabled: true, strength: 0.05, scale: 0.5, seed: 1, ...overrides };
}

registerModifier<NoiseModifier>({
  type: 'Noise',
  label: 'Noise Displace',
  create: createNoiseModifier,
  fields: () => [
    { kind: 'number', key: 'strength', label: 'Strength', min: 0, step: 0.01 },
    { kind: 'number', key: 'scale', label: 'Scale', min: 0.01, step: 0.05 },
    { kind: 'number', key: 'seed', label: 'Seed', step: 1, integer: true },
  ],
  apply: (mesh, modifier) => noise(mesh, modifier.strength, modifier.scale, modifier.seed),
});
