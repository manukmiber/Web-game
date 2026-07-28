import { describe, expect, it } from 'vitest';
import { createLight } from '../components/Light';
import {
  canCastShadow,
  kelvinToRgb,
  lightImportance,
  MAX_KELVIN,
  MIN_KELVIN,
  PUNCTUAL_INTENSITY_SCALE,
  resolveIntensity,
  selectShadowCasters,
  type ShadowCandidate,
} from './lighting';

describe('kelvinToRgb', () => {
  it('normalises so the brightest channel is always 1', () => {
    for (const kelvin of [1000, 2700, 4000, 6500, 9000, 12000]) {
      const [r, g, b] = kelvinToRgb(kelvin);
      // Otherwise the temperature slider would double as a brightness slider.
      expect(Math.max(r, g, b)).toBeCloseTo(1, 5);
    }
  });

  it('runs warm below daylight and cool above it', () => {
    const [warmR, , warmB] = kelvinToRgb(2200);
    const [coolR, , coolB] = kelvinToRgb(9000);

    expect(warmR).toBeGreaterThan(warmB);
    expect(coolB).toBeGreaterThan(coolR);
  });

  it('is near neutral at daylight', () => {
    const [r, g, b] = kelvinToRgb(6500);
    expect(r).toBeGreaterThan(0.85);
    expect(g).toBeGreaterThan(0.85);
    expect(b).toBeGreaterThan(0.85);
  });

  it('clamps rather than producing nonsense outside the range', () => {
    expect(kelvinToRgb(-500)).toEqual(kelvinToRgb(MIN_KELVIN));
    expect(kelvinToRgb(999999)).toEqual(kelvinToRgb(MAX_KELVIN));
    for (const channel of kelvinToRgb(0)) expect(Number.isFinite(channel)).toBe(true);
  });
});

describe('resolveIntensity', () => {
  it('passes a directional light straight through', () => {
    expect(resolveIntensity(createLight({ lightType: 'Directional', intensity: 2.2 }))).toBe(2.2);
  });

  it('scales artistic punctual intensity into Three\'s candela range', () => {
    const light = createLight({ lightType: 'Point', intensity: 2, unit: 'Artistic' });
    expect(resolveIntensity(light)).toBe(2 * PUNCTUAL_INTENSITY_SCALE);
  });

  it('converts point lumens to candela over the whole sphere', () => {
    const light = createLight({ lightType: 'Point', intensity: 1000, unit: 'Physical' });
    expect(resolveIntensity(light)).toBeCloseTo(1000 / (4 * Math.PI), 4);
  });

  it('makes the same bulb brighter in a narrower spot, which is how a torch works', () => {
    const wide = createLight({ lightType: 'Spot', intensity: 1000, unit: 'Physical', angle: 60 });
    const narrow = createLight({ lightType: 'Spot', intensity: 1000, unit: 'Physical', angle: 15 });
    expect(resolveIntensity(narrow)).toBeGreaterThan(resolveIntensity(wide) * 4);
  });

  it('never returns a negative intensity', () => {
    expect(resolveIntensity(createLight({ intensity: -5 }))).toBe(0);
  });
});

describe('canCastShadow', () => {
  it('is false for the two types Three cannot project from', () => {
    expect(canCastShadow('Directional')).toBe(true);
    expect(canCastShadow('Point')).toBe(true);
    expect(canCastShadow('Spot')).toBe(true);
    // A hemisphere light has no direction, and Three's RectAreaLight has no shadow at all —
    // offering the checkbox would be a control that silently does nothing.
    expect(canCastShadow('Hemisphere')).toBe(false);
    expect(canCastShadow('Area')).toBe(false);
  });
});

describe('lightImportance', () => {
  it('ranks a directional light above any lamp, wherever its gizmo sits', () => {
    const sun = createLight({ lightType: 'Directional', intensity: 2 });
    const lamp = createLight({ lightType: 'Point', intensity: 40 });
    expect(lightImportance(sun, [900, 900, 900], [0, 0, 0])).toBeGreaterThan(
      lightImportance(lamp, [0, 1, 0], [0, 0, 0]),
    );
  });

  it('prefers the nearer of two identical lamps', () => {
    const lamp = createLight({ lightType: 'Point', intensity: 5, range: 20 });
    expect(lightImportance(lamp, [0, 0, 2], [0, 0, 0])).toBeGreaterThan(
      lightImportance(lamp, [0, 0, 15], [0, 0, 0]),
    );
  });

  it('lets an explicit priority beat brightness and distance outright', () => {
    const dim = createLight({ lightType: 'Point', intensity: 0.1, shadowPriority: 5 });
    const bright = createLight({ lightType: 'Point', intensity: 100, shadowPriority: 0 });
    expect(lightImportance(dim, [0, 0, 40], [0, 0, 0])).toBeGreaterThan(
      lightImportance(bright, [0, 0, 1], [0, 0, 0]),
    );
  });

  it('discounts a lamp whose range ends before the camera begins', () => {
    const lamp = createLight({ lightType: 'Point', intensity: 5, range: 5 });
    const near = lightImportance(lamp, [0, 0, 1], [0, 0, 0]);
    const far = lightImportance(lamp, [0, 0, 100], [0, 0, 0]);
    expect(far).toBeLessThan(near);
    expect(far).toBe(0);
  });
});

describe('selectShadowCasters', () => {
  const candidate = (
    key: string,
    overrides: Parameters<typeof createLight>[0] = {},
    position: [number, number, number] = [0, 0, 0],
  ): ShadowCandidate<string> => ({ key, component: createLight(overrides), position });

  it('spends the budget on the most important lights', () => {
    const chosen = selectShadowCasters(
      [
        candidate('sun', { lightType: 'Directional' }),
        candidate('near', { lightType: 'Point', intensity: 3 }, [0, 0, 2]),
        candidate('far', { lightType: 'Point', intensity: 3 }, [0, 0, 18]),
      ],
      2,
      [0, 0, 0],
    );
    expect([...chosen].sort()).toEqual(['near', 'sun']);
  });

  it('skips lights that never asked, and types that cannot cast', () => {
    const chosen = selectShadowCasters(
      [
        candidate('off', { castShadow: false }),
        candidate('disabled', { enabled: false }),
        candidate('hemi', { lightType: 'Hemisphere' }),
        candidate('sun', { lightType: 'Directional' }),
      ],
      8,
      [0, 0, 0],
    );
    expect([...chosen]).toEqual(['sun']);
  });

  it('grants every eligible light when the budget is negative — the no-limit setting', () => {
    const chosen = selectShadowCasters(
      [candidate('a'), candidate('b'), candidate('c')],
      -1,
      [0, 0, 0],
    );
    expect(chosen.size).toBe(3);
  });

  it('grants none at zero', () => {
    expect(selectShadowCasters([candidate('a')], 0, [0, 0, 0]).size).toBe(0);
  });
});
