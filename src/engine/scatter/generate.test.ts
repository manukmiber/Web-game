import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BRUSH,
  SCATTER_HARD_CAP,
  generateScatter,
  normalizeBrush,
  scatterArea,
  scatterCount,
  type ScatterBrush,
} from './generate';

function brush(overrides: Partial<ScatterBrush> = {}): ScatterBrush {
  return normalizeBrush({ ...DEFAULT_BRUSH, ...overrides });
}

describe('brush normalisation', () => {
  it('fills in an entirely absent brush', () => {
    expect(normalizeBrush(undefined)).toEqual(DEFAULT_BRUSH);
    expect(normalizeBrush({})).toEqual(DEFAULT_BRUSH);
  });

  it('folds seed 0 to 1, because 0 is a state the generator cannot re-roll out of', () => {
    expect(normalizeBrush({ seed: 0 }).seed).toBe(1);
  });

  it('rejects a max scale below the min rather than producing an inverted range', () => {
    const settings = normalizeBrush({ minScale: 2, maxScale: 0.5 });
    expect(settings.minScale).toBe(2);
    expect(settings.maxScale).toBe(2);
  });

  it('repairs values a half-typed Inspector field produces', () => {
    const settings = normalizeBrush({
      extentX: Number.NaN,
      density: -3,
      shape: 'Blob' as never,
      maxInstances: Number.POSITIVE_INFINITY,
    });
    expect(settings.extentX).toBe(DEFAULT_BRUSH.extentX);
    expect(settings.density).toBe(0);
    expect(settings.shape).toBe('Rect');
    // Infinity is not a number anyone meant to type, so it reads as absent rather than as
    // "the largest layer allowed".
    expect(settings.maxInstances).toBe(DEFAULT_BRUSH.maxInstances);
  });

  it('clamps a real but absurd instance cap to the hard ceiling', () => {
    expect(normalizeBrush({ maxInstances: 5e9 }).maxInstances).toBe(SCATTER_HARD_CAP);
  });
});

describe('counts', () => {
  it('measures a rect as its full extent, not its half-extent', () => {
    expect(scatterArea(brush({ shape: 'Rect', extentX: 5, extentZ: 10 }))).toBe(200);
  });

  it('measures a disc from extentX as the radius', () => {
    expect(scatterArea(brush({ shape: 'Disc', extentX: 10 }))).toBeCloseTo(Math.PI * 100, 6);
  });

  it('reads density as instances per 100 m²', () => {
    // 40 x 40 m is 1,600 m² — sixteen hundredths — so density 4 places 64.
    expect(scatterCount(brush({ shape: 'Rect', extentX: 20, extentZ: 20, density: 4 }))).toBe(64);
  });

  it('caps the count so a mistyped density cannot allocate the world', () => {
    const settings = brush({ extentX: 5000, extentZ: 5000, density: 1000, maxInstances: 500 });
    expect(scatterCount(settings)).toBe(500);
  });

  it('places nothing for a zero-area brush', () => {
    expect(scatterCount(brush({ extentX: 0, extentZ: 0 }))).toBe(0);
    expect(generateScatter(brush({ extentX: 0, extentZ: 0 }), [1])).toEqual([]);
  });
});

describe('generation', () => {
  it('is deterministic — the same brush always produces the same layer', () => {
    const settings = brush({ seed: 42 });
    expect(generateScatter(settings, [1, 1])).toEqual(generateScatter(settings, [1, 1]));
  });

  it('produces a different layer for a different seed', () => {
    const a = generateScatter(brush({ seed: 1 }), [1]);
    const b = generateScatter(brush({ seed: 2 }), [1]);
    expect(a).not.toEqual(b);
    expect(a).toHaveLength(b.length);
  });

  it('places nothing when the layer has no prototypes', () => {
    expect(generateScatter(brush(), [])).toEqual([]);
  });

  it('keeps every instance inside a rect brush', () => {
    const settings = brush({ shape: 'Rect', extentX: 12, extentZ: 4, seed: 7 });
    const instances = generateScatter(settings, [1]);
    expect(instances.length).toBeGreaterThan(0);
    for (const { position } of instances) {
      expect(Math.abs(position[0])).toBeLessThanOrEqual(12);
      expect(Math.abs(position[2])).toBeLessThanOrEqual(4);
      expect(position[1]).toBe(0);
    }
  });

  it('keeps every instance inside a disc brush', () => {
    const settings = brush({ shape: 'Disc', extentX: 9, density: 20, seed: 3 });
    for (const { position } of generateScatter(settings, [1])) {
      expect(Math.hypot(position[0], position[2])).toBeLessThanOrEqual(9 + 1e-6);
    }
  });

  it('puts every instance on the brush ground height', () => {
    for (const { position } of generateScatter(brush({ groundHeight: 2.5 }), [1])) {
      expect(position[1]).toBe(2.5);
    }
  });

  it('keeps scales inside the authored range', () => {
    const settings = brush({ minScale: 0.4, maxScale: 0.9, density: 30 });
    for (const { scale } of generateScatter(settings, [1])) {
      expect(scale).toBeGreaterThanOrEqual(0.4);
      expect(scale).toBeLessThanOrEqual(0.9);
    }
  });

  it('leaves rotation identity when random yaw is off, and only rotates about Y when it is on', () => {
    expect(generateScatter(brush({ randomYaw: false }), [1]).every(
      (i) => i.rotation[0] === 0 && i.rotation[1] === 0 && i.rotation[2] === 0 && i.rotation[3] === 1,
    )).toBe(true);

    for (const { rotation } of generateScatter(brush({ randomYaw: true }), [1])) {
      expect(rotation[0]).toBe(0);
      expect(rotation[2]).toBe(0);
      expect(Math.hypot(rotation[1], rotation[3])).toBeCloseTo(1, 6);
    }
  });

  /** Toggling yaw must not move anything: it is the difference you want to be able to see. */
  it('draws the same sequence whether or not yaw is used', () => {
    const on = generateScatter(brush({ randomYaw: true, seed: 11 }), [1]);
    const off = generateScatter(brush({ randomYaw: false, seed: 11 }), [1]);
    expect(on.map((i) => i.position)).toEqual(off.map((i) => i.position));
    expect(on.map((i) => i.scale)).toEqual(off.map((i) => i.scale));
  });

  it('respects prototype weights', () => {
    const instances = generateScatter(brush({ density: 200, seed: 5 }), [9, 1]);
    const rare = instances.filter((i) => i.prototype === 1).length;
    const share = rare / instances.length;
    expect(share).toBeGreaterThan(0.02);
    expect(share).toBeLessThan(0.2);
  });

  it('never emits a prototype index past the end of the weight list', () => {
    const instances = generateScatter(brush({ density: 50 }), [1, 2, 3]);
    for (const { prototype } of instances) {
      expect(prototype).toBeGreaterThanOrEqual(0);
      expect(prototype).toBeLessThan(3);
    }
  });

  it('falls back to uniform when every weight is zero, rather than placing nothing', () => {
    const instances = generateScatter(brush({ density: 50 }), [0, 0]);
    expect(instances.length).toBeGreaterThan(0);
    expect(new Set(instances.map((i) => i.prototype)).size).toBe(2);
  });
});
