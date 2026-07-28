/**
 * The maths behind the light model: colour temperature, physical intensity units, and the
 * shadow budget.
 *
 * Free of Three.js on purpose. These are decisions about what a light *is* — how bright 800
 * lumens actually is, which of thirty lights deserves one of the four shadow maps — and they
 * are the same decisions whether the frame is drawn by this renderer, a future WebGPU one, or
 * a headless lighting test. `RenderBridge` is where they meet Three's classes.
 */

import type { LightComponent, LightType } from '../components/Light';
import type { Vec3 } from '../scene/types';

/**
 * Multiplier from a directional light's authored intensity to Three's.
 *
 * Point and spot intensity is candela in Three's physical lighting model, where a value that
 * lights a room is in the tens — while a directional light's is a plain multiplier around 1.
 * Authoring one "intensity" field that means both would make switching a light's type change
 * its brightness by an order of magnitude, so the conversion happens on the way through.
 */
export const PUNCTUAL_INTENSITY_SCALE = 12;

/** Lowest and highest colour temperatures worth offering. Candle to a clear blue sky. */
export const MIN_KELVIN = 1000;
export const MAX_KELVIN = 12000;

/**
 * Correlated colour temperature to a linear RGB tint, normalised so the brightest channel is 1.
 *
 * Tanner Helland's piecewise fit to the blackbody curve. It is an approximation of an
 * approximation — CCT is itself a summary of a spectrum — and it is the one every real-time
 * renderer uses, because the error is well under what anyone can see next to a colour picker.
 *
 * Normalising matters more than the fit does. The raw curve makes 2700 K about a third as
 * bright as 6500 K, so dragging the temperature slider on a lamp would dim it as a side effect,
 * and the fix would be to chase the intensity slider in the opposite direction. Normalised, the
 * slider does exactly one thing: change the hue.
 */
export function kelvinToRgb(kelvin: number): [number, number, number] {
  const t = clamp(kelvin, MIN_KELVIN, MAX_KELVIN) / 100;

  const red = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);

  const green =
    t <= 66
      ? 99.4708025861 * Math.log(t) - 161.1195681661
      : 288.1221695283 * Math.pow(t - 60, -0.0755148492);

  const blue =
    t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;

  const r = clamp(red, 0, 255);
  const g = clamp(green, 0, 255);
  const b = clamp(blue, 0, 255);
  const peak = Math.max(r, g, b, 1);
  return [r / peak, g / peak, b / peak];
}

/**
 * How an authored intensity is to be read.
 *
 * `Artistic` is a unitless dial — the way this engine has always worked, and the way most
 * people light a stylised scene. `Physical` is lumens for point and spot lights, and nits
 * (candela per square metre) for area lights, which is what the number printed on the side of a
 * real bulb says. Both are offered because both are right for different jobs: matching a
 * photographic reference wants the physical one, and art-directing a dungeon does not.
 */
export const LIGHT_UNITS = ['Artistic', 'Physical'] as const;
export type LightUnit = (typeof LIGHT_UNITS)[number];

/** Whether a light type has a position — so whether physical units mean anything for it. */
export function isPunctual(type: LightType): boolean {
  return type === 'Point' || type === 'Spot';
}

/** Whether the renderer can produce a shadow map for this type. */
export function canCastShadow(type: LightType): boolean {
  // Hemisphere light has no direction to project from, and Three's RectAreaLight has no shadow
  // implementation at all — offering the checkbox on either would be a control that does
  // nothing, which is worse than not offering it.
  return type === 'Directional' || type === 'Point' || type === 'Spot';
}

/**
 * The intensity value to hand Three, in whatever unit that light class expects.
 *
 * Point and spot lights take candela. A point light radiates over the whole sphere, so
 * `lumens / 4π`; a spot only fills its cone, so the solid angle is `2π(1 − cos θ)` and the same
 * bulb in a tighter cone is genuinely brighter. That relationship is the entire reason to offer
 * physical units — narrowing a spot in artistic mode changes nothing about its brightness,
 * which is not how a torch works.
 */
