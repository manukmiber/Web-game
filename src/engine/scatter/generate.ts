/**
 * The scatter brush: settings in, packed instances out.
 *
 * A pure function of the brush settings and nothing else, which is the property that makes the
 * whole feature affordable. A layer stores a seed and a handful of numbers rather than a
 * million transforms, so a forest costs about 200 bytes in the scene file until someone edits
 * an individual tree — and re-opening the scene produces exactly the forest that was saved,
 * because the same seed walks the same sequence.
 *
 * It is deliberately not a *painter* yet. Stroke-based painting (drag across the terrain,
 * instances appear under the cursor) writes into the same buffers through the same codec; what
 * it needs beyond this is a terrain to project onto, which arrives with the heightfield work in
 * ARCHITECTURE.md §9.4. Area fill is the part that is useful without one.
 */

import { mulberry32 } from '../core/random';
import type { Vec3 } from '../scene/types';
import type { ScatterInstance } from './codec';

export const SCATTER_SHAPES = ['Rect', 'Disc'] as const;
export type ScatterShape = (typeof SCATTER_SHAPES)[number];

export interface ScatterBrush {
  seed: number;
  shape: ScatterShape;
  /** Half-width in metres for Rect; the radius for Disc. */
  extentX: number;
  /** Half-depth in metres for Rect. Ignored by Disc, which is round by definition. */
  extentZ: number;
  /** Instances per 100 m² — the unit the perf HUD's density slider already speaks. */
  density: number;
  /** Hard cap. A slider slip on density is otherwise an out-of-memory error. */
  maxInstances: number;
  minScale: number;
  maxScale: number;
  /** Random yaw per instance. Off for anything with a front, on for rocks and bushes. */
  randomYaw: boolean;
  /** Local Y for every instance. There is no terrain to project onto yet. */
  groundHeight: number;
}

export const DEFAULT_BRUSH: ScatterBrush = {
  seed: 1,
  shape: 'Rect',
  extentX: 20,
  extentZ: 20,
  density: 4,
  maxInstances: 20000,
  minScale: 0.8,
  maxScale: 1.25,
  randomYaw: true,
  groundHeight: 0,
};

/** Absolute ceiling, whatever a scene asks for. 65,535 is what a Uint16 variant index holds. */
export const SCATTER_HARD_CAP = 200000;

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Fills in anything missing or nonsensical.
 *
 * Brush settings arrive from a scene file, an Inspector field mid-keystroke, or a model's guess
 * at a tool argument, so "extentX is the empty string" is a normal Tuesday rather than a broken
 * caller. Every path lands on a brush that generates *something*.
 */
export function normalizeBrush(brush: Partial<ScatterBrush> | undefined): ScatterBrush {
  const source = brush ?? {};
  const minScale = Math.max(0.001, positive(source.minScale, DEFAULT_BRUSH.minScale));
  const maxScale = Math.max(minScale, positive(source.maxScale, DEFAULT_BRUSH.maxScale));
  return {
    // Seed 0 is a legitimate thing to type and a degenerate state for the generator, so it
    // folds to 1 rather than producing a layer that will not re-roll.
    seed: Math.floor(finite(source.seed, DEFAULT_BRUSH.seed)) >>> 0 || 1,
    shape: SCATTER_SHAPES.includes(source.shape as ScatterShape)
      ? (source.shape as ScatterShape)
      : DEFAULT_BRUSH.shape,
    extentX: Math.max(0, finite(source.extentX, DEFAULT_BRUSH.extentX)),
    extentZ: Math.max(0, finite(source.extentZ, DEFAULT_BRUSH.extentZ)),
    density: Math.max(0, finite(source.density, DEFAULT_BRUSH.density)),
    maxInstances: Math.min(
      SCATTER_HARD_CAP,
      Math.max(0, Math.floor(finite(source.maxInstances, DEFAULT_BRUSH.maxInstances))),
    ),
    minScale,
    maxScale,
    randomYaw: source.randomYaw ?? DEFAULT_BRUSH.randomYaw,
    groundHeight: finite(source.groundHeight, DEFAULT_BRUSH.groundHeight),
  };
}

