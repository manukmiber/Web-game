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

/**
 * Where the camera is and what it is looking along — everything a shadow frustum needs to know
 * about the view.
 */
export interface ShadowView {
  position: Vec3;
  /** Unit vector the camera looks along. */
  forward: Vec3;
}

/** Where a directional light's shadow camera goes, and what it can see from there. */
export interface DirectionalShadowFrame {
  /** World position for the shadow camera. */
  position: Vec3;
  /** World point it looks at — the centre of the covered ground. */
  target: Vec3;
  near: number;
  far: number;
}

/**
 * Places a directional light's shadow frustum over what the camera is looking at.
 *
 * A directional light has no position — only a direction. Anchoring its shadow frustum to
 * wherever the light entity's gizmo happens to sit, which is what this used to do, produced a
 * bug that read as the renderer being broken: drag the sun sideways and every shadow in the
 * scene vanished, while the shading did not change at all, because the ±`range` box had walked
 * off the geometry. The frustum belongs over the *view*; only the light's rotation is its own.
 *
 * The centre is pushed `range` ahead of the camera so the covered slab runs from roughly the
 * near clip out to `2 × range` — a shadow volume centred on the eye would spend half of itself
 * behind the viewer.
 *
 * **Texel snapping** is what makes it usable rather than merely correct. A shadow map that
 * slides continuously with the camera resamples every edge every frame, and the shadows crawl
 * and shimmer as you orbit. Quantising the centre to whole shadow-map texels — in the light's
 * own basis, which is the only basis the texel grid is axis-aligned in — means the map moves in
 * whole-texel jumps and the edges hold still.
 */
export function directionalShadowFrame(
  view: ShadowView,
  /** Unit vector the light travels along, in world space. */
  direction: Vec3,
  range: number,
  mapSize: number,
): DirectionalShadowFrame {
  const extent = Math.max(1, range);
  const forward = normalize(view.forward);
  const travel = normalize(direction);

  const centre: Vec3 = [
    view.position[0] + forward[0] * extent,
    view.position[1] + forward[1] * extent,
    view.position[2] + forward[2] * extent,
  ];

  // An orthonormal pair across the light direction. Derived from `travel` alone so it is stable
  // frame to frame — a basis that flipped as the camera moved would defeat the snapping below.
  const seed: Vec3 = Math.abs(travel[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  const right = normalize(cross(seed, travel));
  const up = cross(travel, right);

  const texel = (extent * 2) / Math.max(1, mapSize);
  const across = add(
    scale(right, quantize(dot(centre, right), texel)),
    scale(up, quantize(dot(centre, up), texel)),
  );
  // Depth along the light is left alone: sliding the frustum along its own axis moves nothing
  // in the map, and quantising it would only fight the near/far below.
  const snapped = add(across, scale(travel, dot(centre, travel)));

  // How far back along the light the camera sits. It has to clear the tallest thing that can
  // cast into the covered area, and `range` is the only hint of world scale available here.
  const distance = extent * 2 + 10;

  return {
    position: [
      snapped[0] - travel[0] * distance,
      snapped[1] - travel[1] * distance,
      snapped[2] - travel[2] * distance,
    ],
    target: snapped,
    near: 0.5,
    // Reaches past the centre by as much again, so geometry below the focus plane — a valley, a
    // basement — still receives.
    far: distance + extent * 2 + 10,
  };
}

function quantize(value: number, step: number): number {
  return step > 0 ? Math.round(value / step) * step : value;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Vec3, factor: number): Vec3 {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  // A zero vector has no direction; straight down is the least surprising stand-in for a sun.
  return length > 1e-6 ? [v[0] / length, v[1] / length, v[2] / length] : [0, -1, 0];
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
