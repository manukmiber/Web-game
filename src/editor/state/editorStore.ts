import { create } from 'zustand';
import type { EntityId } from '@engine/scene/types';

export type TransformTool = 'select' | 'move' | 'rotate' | 'scale';
export type TransformSpace = 'local' | 'world';

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
  /** Bumped whenever scene structure changes, to re-render the Hierarchy tree. */
  sceneRevision: number;
  canUndo: boolean;
  canRedo: boolean;
  statusMessage: string | null;

  setSelection(ids: EntityId[]): void;
  toggleSelection(id: EntityId): void;
  clearSelection(): void;
  setTool(tool: TransformTool): void;
  setSpace(space: TransformSpace): void;
  setSnapEnabled(enabled: boolean): void;
  setSnapValues(values: Partial<Pick<EditorState, 'moveSnap' | 'rotateSnap' | 'scaleSnap'>>): void;
  setPlaying(playing: boolean): void;
  bumpSceneRevision(): void;
  setHistoryState(canUndo: boolean, canRedo: boolean): void;
  setStatusMessage(message: string | null): void;
}

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
  sceneRevision: 0,
  canUndo: false,
  canRedo: false,
  statusMessage: null,

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
  bumpSceneRevision: () => set((state) => ({ sceneRevision: state.sceneRevision + 1 })),
  setHistoryState: (canUndo, canRedo) => set({ canUndo, canRedo }),
  setStatusMessage: (statusMessage) => set({ statusMessage }),
}));

/** Reads current state outside React (gizmo handlers, keyboard shortcuts). */
export const editorState = () => useEditorStore.getState();