/** Painted area in m². A Rect is 2·extentX by 2·extentZ; a Disc has radius extentX. */
export function scatterArea(brush: ScatterBrush): number {
  if (brush.shape === 'Disc') return Math.PI * brush.extentX * brush.extentX;
  return 4 * brush.extentX * brush.extentZ;
}

/**
 * How many instances the area and density ask for, before the cap.
 *
 * Reported separately so a caller can say "capped at 20,000" rather than silently handing back
 * a smaller forest than was asked for — which, at the scale this feature is for, is the
 * difference between a cap and a bug.
 */
export function scatterDemand(brush: ScatterBrush): number {
  return Math.max(0, Math.round((scatterArea(brush) / 100) * brush.density));
}

/** How many instances the brush will place, after the cap. */
export function scatterCount(brush: ScatterBrush): number {
  return Math.min(brush.maxInstances, scatterDemand(brush));
}

/**
 * Picks a prototype for each instance from the relative weights.
 *
 * Cumulative rather than rejection-sampled so the cost is one random number per instance
 * whatever the weights look like — at a million instances the difference is a frame, not a
 * rounding error. All-zero or missing weights fall back to uniform, because a layer whose
 * weights were never set should still scatter.
 */
function weightedPicker(weights: readonly number[], rng: () => number): () => number {
  const cleaned = weights.map((weight) =>
    typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? weight : 0,
  );
  const total = cleaned.reduce((sum, weight) => sum + weight, 0);
  if (cleaned.length === 0) return () => 0;
  if (total <= 0) return () => Math.min(cleaned.length - 1, Math.floor(rng() * cleaned.length));

  const cumulative: number[] = [];
  let running = 0;
  for (const weight of cleaned) {
    running += weight;
    cumulative.push(running / total);
  }
  return () => {
    const roll = rng();
    for (const [index, threshold] of cumulative.entries()) if (roll < threshold) return index;
    return cumulative.length - 1;
  };
}

/** Yaw as a quaternion. Only Y, because scatter stands things up rather than tumbling them. */
function yawQuaternion(radians: number): [number, number, number, number] {
  const half = radians / 2;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

/**
 * Places instances. Deterministic: the same brush and the same weights always produce the same
 * layer, on any machine, in any order of calls.
 */
export function generateScatter(
  brush: Partial<ScatterBrush> | undefined,
  weights: readonly number[],
): ScatterInstance[] {
  const settings = normalizeBrush(brush);
  const count = scatterCount(settings);
  if (count === 0 || weights.length === 0) return [];

  const rng = mulberry32(settings.seed);
  const pick = weightedPicker(weights, rng);
  const out: ScatterInstance[] = [];

  for (let index = 0; index < count; index += 1) {
    let x: number;
    let z: number;
    if (settings.shape === 'Disc') {
      const angle = rng() * Math.PI * 2;
      // sqrt keeps the fill uniform by area; without it everything crowds the centre.
      const distance = Math.sqrt(rng()) * settings.extentX;
      x = Math.cos(angle) * distance;
      z = Math.sin(angle) * distance;
    } else {
      x = (rng() * 2 - 1) * settings.extentX;
      z = (rng() * 2 - 1) * settings.extentZ;
    }

    // Drawn whether or not it is used, so every instance consumes the same number of values
    // from the sequence. Toggling `randomYaw` then changes only the rotations — the positions
    // and scales stay exactly where they were, which is what "toggle and compare" needs.
    const yaw = rng() * Math.PI * 2;
    const scaleRoll = rng();

    const position: Vec3 = [x, settings.groundHeight, z];
    out.push({
      position,
      rotation: settings.randomYaw ? yawQuaternion(yaw) : [0, 0, 0, 1],
      scale: settings.minScale + (settings.maxScale - settings.minScale) * scaleRoll,
      prototype: pick(),
    });
  }

  return out;
}
