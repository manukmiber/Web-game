import { create } from 'zustand';
import type { EntityId } from '@engine/scene/types';
import type { StressPreset } from '@engine/perf/StressScene';
import { normalizeGraphics, type GraphicsSettings } from '@engine/render/GraphicsSettings';
import type { ShadingMode } from '@engine/render/RenderHost';
import { loadGraphicsSettings, saveGraphicsSettings } from './graphicsSettings';
import {
  PANELS,
  clampLayout,
  dockKeys,
  loadLayout,
  saveLayout,
  type LayoutState,
  type PanelId,
} from './layout';

export type TransformTool = 'select' | 'move' | 'rotate' | 'scale';
export type TransformSpace = 'local' | 'world';

/**
 * Stress-test levers for the measurement harness.
 *
 * These are driven by hand from the Performance panel so a budget can be measured on real
 * devices. The quality levers that used to sit beside them now live in `graphics` instead:
 * having a resolution scale here *and* a graphics setting for the same thing meant two sources
 * of truth for one renderer value, and whichever was touched last won.
 *
 * Whether the panel is *open* is no longer one of these. That is layout, it belongs with every
 * other panel's visibility in `layout`, and keeping it here meant the perf HUD was the one
 * panel the status bar and the dock system could not describe.
 */
export interface PerfSettings {
  stressPreset: StressPreset | 'off';
  /** Objects per 100 m². */
  density: number;
  uniqueMeshes: number;
  instanced: boolean;
  renderDistance: number;
}

export const DEFAULT_PERF: PerfSettings = {
  stressPreset: 'off',
  density: 0.8,
  uniqueMeshes: 6,
  instanced: true,
  renderDistance: 400,
};

export interface ConsoleMessage {
  id: number;
  level: 'log' | 'warn' | 'error' | 'info';
  /** Which script or system produced it. */
  source: string;
  text: string;
  entityId: EntityId | null;
}

/**
 * Old messages are dropped rather than kept.
 *
 * A script logging every frame produces 3,600 lines a minute; an unbounded array would turn
 * the console into a memory leak with a scrollbar.
 */
const CONSOLE_LIMIT = 200;

/** One line in the assistant transcript. Tool calls are shown, not hidden behind the prose. */
export interface AssistantEntry {
  id: number;
  kind: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
  /** Present on tool entries: the tool that ran, and whether it came back an error. */
  tool?: string;
  failed?: boolean;
}

interface EditorState {
  selection: EntityId[];
  /** Anchor for shift-range selection in the Hierarchy. */
  lastSelected: EntityId | null;
  tool: TransformTool;
  space: TransformSpace;
  snapEnabled: boolean;
  moveSnap: number;
  rotateSnap: number;
  scaleSnap: number;
  playing: boolean;
  shading: ShadingMode;
  /** Bumped whenever scene structure changes, to re-render the Hierarchy tree. */
  sceneRevision: number;
  canUndo: boolean;
  canRedo: boolean;
  statusMessage: string | null;
  perf: PerfSettings;
  /** Renderer quality. Persisted per browser, not per scene — see `graphicsSettings.ts`. */
  graphics: GraphicsSettings;
  /** Dock sizes and which panel is frontmost in each. Persisted — see `layout.ts`. */
  layout: LayoutState;
  consoleMessages: ConsoleMessage[];
  assistantBusy: boolean;
  assistantEntries: AssistantEntry[];

  setSelection(ids: EntityId[]): void;
  toggleSelection(id: EntityId): void;
  clearSelection(): void;
  setTool(tool: TransformTool): void;
  setSpace(space: TransformSpace): void;
  setSnapEnabled(enabled: boolean): void;
  setSnapValues(values: Partial<Pick<EditorState, 'moveSnap' | 'rotateSnap' | 'scaleSnap'>>): void;
  setPlaying(playing: boolean): void;
  setShading(shading: ShadingMode): void;
  bumpSceneRevision(): void;
  setHistoryState(canUndo: boolean, canRedo: boolean): void;
  setStatusMessage(message: string | null): void;
  setPerf(patch: Partial<PerfSettings>): void;
  setGraphics(patch: Partial<GraphicsSettings>): void;
  resetGraphics(): void;
  setLayout(patch: Partial<LayoutState>): void;
  /** Opens the panel's dock and brings the panel frontmost. */
  showPanel(panel: PanelId): void;
  /** Frontmost in an open dock closes the dock; anything else is brought frontmost. */
  togglePanel(panel: PanelId): void;
  /** Re-fits the docks after the window changes size. */
  refitLayout(): void;
  pushConsole(message: Omit<ConsoleMessage, 'id'>): void;
  clearConsole(): void;
  setAssistantBusy(busy: boolean): void;
  pushAssistantEntry(entry: Omit<AssistantEntry, 'id'>): void;
  clearAssistant(): void;
}

/** True when `panel` is the one its dock is currently showing, and that dock is open. */
export function isPanelVisible(layout: LayoutState, panel: PanelId): boolean {
  const keys = dockKeys(PANELS[panel].dock);
  if (!layout[keys.open]) return false;
  return keys.panel === null || layout[keys.panel] === panel;
}

function windowSize() {
  return { width: window.innerWidth, height: window.innerHeight };
}

let consoleCounter = 0;
let assistantCounter = 0;

