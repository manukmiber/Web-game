import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  DOCK_LIMITS,
  DOCK_PANELS,
  PANELS,
  PANEL_SHORTCUTS,
  DRAWER_BREAKPOINT,
  clampLayout,
  dockKeys,
  usesDrawers,
  type LayoutState,
  type PanelId,
} from './layout';

const WIDE = { width: 1920, height: 1080 };

function layout(patch: Partial<LayoutState> = {}): LayoutState {
  return { ...DEFAULT_LAYOUT, ...patch };
}

describe('panel description', () => {
  it('assigns every panel to a dock that lists it', () => {
    for (const panel of Object.values(PANELS)) {
      expect(DOCK_PANELS[panel.dock]).toContain(panel.id);
    }
  });

  it('lists no panel twice, and none that is not described', () => {
    const listed = Object.values(DOCK_PANELS).flat();
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.sort()).toEqual((Object.keys(PANELS) as PanelId[]).sort());
  });

  /**
   * Two panels sharing a shortcut would silently give one of them no key at all — the lookup
   * table is keyed by the shortcut, so the second entry would overwrite the first.
   */
  it('gives every panel a distinct shortcut', () => {
    expect(Object.keys(PANEL_SHORTCUTS).length).toBe(Object.keys(PANELS).length);
    for (const [key, panel] of Object.entries(PANEL_SHORTCUTS)) {
      expect(panel && PANELS[panel].shortcut).toBe(key);
    }
  });

  /** Indexed with a raw `KeyboardEvent.key`, so inherited keys must not answer. */
  it('answers nothing for a key that is not a shortcut', () => {
    expect(PANEL_SHORTCUTS.constructor).toBeUndefined();
    expect(PANEL_SHORTCUTS.toString).toBeUndefined();
    expect(PANEL_SHORTCUTS.a).toBeUndefined();
  });

  it('points each dock key at fields that exist on a layout', () => {
    const state = layout();
    for (const dock of ['left', 'right', 'bottom'] as const) {
      const keys = dockKeys(dock);
      expect(typeof state[keys.open]).toBe('boolean');
      expect(typeof state[keys.size]).toBe('number');
      if (keys.panel) expect(DOCK_PANELS[dock]).toContain(state[keys.panel]);
    }
  });
});

describe('clampLayout', () => {
  it('leaves a layout that already fits alone', () => {
    const state = layout({ bottomOpen: true });
    expect(clampLayout(state, WIDE)).toEqual(state);
  });

  it('holds sizes inside their own limits', () => {
    const wide = clampLayout(layout({ leftWidth: 5000, rightWidth: 5000 }), WIDE);
    expect(wide.leftWidth).toBe(DOCK_LIMITS.leftWidth.max);
    expect(wide.rightWidth).toBe(DOCK_LIMITS.rightWidth.max);

    const narrow = clampLayout(layout({ leftWidth: 1, bottomHeight: 1 }), WIDE);
    expect(narrow.leftWidth).toBe(DOCK_LIMITS.leftWidth.min);
    expect(narrow.bottomHeight).toBe(DOCK_LIMITS.bottomHeight.min);
  });

  it('rejects a non-finite size rather than propagating NaN into a grid template', () => {
    const state = clampLayout(layout({ leftWidth: Number.NaN }), WIDE);
    expect(state.leftWidth).toBe(DOCK_LIMITS.leftWidth.min);
  });

  /**
   * The case this function exists for: a layout saved on a large monitor, reopened on a small
   * one. Both side docks give ground, rather than the viewport disappearing.
   */
  it('shrinks both side docks when the window cannot hold them', () => {
    const saved = layout({ leftWidth: 460, rightWidth: 600 });
    const fitted = clampLayout(saved, { width: 900, height: 800 });

    expect(fitted.leftWidth).toBeLessThan(saved.leftWidth);
    expect(fitted.rightWidth).toBeLessThan(saved.rightWidth);
    expect(fitted.leftWidth).toBeGreaterThanOrEqual(DOCK_LIMITS.leftWidth.min);
    expect(fitted.rightWidth).toBeGreaterThanOrEqual(DOCK_LIMITS.rightWidth.min);
  });

  it('does not take space from a dock that is closed', () => {
    const fitted = clampLayout(
      layout({ leftOpen: false, leftWidth: 460, rightWidth: 600 }),
      { width: 900, height: 800 },
    );
    expect(fitted.leftWidth).toBe(460);
    expect(fitted.rightWidth).toBeLessThan(600);
  });

  it('keeps a viewport above the bottom dock on a short window', () => {
    const fitted = clampLayout(layout({ bottomOpen: true, bottomHeight: 700 }), {
      width: 1600,
      height: 600,
    });
    expect(fitted.bottomHeight).toBeLessThan(700);
    expect(fitted.bottomHeight).toBeGreaterThanOrEqual(DOCK_LIMITS.bottomHeight.min);
  });

  it('leaves the bottom height alone while the dock is closed', () => {
    const fitted = clampLayout(layout({ bottomOpen: false, bottomHeight: 700 }), {
      width: 1600,
      height: 600,
    });
    expect(fitted.bottomHeight).toBe(700);
  });

  it('is idempotent, so a resize storm settles instead of creeping', () => {
    const small = { width: 880, height: 620 };
    const once = clampLayout(layout({ bottomOpen: true, leftWidth: 470, rightWidth: 610 }), small);
    expect(clampLayout(once, small)).toEqual(once);
  });
});

