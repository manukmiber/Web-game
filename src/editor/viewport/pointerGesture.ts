/**
 * When a press on the viewport counts as a click on the scene.
 *
 * Kept apart from `ViewportController` for the same reason as `panels/touchStick`: this is a
 * decision with edges worth testing, and testing it should not mean standing up a WebGL context.
 * The controller is then only event plumbing.
 */

/** Pointer travel beyond this is treated as an orbit drag, not a click-to-select. */
export const CLICK_SLOP_PX = 4;

/**
 * The same threshold for a finger.
 *
 * A mouse click moves a pixel or two; a tap on glass routinely moves ten while the finger
 * flattens and rolls. At the mouse threshold roughly half of all taps were read as tiny orbit
 * drags and selected nothing, which is indistinguishable from picking being broken.
 */
export const TOUCH_CLICK_SLOP_PX = 14;

/** Where a press began, and with what. */
export interface Press {
  x: number;
  y: number;
  /** True when the press came from a finger rather than a mouse or a pen. */
  touch: boolean;
}

/**
 * Whether the press that just ended should pick whatever is under it.
 *
 * Two things disqualify it. The obvious one is travel: past the slop the user was orbiting, and
 * an orbit that happens to end over an object must not select it.
 *
 * The other is that the gizmo took the press, and that one is not a matter of degree — a handle
 * drag is never a click, however short it turned out to be. Deciding it by distance instead was
 * the bug this rule exists for: a press on an arrow that moved less than the slop fell through to
 * picking, the ray went down the length of the arrow into empty space, and *clearing* the
 * selection is what happens when you click nothing. The gizmo then disappeared, because a gizmo
 * with nothing selected is not drawn. Nudging a handle a few pixels is the whole of precise
 * positioning with a mouse, so the tool destroyed its own preconditions on the exact gesture it
 * exists to serve — while a finger, which never travels that little, mostly escaped it.
 */
export function isSelectionClick(
  press: Press,
  release: { x: number; y: number },
  claimedByGizmo: boolean,
): boolean {
  if (claimedByGizmo) return false;
  const travelled = Math.hypot(release.x - press.x, release.y - press.y);
  return travelled <= (press.touch ? TOUCH_CLICK_SLOP_PX : CLICK_SLOP_PX);
}