/**
 * Editor UI state — selection, active tool, snapping. Deliberately separate from the Scene:
 * none of this is part of the scene data, and none of it exists in the game runtime.
 *
 * Zustand rather than Context because the gizmo drag handler reads and writes this from
 * inside the render loop; a Context would put React re-renders in the per-frame hot path.
 */
export const useEditorStore = create<EditorState>((set) => ({
  selection: [],
  lastSelected: null,
  tool: 'move',
  space: 'world',
  snapEnabled: false,
  // Unity's defaults: 1 unit, 15 degrees.
  moveSnap: 1,
  rotateSnap: 15,
  scaleSnap: 0.1,
  playing: false,
  shading: 'shaded',
  sceneRevision: 0,
  canUndo: false,
  canRedo: false,
  statusMessage: null,
  perf: { ...DEFAULT_PERF },
  graphics: loadGraphicsSettings(),
  layout: loadLayout(),
  consoleMessages: [],
  assistantBusy: false,
  assistantEntries: [],

  setSelection: (ids) => set({ selection: ids, lastSelected: ids[ids.length - 1] ?? null }),
  toggleSelection: (id) =>
    set((state) => {
      const has = state.selection.includes(id);
      const selection = has ? state.selection.filter((s) => s !== id) : [...state.selection, id];
      return { selection, lastSelected: has ? state.lastSelected : id };
    }),
  clearSelection: () => set({ selection: [], lastSelected: null }),
  setTool: (tool) => set({ tool }),
  setSpace: (space) => set({ space }),
  setSnapEnabled: (snapEnabled) => set({ snapEnabled }),
  setSnapValues: (values) => set(values),
  setPlaying: (playing) => set({ playing }),
  setShading: (shading) => set({ shading }),
  bumpSceneRevision: () => set((state) => ({ sceneRevision: state.sceneRevision + 1 })),
  setHistoryState: (canUndo, canRedo) => set({ canUndo, canRedo }),
  setStatusMessage: (statusMessage) => set({ statusMessage }),
  setPerf: (patch) => set((state) => ({ perf: { ...state.perf, ...patch } })),
  /**
   * Normalized on write rather than on read, so the value in the store is always the value the
   * renderer is actually using — a panel that echoes back an out-of-range number the renderer
   * quietly clamped is worse than no readout at all.
   */
  setGraphics: (patch) =>
    set((state) => {
      const graphics = normalizeGraphics({ ...state.graphics, ...patch });
      saveGraphicsSettings(graphics);
      return { graphics };
    }),
  resetGraphics: () =>
    set(() => {
      const graphics = normalizeGraphics(null);
      saveGraphicsSettings(graphics);
      return { graphics };
    }),
  /**
   * Sizes are clamped against the window on write, not on read, for the same reason graphics
   * settings are normalized on write: the splitter's readout and the dock's actual width are
   * then the same number by construction.
   */
  setLayout: (patch) =>
    set((state) => {
      const layout = clampLayout({ ...state.layout, ...patch }, windowSize());
      saveLayout(layout);
      return { layout };
    }),
  showPanel: (panel) =>
    set((state) => {
      const keys = dockKeys(PANELS[panel].dock);
      const layout = clampLayout(
        { ...state.layout, [keys.open]: true, ...(keys.panel ? { [keys.panel]: panel } : {}) },
        windowSize(),
      );
      saveLayout(layout);
      return { layout };
    }),
  togglePanel: (panel) =>
    set((state) => {
      const keys = dockKeys(PANELS[panel].dock);
      // Clicking the panel you are already looking at closes the dock — the same gesture a tab
      // strip gives you everywhere else, and the reason no panel needs its own ✕ any more.
      const frontmost = keys.panel === null || state.layout[keys.panel] === panel;
      const open = !(state.layout[keys.open] && frontmost);
      const layout = clampLayout(
        { ...state.layout, [keys.open]: open, ...(keys.panel ? { [keys.panel]: panel } : {}) },
        windowSize(),
      );
      saveLayout(layout);
      return { layout };
    }),
  refitLayout: () => set((state) => ({ layout: clampLayout(state.layout, windowSize()) })),
  pushConsole: (message) =>
    set((state) => {
      consoleCounter += 1;
      const next = [...state.consoleMessages, { ...message, id: consoleCounter }];
      /**
       * An error is worth interrupting for; a log line is not. But it only interrupts a *closed*
       * dock: a script throwing on every frame would otherwise yank the bottom dock back to the
       * Console sixty times a second while you were reading the graphics settings. Once the
       * dock is open on something else, the error count in the status bar is the notification.
       */
      const shouldOpen = message.level === 'error' && !state.layout.bottomOpen;
      const layout = shouldOpen
        ? clampLayout({ ...state.layout, bottomOpen: true, bottomPanel: 'console' }, windowSize())
        : state.layout;
      if (shouldOpen) saveLayout(layout);
      return {
        consoleMessages: next.length > CONSOLE_LIMIT ? next.slice(-CONSOLE_LIMIT) : next,
        layout,
      };
    }),
  clearConsole: () => set({ consoleMessages: [] }),
  setAssistantBusy: (assistantBusy) => set({ assistantBusy }),
  pushAssistantEntry: (entry) =>
    set((state) => {
      assistantCounter += 1;
      return { assistantEntries: [...state.assistantEntries, { ...entry, id: assistantCounter }] };
    }),
  clearAssistant: () => set({ assistantEntries: [] }),
}));

/** Reads current state outside React (gizmo handlers, keyboard shortcuts). */
export const editorState = () => useEditorStore.getState();
