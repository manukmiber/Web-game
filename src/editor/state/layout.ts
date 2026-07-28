/**
 * Where every panel lives, how big its dock is, and how that survives a reload.
 *
 * Until v0.7.4 the editor had two docked panels and five floating ones, and the floating ones
 * were absolutely positioned over the canvas at hard-coded offsets: Graphics at `left: 10px`,
 * Hardware also at `left: 0`, Perf at `right: 10px`, Assistant also at `right: 0`. Any two of
 * them open at once overlapped, the Console covered the bottom of the scene, and their toggle
 * buttons sat on the canvas edge where they collided with the viewport hint. Every panel had
 * its own `visible` flag and its own close button, so nothing knew about anything else.
 *
 * So panels no longer float. Each one belongs to a dock, docks take space from the viewport
 * instead of covering it, and a dock shows one panel at a time through a tab strip. That makes
 * the whole thing describable as data — which is what the status bar, the keyboard shortcuts
 * and this module's persistence all read.
 */

export type DockId = 'left' | 'right' | 'bottom';

export type PanelId =
  | 'hierarchy'
  | 'inspector'
  | 'assistant'
  | 'console'
  | 'performance'
  | 'statistics'
  | 'graphics'
  | 'hardware';

export interface PanelMeta {
  id: PanelId;
  label: string;
  /** Shown in the tab strip and the status bar, where there is no room for the word. */
  icon: string;
  dock: DockId;
  /** Function key that focuses this panel, and toggles its dock when it is already frontmost. */
  shortcut: string;
  title: string;
}

export const PANELS: Record<PanelId, PanelMeta> = {
  hierarchy: {
    id: 'hierarchy',
    label: 'Hierarchy',
    icon: '☰',
    dock: 'left',
    shortcut: 'F3',
    title: 'Scene tree — drag to reparent, drop on an edge to reorder (F3)',
  },
  inspector: {
    id: 'inspector',
    label: 'Inspector',
    icon: '◧',
    dock: 'right',
    shortcut: 'F6',
    title: 'Transform, components and the modifier stack for the selection (F6)',
  },
  assistant: {
    id: 'assistant',
    label: 'Assistant',
    icon: '✦',
    dock: 'right',
    shortcut: 'F2',
    title: 'Ask for scene changes in plain language (F2)',
  },
  console: {
    id: 'console',
    label: 'Console',
    icon: '›_',
    dock: 'bottom',
    shortcut: 'F4',
    title: 'Script output and gameplay events (F4)',
  },
  performance: {
    id: 'performance',
    label: 'Performance',
    icon: '◔',
    dock: 'bottom',
    shortcut: 'F8',
    title: 'Frame timing, draw calls and the stress-scene harness (F8)',
  },
  statistics: {
    id: 'statistics',
    label: 'Statistics',
    icon: '△',
    dock: 'bottom',
    shortcut: 'F10',
    title: 'Triangle and object census, per entity and per component (F10)',
  },
  graphics: {
    id: 'graphics',
    label: 'Graphics',
    icon: '◑',
    dock: 'bottom',
    shortcut: 'F7',
    title: 'Antialiasing, shadows, tone mapping and resolution (F7)',
  },
  hardware: {
    id: 'hardware',
    label: 'Hardware',
    icon: '⚡',
    dock: 'bottom',
    shortcut: 'F9',
    title: 'Attached boards and their live channel values (F9)',
  },
};

/** Tab order within each dock. The left dock has one panel, and so has no tab strip. */
export const DOCK_PANELS: Record<DockId, PanelId[]> = {
  left: ['hierarchy'],
  right: ['inspector', 'assistant'],
  bottom: ['console', 'performance', 'statistics', 'graphics', 'hardware'],
};

/**
 * Shortcut key → panel, for the keyboard handler.
 *
 * Null-prototype, because this is indexed with a raw `KeyboardEvent.key`: a plain object would
 * answer `'constructor'` with a function, and the handler only checks that the lookup is truthy.
 */
export const PANEL_SHORTCUTS: Record<string, PanelId | undefined> = Object.assign(
  Object.create(null) as Record<string, PanelId | undefined>,
  Object.fromEntries(Object.values(PANELS).map((panel) => [panel.shortcut, panel.id])),
);

export interface LayoutState {
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
  /** Frontmost panel per dock. The left dock has only one, so it needs no entry. */
  rightPanel: PanelId;
  bottomPanel: PanelId;
}

export const DEFAULT_LAYOUT: LayoutState = {
  leftWidth: 260,
  rightWidth: 320,
  bottomHeight: 220,
  leftOpen: true,
  rightOpen: true,
  bottomOpen: false,
  rightPanel: 'inspector',
  bottomPanel: 'console',
};

/**
 * Hard limits, before the viewport gets a say.
 *
 * A dock narrower than its minimum shows a scrollbar and half a label, which is worse than not
 * being resizable at all. The maxima are then cut down again by `clampLayout` so the viewport
 * always keeps `MIN_VIEWPORT` — on a small laptop the fixed maxima alone would let the two
 * side docks meet in the middle.
 */