/**
 * On a phone the two side docks at their minimum widths are 420px between them, so laying them
 * out beside the viewport on a 390px screen left the viewport nothing at all. Below the
 * breakpoint they float over the scene instead — see the mobile block in `theme.css`, which
 * makes the same decision from the CSS side.
 */
describe('drawer layout on narrow screens', () => {
  it('switches over at the breakpoint the stylesheet uses', () => {
    // At the breakpoint itself the in-flow layout still leaves a full minimum viewport, so it
    // is the last width that does *not* need drawers.
    expect(usesDrawers(DRAWER_BREAKPOINT)).toBe(false);
    expect(usesDrawers(DRAWER_BREAKPOINT - 1)).toBe(true);
  });

  it('is the narrowest window that fits both docks and a minimum viewport', () => {
    const fitted = clampLayout(layout(), { width: DRAWER_BREAKPOINT, height: 800 });
    // Nothing had to be shrunk to make room, which is what "narrowest that fits" means.
    expect(fitted.leftWidth).toBe(DEFAULT_LAYOUT.leftWidth);
    expect(fitted.rightWidth).toBe(DEFAULT_LAYOUT.rightWidth);
  });

  it('treats a phone in landscape as narrow, not as a small desktop', () => {
    // 844px sounds roomy; in flow it leaves a 264px viewport.
    expect(usesDrawers(844)).toBe(true);
  });

  it('stops charging the viewport for docks that float over it', () => {
    const phone = { width: 390, height: 780 };
    const fitted = clampLayout(layout({ leftWidth: 300, rightWidth: 320 }), phone);
    // Kept whole: a drawer is as wide as it wants to be, because it costs the viewport nothing.
    expect(fitted.leftWidth).toBe(300);
    expect(fitted.rightWidth).toBe(320);
  });

  it('still keeps a viewport above the bottom dock, which does take space', () => {
    const fitted = clampLayout(layout({ bottomOpen: true, bottomHeight: 700 }), {
      width: 390,
      height: 700,
    });
    expect(fitted.bottomHeight).toBeLessThan(700);
  });

  it('is idempotent on a phone too', () => {
    const phone = { width: 390, height: 780 };
    const once = clampLayout(layout({ bottomOpen: true }), phone);
    expect(clampLayout(once, phone)).toEqual(once);
  });
});
