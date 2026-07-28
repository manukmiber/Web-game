import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  ANTIALIAS_MODES,
  DEFAULT_GRAPHICS,
  SHADOW_FILTERS,
  SHADOW_QUALITIES,
  TONE_MAPPINGS,
  TONE_MAPPING_FUNCTIONS,
  needsPostProcessing,
  normalizeGraphics,
  sameGraphics,
  samplesFor,
  shadowMapSizeFor,
  shadowMapTypeFor,
  toneMappingFor,
  usesFxaa,
  type GraphicsSettings,
} from './GraphicsSettings';

/**
 * These cover the part of the graphics settings that can be tested without a GL context: the
 * translation from the settings vocabulary to Three's, and the normalization every entry point
 * runs its input through.
 *
 * That normalization is the load-bearing piece. The values here are read out of localStorage —
 * hand-editable, and carried across versions that may have used different names — and they go
 * straight into render-target allocation. A resolution scale of zero is not a slightly wrong
 * frame, it is a zero-sized framebuffer.
 */
describe('graphics settings', () => {
  it('maps every antialias mode to a sample count or to FXAA, never to both', () => {
    for (const mode of ANTIALIAS_MODES) {
      const samples = samplesFor(mode);
      expect(samples).toBeGreaterThanOrEqual(0);
      // FXAA is a post-process; multisampling the buffer it reads would be paying twice.
      expect(usesFxaa(mode) && samples > 0).toBe(false);
      expect(needsPostProcessing(mode)).toBe(samples > 0 || usesFxaa(mode));
    }
    expect(needsPostProcessing('off')).toBe(false);
    expect(samplesFor('msaa8')).toBe(8);
  });

  it('gives every shadow quality a power-of-two map, and only "off" a zero one', () => {
    for (const quality of SHADOW_QUALITIES) {
      const size = shadowMapSizeFor(quality);
      if (quality === 'off') {
        expect(size).toBe(0);
        continue;
      }
      expect(size).toBeGreaterThan(0);
      expect(Math.log2(size) % 1).toBe(0);
    }
  });

  /**
   * Distinct is the whole assertion. Three deprecated `PCFSoftShadowMap` and rewrites it to
   * plain PCF on the first shadow render, so a filter list that still mapped to it would offer
   * two menu entries that do the same thing — and log a warning for the privilege.
   */
  it('maps shadow filters onto distinct, non-deprecated Three shadow map types', () => {
    const types = SHADOW_FILTERS.map(shadowMapTypeFor);
    expect(new Set(types).size).toBe(SHADOW_FILTERS.length);
    expect(types).not.toContain(THREE.PCFSoftShadowMap);
    expect(shadowMapTypeFor('soft')).toBe(THREE.VSMShadowMap);
  });

  /**
   * The post-process path applies tone mapping by calling a function out of Three's own shader
   * chunk, so the name in the table has to be a function that chunk actually defines — a typo
   * would be a shader compile error at runtime, on the machine of whoever picked that mode.
   */
  it('names tone mapping functions that exist in Three’s shader chunk', () => {
    const chunk = THREE.ShaderChunk.tonemapping_pars_fragment;
    for (const mode of TONE_MAPPINGS) {
      const fn = TONE_MAPPING_FUNCTIONS[mode];
      if (mode === 'none') {
        expect(fn).toBeNull();
        expect(toneMappingFor(mode)).toBe(THREE.NoToneMapping);
        continue;
      }
      expect(fn).toBeTruthy();
      expect(chunk).toContain(`vec3 ${fn}( vec3 color )`);
      expect(toneMappingFor(mode)).not.toBe(THREE.NoToneMapping);
    }
  });

  it('falls back to the defaults for missing, unknown and non-numeric values', () => {
    expect(normalizeGraphics(null)).toEqual(DEFAULT_GRAPHICS);
    expect(normalizeGraphics({})).toEqual(DEFAULT_GRAPHICS);

    const junk = normalizeGraphics({
      antialias: 'msaa64',
      shadowQuality: 'insane',
      toneMapping: 'filmic',
      exposure: Number.NaN,
      resolutionScale: undefined,
    } as unknown as Partial<GraphicsSettings>);
    expect(junk).toEqual(DEFAULT_GRAPHICS);
  });

  it('clamps numbers into the range the renderer can actually use', () => {
    const low = normalizeGraphics({ resolutionScale: 0, pixelRatioCap: 0, exposure: -5 });
    expect(low.resolutionScale).toBe(0.25);
    expect(low.pixelRatioCap).toBe(1);
    expect(low.exposure).toBe(0.1);

    const high = normalizeGraphics({ resolutionScale: 4, pixelRatioCap: 12, shadowDistance: 9000 });
    expect(high.resolutionScale).toBe(1);
    expect(high.pixelRatioCap).toBe(3);
    expect(high.shadowDistance).toBe(500);
  });

  /** GPUs only implement powers of two, so reporting back anything else would be a lie. */
  it('rounds anisotropy to a power of two', () => {
    expect(normalizeGraphics({ anisotropy: 3 }).anisotropy).toBe(4);
    expect(normalizeGraphics({ anisotropy: 5 }).anisotropy).toBe(4);
    expect(normalizeGraphics({ anisotropy: 12 }).anisotropy).toBe(16);
    expect(normalizeGraphics({ anisotropy: 100 }).anisotropy).toBe(16);
  });

  it('compares by value, so an unchanged apply can be skipped', () => {
    const a = normalizeGraphics({ antialias: 'fxaa' });
    const b = normalizeGraphics({ antialias: 'fxaa' });
    expect(a).not.toBe(b);
    expect(sameGraphics(a, b)).toBe(true);
    expect(sameGraphics(a, { ...b, exposure: 1.5 })).toBe(false);
  });
});
