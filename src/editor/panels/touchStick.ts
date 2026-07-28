/**
 * The maths behind the on-screen thumb pads, kept apart from the component that draws them.
 *
 * Same separation as `render/lighting`: how far a thumb has to travel before the character
 * walks is a decision worth testing, and testing it should not mean mounting React. `TouchControls`
 * is then only markup and event plumbing.
 */

/** Travel, in pixels, that reads as full deflection. About a comfortable thumb's reach. */
export const STICK_RANGE_PX = 64;

/**
 * Below this fraction of the range the stick reads as centred.
 *
 * A thumb resting on glass is never still, and without a dead zone a character drifts forward
 * whenever nobody is touching anything — the touch equivalent of a stuck key.
 */
export const STICK_DEAD_ZONE = 0.18;

/** How much of the look pad's horizontal travel becomes turn rate, per pixel. */
export const LOOK_SENSITIVITY = 1 / 90;

/**
 * Pixels of travel to a -1..1 axis.
 *
 * The dead zone is *rescaled* rather than merely clipped. Clipping alone makes the axis jump
 * straight from 0 to 0.18 the moment the thumb leaves the centre, which feels like a loose
 * connector; rescaling means the live range still starts at zero and the first millimetre of
 * movement is the slowest.
 */
export function stickAxis(pixels: number, range = STICK_RANGE_PX): number {
  const raw = clamp(pixels / range, -1, 1);
  const magnitude = Math.abs(raw);
  if (magnitude < STICK_DEAD_ZONE) return 0;
  return Math.sign(raw) * ((magnitude - STICK_DEAD_ZONE) / (1 - STICK_DEAD_ZONE));
}

/** Horizontal travel on the look pad to a turn axis. Positive is to the right. */
export function lookAxis(pixels: number): number {
  return clamp(pixels * LOOK_SENSITIVITY, -1, 1);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
