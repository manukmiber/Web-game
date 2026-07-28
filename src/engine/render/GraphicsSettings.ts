import * as THREE from 'three';

/**
 * Renderer-wide quality settings, owned by the engine rather than the editor.
 *
 * These live here for the same reason `RenderHost` does (ARCHITECTURE.md §2): the editor and
 * the game runtime must be able to produce the *same image*, and they can only do that if the
 * knobs that change the image are described in one place that both can read. The editor's
 * Graphics panel is a view onto this type; a shipped game will read the same shape out of a
 * config file or a player-facing options menu.
 *
 * Nothing in this file touches the DOM or `window`, so it stays usable from a worker.
 */

/**
 * Antialiasing mode.
 *
 * MSAA is expressed as a sample count rather than a boolean because it is resolved through an
 * offscreen multisampled buffer, not through the WebGL context's `antialias` flag. That is the
 * whole reason this is changeable at runtime: the context flag is fixed the moment the context
 * is created, so a settings menu built on it could only ever say "restart to apply".
 *
 * FXAA is a post-process, so it costs one fullscreen pass and no extra memory bandwidth per
 * sample — on a phone that trade is usually worth taking over even 2× MSAA.
 */
export const ANTIALIAS_MODES = ['off', 'fxaa', 'msaa2', 'msaa4', 'msaa8'] as const;
export type AntialiasMode = (typeof ANTIALIAS_MODES)[number];

export const ANTIALIAS_LABELS: Record<AntialiasMode, string> = {
  off: 'Off',
  fxaa: 'FXAA — cheap, slightly soft',
  msaa2: 'MSAA 2×',
  msaa4: 'MSAA 4×',
  msaa8: 'MSAA 8×',
};

/** Shadow map resolution tier. `off` disables the shadow pass outright. */
export const SHADOW_QUALITIES = ['off', 'low', 'medium', 'high', 'ultra'] as const;
export type ShadowQuality = (typeof SHADOW_QUALITIES)[number];

const SHADOW_MAP_SIZES: Record<ShadowQuality, number> = {
  off: 0,
  low: 512,
  medium: 1024,
  high: 2048,
  ultra: 4096,
};

/**
 * Shadow edge filtering.
 *
 * `hard` is a single tap — aliased, but the cheapest thing that still reads as a shadow. `pcf`
 * filters a small neighbourhood and is the sensible default. `soft` is variance shadow mapping,
 * which blurs the depth statistics rather than the comparison and so gives a genuinely wide
 * penumbra for a fixed cost.
 *
 * Notably *not* here: `PCFSoftShadowMap`. Three deprecated it, and `WebGLShadowMap` now warns
 * and rewrites the type to plain PCF on the first shadow render — so offering it as a separate
 * choice would be a menu entry that quietly does the same thing as the one above it, plus a
 * console warning. It was also what this renderer had been asking for.
 */
export const SHADOW_FILTERS = ['hard', 'pcf', 'soft'] as const;
export type ShadowFilter = (typeof SHADOW_FILTERS)[number];

export const SHADOW_FILTER_LABELS: Record<ShadowFilter, string> = {
  hard: 'Hard — one tap, aliased',
  pcf: 'PCF — filtered edges',
  soft: 'Soft (VSM) — wide penumbra',
};

/**
 * Tone mapping curve applied to the final image.
 *
 * Without one, anything brighter than white clips channel by channel, so a strong light turns
 * a coloured surface into a magenta or cyan blowout rather than into white. Every mode here is
 * Three's own implementation — the post-process path includes Three's shader chunk verbatim
 * rather than reimplementing the curves, so the two render paths cannot drift apart.
 */
export const TONE_MAPPINGS = ['none', 'linear', 'reinhard', 'cineon', 'neutral', 'aces'] as const;
export type ToneMappingMode = (typeof TONE_MAPPINGS)[number];

export const TONE_MAPPING_LABELS: Record<ToneMappingMode, string> = {
  none: 'None — clips at white',
  linear: 'Linear',
  reinhard: 'Reinhard',
  cineon: 'Cineon',
  neutral: 'Neutral (Khronos PBR)',
  aces: 'ACES Filmic',
};

/** Name of the GLSL function in Three's `tonemapping_pars_fragment` chunk, if any. */
export const TONE_MAPPING_FUNCTIONS: Record<ToneMappingMode, string | null> = {
  none: null,
  linear: 'LinearToneMapping',
  reinhard: 'ReinhardToneMapping',
  cineon: 'CineonToneMapping',
  neutral: 'NeutralToneMapping',
  aces: 'ACESFilmicToneMapping',
};

export interface GraphicsSettings {
  antialias: AntialiasMode;
  shadowQuality: ShadowQuality;
  shadowFilter: ShadowFilter;
  /**
   * Half-extent, in metres, of the placeholder sun's shadow frustum.
   *
   * Only the built-in rig reads this; a scene's own `Light` components carry their own
   * `shadowRange`, because in a scene with several shadow casters "how far do shadows reach"
   * is a property of each light, not of the renderer.
   */
  shadowDistance: number;
  toneMapping: ToneMappingMode;
  exposure: number;
  /** Fraction of the display resolution to render at, then upscale. */
  resolutionScale: number;
  /** Upper bound on `devicePixelRatio`. Applied by whoever owns the canvas. */
  pixelRatioCap: number;
  /** Anisotropic filtering samples for colour textures, clamped to what the GPU supports. */
  anisotropy: number;
}