export const DOCK_LIMITS = {
  leftWidth: { min: 180, max: 480 },
  rightWidth: { min: 240, max: 620 },
  bottomHeight: { min: 120, max: 720 },
} as const;

const MIN_VIEWPORT_WIDTH = 320;
const MIN_VIEWPORT_HEIGHT = 220;

/** Chrome that is never part of a dock: toolbar plus status bar, near enough. */
const FIXED_CHROME_HEIGHT = 88;

export interface Viewportish {
  width: number;
  height: number;
}

function clampRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Fits a layout inside the window it has to live in.
 *
 * Called on every resize and on every drag, so a layout saved on a 32-inch monitor opens on a
 * laptop with the docks shrunk rather than with no viewport left. Widths are reduced together:
 * taking the whole overflow off whichever dock happens to be resized would make the other one
 * unreachable.
 */
export function clampLayout(layout: LayoutState, window: Viewportish): LayoutState {
  const next = { ...layout };

  next.leftWidth = clampRange(next.leftWidth, DOCK_LIMITS.leftWidth.min, DOCK_LIMITS.leftWidth.max);
  next.rightWidth = clampRange(
    next.rightWidth,
    DOCK_LIMITS.rightWidth.min,
    DOCK_LIMITS.rightWidth.max,
  );
  next.bottomHeight = clampRange(
    next.bottomHeight,
    DOCK_LIMITS.bottomHeight.min,
    DOCK_LIMITS.bottomHeight.max,
  );

  const usedWidth = (next.leftOpen ? next.leftWidth : 0) + (next.rightOpen ? next.rightWidth : 0);
  const spareWidth = window.width - MIN_VIEWPORT_WIDTH - usedWidth;
  if (spareWidth < 0 && usedWidth > 0) {
    // Give back proportionally, then re-apply the per-dock minimum. A dock can end up below
    // `MIN_VIEWPORT_WIDTH`'s ideal share on a very narrow window; that is the honest outcome.
    const scale = Math.max(0, (usedWidth + spareWidth) / usedWidth);
    if (next.leftOpen) {
      next.leftWidth = Math.max(DOCK_LIMITS.leftWidth.min, Math.round(next.leftWidth * scale));
    }
    if (next.rightOpen) {
      next.rightWidth = Math.max(DOCK_LIMITS.rightWidth.min, Math.round(next.rightWidth * scale));
    }
  }

  if (next.bottomOpen) {
    const maxBottom = window.height - FIXED_CHROME_HEIGHT - MIN_VIEWPORT_HEIGHT;
    next.bottomHeight = Math.max(
      DOCK_LIMITS.bottomHeight.min,
      Math.min(next.bottomHeight, maxBottom),
    );
  }

  return next;
}

const STORAGE = 'web3d-editor.layout';

/**
 * Layout persists per browser, for the same reason graphics settings do: how wide the Inspector
 * should be is a property of the screen you are sitting at, not of the scene you opened.
 */
export function loadLayout(): LayoutState {
  try {
    const raw = window.localStorage.getItem(STORAGE);
    if (!raw) return { ...DEFAULT_LAYOUT };
    const stored = JSON.parse(raw) as Partial<LayoutState>;
    const merged: LayoutState = { ...DEFAULT_LAYOUT, ...stored };
    // A panel id from a newer build — or a hand-edited value — must not leave a dock rendering
    // nothing, so anything unrecognised falls back to that dock's first tab.
    if (!DOCK_PANELS.right.includes(merged.rightPanel)) merged.rightPanel = DEFAULT_LAYOUT.rightPanel;
    if (!DOCK_PANELS.bottom.includes(merged.bottomPanel)) {
      merged.bottomPanel = DEFAULT_LAYOUT.bottomPanel;
    }
    return clampLayout(merged, { width: window.innerWidth, height: window.innerHeight });
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function saveLayout(layout: LayoutState): void {
  try {
    window.localStorage.setItem(STORAGE, JSON.stringify(layout));
  } catch {
    // Private browsing, or storage disabled. The session still works, it just won't persist.
  }
}

/** The `{dock}Open` / `{dock}Panel` keys for a dock, so callers can patch one generically. */
export function dockKeys(dock: DockId): {
  open: 'leftOpen' | 'rightOpen' | 'bottomOpen';
  size: 'leftWidth' | 'rightWidth' | 'bottomHeight';
  panel: 'rightPanel' | 'bottomPanel' | null;
} {
  switch (dock) {
    case 'left':
      return { open: 'leftOpen', size: 'leftWidth', panel: null };
    case 'right':
      return { open: 'rightOpen', size: 'rightWidth', panel: 'rightPanel' };
    case 'bottom':
      return { open: 'bottomOpen', size: 'bottomHeight', panel: 'bottomPanel' };
  }
}
