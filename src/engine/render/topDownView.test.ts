import { describe, expect, it } from 'vitest';
import {
  ORTHO_EYE_HEIGHT,
  ORTHO_MAX_ZOOM,
  ORTHO_MIN_ZOOM,
  ORTHO_VIEW_HEIGHT,
  clampOrthoZoom,
  orthoFrustum,
  orthoHalfHeight,
  zoomToFit,
} from './topDownView';

/**
 * The 2D view's arithmetic, which two places have to agree about: the RenderHost owns the
 * camera and the editor's viewport drives it. A disagreement here does not look like a broken
 * 2D view — it looks like chunks streaming around a point nothing is near, or shadows that
 * stopped working — so it is pinned down rather than left to match by inspection.
 */
describe('topDownView', () => {
  it('keeps the eye high enough to clear anything a scene puts overhead', () => {
    // The near plane clips whatever is above the camera, so this is a real ceiling on scene
    // content, not a free parameter.
    expect(ORTHO_EYE_HEIGHT).toBeGreaterThanOrEqual(100);
  });

  describe('orthoHalfHeight', () => {
    it('shows half the view height at zoom 1', () => {
      expect(orthoHalfHeight(1)).toBe(ORTHO_VIEW_HEIGHT / 2);
    });

    it('halves what is on screen when the zoom doubles', () => {
      expect(orthoHalfHeight(2)).toBeCloseTo(orthoHalfHeight(1) / 2, 10);
    });

    it('survives a zoom of zero rather than dividing by it', () => {
      expect(Number.isFinite(orthoHalfHeight(0))).toBe(true);
    });
  });

  describe('clampOrthoZoom', () => {
    it('leaves a sane zoom alone', () => {
      expect(clampOrthoZoom(1)).toBe(1);
    });

    it('holds the limits the orbit controls are given', () => {
      expect(clampOrthoZoom(1e9)).toBe(ORTHO_MAX_ZOOM);
      expect(clampOrthoZoom(1e-9)).toBe(ORTHO_MIN_ZOOM);
    });

    it('answers a nonsense zoom with a usable one', () => {
      expect(clampOrthoZoom(Number.NaN)).toBe(1);
      expect(clampOrthoZoom(Number.POSITIVE_INFINITY)).toBe(1);
    });
  });

  describe('zoomToFit', () => {
    it('fits the sphere inside the frame, with room to spare', () => {
      const radius = 4;
      expect(orthoHalfHeight(zoomToFit(radius))).toBeGreaterThan(radius);
    });

    it('zooms in for something small and out for something large', () => {
      expect(zoomToFit(0.5)).toBeGreaterThan(zoomToFit(50));
    });

    it('does not leave the zoom range, however big or small the thing is', () => {
      expect(zoomToFit(1e9)).toBe(ORTHO_MIN_ZOOM);
      expect(zoomToFit(0)).toBe(ORTHO_MAX_ZOOM);
    });
  });

  describe('orthoFrustum', () => {
    it('keeps the height fixed and lets the aspect decide the width', () => {
      const wide = orthoFrustum(2);
      expect(wide.top - wide.bottom).toBe(ORTHO_VIEW_HEIGHT);
      expect(wide.right - wide.left).toBe(ORTHO_VIEW_HEIGHT * 2);
    });

    it('stays centred, so a resize widens the view rather than sliding it', () => {
      const frustum = orthoFrustum(1.7);
      expect(frustum.left).toBe(-frustum.right);
      expect(frustum.bottom).toBe(-frustum.top);
    });

    it('refuses to build a degenerate frustum from a zero-sized canvas', () => {
      const frustum = orthoFrustum(0);
      expect(frustum.right).toBeGreaterThan(0);
      expect(frustum.top).toBeGreaterThan(0);
    });
  });
});