/**
 * Defaults chosen to look right on a desktop and still be honest about cost.
 *
 * Tone mapping defaults to Khronos Neutral rather than ACES on purpose: it leaves in-gamut
 * colours very close to where the author picked them and only compresses the highlights, so
 * turning it on does not silently restyle scenes built before it existed. ACES is one click
 * away for anyone who wants the filmic look.
 */
export const DEFAULT_GRAPHICS: GraphicsSettings = {
  antialias: 'msaa4',
  shadowQuality: 'high',
  shadowFilter: 'pcf',
  shadowDistance: 30,
  toneMapping: 'neutral',
  exposure: 1,
  resolutionScale: 1,
  pixelRatioCap: 2,
  anisotropy: 4,
};

export function shadowMapSizeFor(quality: ShadowQuality): number {
  return SHADOW_MAP_SIZES[quality] ?? SHADOW_MAP_SIZES.high;
}

export function shadowMapTypeFor(filter: ShadowFilter): THREE.ShadowMapType {
  switch (filter) {
    case 'hard':
      return THREE.BasicShadowMap;
    case 'soft':
      return THREE.VSMShadowMap;
    case 'pcf':
    default:
      return THREE.PCFShadowMap;
  }
}

/** Blur radius the soft filter wants. Ignored by the others, which have no radius to set. */
export const VSM_SHADOW_RADIUS = 3;
export const VSM_SHADOW_BLUR_SAMPLES = 8;

export function toneMappingFor(mode: ToneMappingMode): THREE.ToneMapping {
  switch (mode) {
    case 'linear':
      return THREE.LinearToneMapping;
    case 'reinhard':
      return THREE.ReinhardToneMapping;
    case 'cineon':
      return THREE.CineonToneMapping;
    case 'neutral':
      return THREE.NeutralToneMapping;
    case 'aces':
      return THREE.ACESFilmicToneMapping;
    case 'none':
    default:
      return THREE.NoToneMapping;
  }
}

/** MSAA sample count for a mode. Zero for `off` and for FXAA, which is not multisampled. */
export function samplesFor(mode: AntialiasMode): number {
  switch (mode) {
    case 'msaa2':
      return 2;
    case 'msaa4':
      return 4;
    case 'msaa8':
      return 8;
    default:
      return 0;
  }
}

export function usesFxaa(mode: AntialiasMode): boolean {
  return mode === 'fxaa';
}

/** True when the mode needs the offscreen post-process buffer rather than a direct draw. */
export function needsPostProcessing(mode: AntialiasMode): boolean {
  return samplesFor(mode) > 0 || usesFxaa(mode);
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/**
 * Coerces anything — a parsed localStorage blob, a config file, a partial patch — into a valid
 * settings object.
 *
 * Every consumer runs its input through here rather than trusting it, because these values go
 * straight into GPU resource allocation: a resolution scale of zero is a zero-sized render
 * target and a lost context, not a slightly odd-looking frame.
 */
export function normalizeGraphics(raw: Partial<GraphicsSettings> | null | undefined): GraphicsSettings {
  const input = raw ?? {};
  return {
    antialias: pick(input.antialias, ANTIALIAS_MODES, DEFAULT_GRAPHICS.antialias),
    shadowQuality: pick(input.shadowQuality, SHADOW_QUALITIES, DEFAULT_GRAPHICS.shadowQuality),
    shadowFilter: pick(input.shadowFilter, SHADOW_FILTERS, DEFAULT_GRAPHICS.shadowFilter),
    shadowDistance: clampNumber(input.shadowDistance, 5, 500, DEFAULT_GRAPHICS.shadowDistance),
    toneMapping: pick(input.toneMapping, TONE_MAPPINGS, DEFAULT_GRAPHICS.toneMapping),
    exposure: clampNumber(input.exposure, 0.1, 4, DEFAULT_GRAPHICS.exposure),
    resolutionScale: clampNumber(input.resolutionScale, 0.25, 1, DEFAULT_GRAPHICS.resolutionScale),
    pixelRatioCap: clampNumber(input.pixelRatioCap, 1, 3, DEFAULT_GRAPHICS.pixelRatioCap),
    // Rounded to a power of two: GPUs only implement those, and reporting back the number the
    // user asked for when the driver silently used another is how a settings panel starts lying.
    anisotropy: 2 ** Math.round(Math.log2(clampNumber(input.anisotropy, 1, 16, DEFAULT_GRAPHICS.anisotropy))),
  };
}

/** True when two settings objects describe the same image. */
export function sameGraphics(a: GraphicsSettings, b: GraphicsSettings): boolean {
  return (
    a.antialias === b.antialias &&
    a.shadowQuality === b.shadowQuality &&
    a.shadowFilter === b.shadowFilter &&
    a.shadowDistance === b.shadowDistance &&
    a.toneMapping === b.toneMapping &&
    a.exposure === b.exposure &&
    a.resolutionScale === b.resolutionScale &&
    a.pixelRatioCap === b.pixelRatioCap &&
    a.anisotropy === b.anisotropy
  );
}
