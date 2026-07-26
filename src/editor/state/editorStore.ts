import { create } from 'zustand';
import type { EntityId } from '@engine/scene/types';
import type { StressPreset } from '@engine/perf/StressScene';
import type { ShadingMode } from '@engine/render/RenderHost';

export type TransformTool = 'select' | 'move' | 'rotate' | 'scale';
export type TransformSpace = 'local' | 'world';

/**
 * Manual quality and stress-test levers for the measurement harness.
 *
 * These are driven by hand from the PerfHud so a budget can be measured on real devices.
 * Stage 2's adaptive quality will drive the same RenderHost setters automatically; what
 * changes then is who decides, not how it is applied.
 */
export interface PerfSettings {
  hudVisible: boolean;
  stressPreset: StressPreset | 'off';
  /** Objects per 100 m². */
  density: number;
  uniqueMeshes: number;
  instanced: boolean;
  renderDistance: number;
  resolutionScale: number;
  shadowsEnabled: boolean;
  shadowMapSize: number;
}

export const DEFAULT_PERF: PerfSettings = {
  hudVisible: false,
  stressPreset: 'off',
  density: 0.8,
  uniqueMeshes: 6,
  instanced: true,
  renderDistance: 400,
  resolutionScale: 1,
  shadowsEnabled: true,
  shadowMapSize: 2048,
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
  consoleMessages: ConsoleMessage[];
  consoleVisible: boolean;

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
  pushConsole(message: Omit<ConsoleMessage, 'id'>): void;
  clearConsole(): void;
  setConsoleVisible(visible: boolean): void;
}

let consoleCounter = 0;

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
  consoleMessages: [],
  consoleVisible: false,

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
  pushConsole: (message) =>
    set((state) => {
      consoleCounter += 1;
      const next = [...state.consoleMessages, { ...message, id: consoleCounter }];
      return {
        consoleMessages: next.length > CONSOLE_LIMIT ? next.slice(-CONSOLE_LIMIT) : next,
        // An error is worth interrupting for; a log line is not.
        consoleVisible: state.consoleVisible || message.level === 'error',
      };
    }),
  clearConsole: () => set({ consoleMessages: [] }),
  setConsoleVisible: (consoleVisible) => set({ consoleVisible }),
}));

/** Reads current state outside React (gizmo handlers, keyboard shortcuts). */
export const editorState = () => useEditorStore.getState();
