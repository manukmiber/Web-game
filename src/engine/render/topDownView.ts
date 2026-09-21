/**
 * The geometry of the editor's top-down 2D view.
 *
 * One orthographic camera, looking straight down at the ground plane, is the whole of "2D mode"
 * as far as rendering is concerned — the scene, the components and the renderer are the ones a
 * 3D scene uses, exactly as `physics/dimension` makes 2D a constraint on the 3D solver rather
 * than a second one. What that leaves is arithmetic, and it is gathered here because two very
 * different places need to agree about it: the RenderHost, which owns the camera, and the
 * editor's viewport, which drives it. When those two disagree the symptom is never "the 2D view
 * is wrong" — it is chunks streaming around a point nothing is near, or a sun whose shadow
 * frustum sits above the scene — so the agreement is worth making explicit and testable.
 */

/**
 * How high the camera flies above the plane it frames.
 *
 * An orthographic camera can sit anywhere along its own view direction without changing a pixel
 * of what it draws, so this number is chosen entirely for the things that *do* depend on it: the
 * near plane clips whatever is above it, the far plane whatever is below, and `topDownFocus`
 * walks back down it to find where the viewer is actually looking. Half a kilometre of headroom
 * is more than any scene this engine is built for puts overhead.
 */
export const ORTHO_EYE_HEIGHT = 500;

/** World units visible top to bottom at zoom 1. Zoom scales it; the frustum itself never moves. */
export const ORTHO_VIEW_HEIGHT = 40;

/** Furthest out: about four kilometres of world across the frame's height. */
export const ORTHO_MIN_ZOOM = ORTHO_VIEW_HEIGHT / 4000;
/** Closest in: about two metres. Past this, one metre of world is most of the screen. */
export const ORTHO_MAX_ZOOM = ORTHO_VIEW_HEIGHT / 2;

/** How much of the world is on screen, top to bottom, at a given zoom. */
export function orthoHalfHeight(zoom: number): number {
  return ORTHO_VIEW_HEIGHT / 2 / Math.max(zoom, 1e-6);
}

export function clampOrthoZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(ORTHO_MAX_ZOOM, Math.max(ORTHO_MIN_ZOOM, zoom));
}

/**
 * The zoom that just contains a sphere of `radius`, with a little air around it.
 *
 * Framing by zoom rather than by distance is the one thing focusing has to do differently in an
 * orthographic view: moving the camera closer to something changes nothing on screen, which is
 * what makes the projection orthographic in the first place.
 */
export function zoomToFit(radius: number): number {
  const safe = Math.max(radius, 1e-3);
  return clampOrthoZoom(ORTHO_VIEW_HEIGHT / 2 / (safe * 1.4));
}

/** The orthographic frustum for a canvas of this aspect ratio, before zoom is applied. */
export function orthoFrustum(aspect: number): {
  left: number;
  right: number;
  top: number;
  bottom: number;
} {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const halfHeight = ORTHO_VIEW_HEIGHT / 2;
  const halfWidth = halfHeight * safeAspect;
  return { left: -halfWidth, right: halfWidth, top: halfHeight, bottom: -halfHeight };
}