export function resolveIntensity(component: LightComponent): number {
  const intensity = Math.max(0, component.intensity ?? 0);
  const unit: LightUnit = component.unit ?? 'Artistic';

  if (component.lightType === 'Directional' || component.lightType === 'Hemisphere') {
    return intensity;
  }

  if (component.lightType === 'Area') {
    // Three reads RectAreaLight intensity as nits, so physical mode passes it through and
    // artistic mode scales it into the same rough range as everything else.
    return unit === 'Physical' ? intensity : intensity * PUNCTUAL_INTENSITY_SCALE;
  }

  if (unit !== 'Physical') return intensity * PUNCTUAL_INTENSITY_SCALE;

  if (component.lightType === 'Spot') {
    const halfAngle = clamp(component.angle ?? 35, 1, 89) * (Math.PI / 180);
    const solidAngle = 2 * Math.PI * (1 - Math.cos(halfAngle));
    return solidAngle > 1e-6 ? intensity / solidAngle : intensity;
  }

  return intensity / (4 * Math.PI);
}

/**
 * How much this light matters right now, for deciding who gets a shadow map.
 *
 * Three inputs, in the order they matter. An author's explicit `shadowPriority` wins outright,
 * because "the sun always casts" is a decision no heuristic should be allowed to overrule. Then
 * brightness, because a dim light's shadow is barely visible anyway. Then distance, falling off
 * with the square, because a light behind the camera contributes a shadow nobody will see.
 *
 * Directional lights get a large distance bonus: they have a position in the scene but their
 * light does not come from it, so treating one like a lamp would drop the sun the moment you
 * walked away from wherever its gizmo happens to sit.
 */
export function lightImportance(
  component: LightComponent,
  lightPosition: Vec3,
  cameraPosition: Vec3,
): number {
  const priority = component.shadowPriority ?? 0;
  const brightness = Math.max(0.01, resolveIntensity(component));

  if (component.lightType === 'Directional') return priority * 1e6 + brightness * 1000;

  const distance = Math.hypot(
    lightPosition[0] - cameraPosition[0],
    lightPosition[1] - cameraPosition[1],
    lightPosition[2] - cameraPosition[2],
  );

  // A light whose range ends before the camera begins lights nothing the camera can see.
  const range = component.range > 0 ? component.range : Infinity;
  if (distance > range * 1.5) return priority * 1e6;

  return priority * 1e6 + brightness / (1 + distance * distance);
}

export interface ShadowCandidate<T> {
  key: T;
  component: LightComponent;
  position: Vec3;
}

/**
 * Picks which lights actually cast, given a budget.
 *
 * A shadow map is one extra render of the whole scene, so ten shadow-casting lights is ten
 * extra passes — the cheapest way to turn a 60 fps scene into a 6 fps one, and the easiest
 * mistake to make, because each individual light looks free when you add it. Capping the count
 * and choosing by importance means a scene can be lit with as many lights as it likes and still
 * be predictable to render.
 *
 * Returns the keys that keep their shadow. A budget of zero disables all of them; a negative
 * budget is read as "no limit", which is what the settings panel's off position means.
 */
export function selectShadowCasters<T>(
  candidates: readonly ShadowCandidate<T>[],
  maxCasters: number,
  cameraPosition: Vec3,
): Set<T> {
  const eligible = candidates.filter(
    (candidate) =>
      candidate.component.castShadow &&
      candidate.component.enabled !== false &&
      canCastShadow(candidate.component.lightType),
  );

  if (maxCasters < 0) return new Set(eligible.map((candidate) => candidate.key));
  if (maxCasters === 0) return new Set();

  return new Set(
    eligible
      .map((candidate) => ({
        key: candidate.key,
        score: lightImportance(candidate.component, candidate.position, cameraPosition),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxCasters)
      .map((entry) => entry.key),
  );
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
