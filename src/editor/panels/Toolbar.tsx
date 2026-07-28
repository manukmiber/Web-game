import { useRef } from 'react';
import { PREFAB_MENU, createPrefab, type PrefabKind } from '@engine/scene/prefabs';
import {
  SHAPE_MENU,
  SOLID_MENU,
  createPrimitiveEntity,
  type PrimitiveKind,
} from '@engine/scene/primitives';
import { useEditor } from '../EditorContext';
import { useEditorStore, type TransformTool } from '../state/editorStore';
import { AddEntitiesCommand, AddEntityCommand } from '../commands/sceneCommands';
import {
  AUTOSAVE_KEY,
  exportSceneFile,
  importSceneFile,
  loadScene,
  saveScene,
} from '../state/persistence';

const TOOLS: { tool: TransformTool; label: string; hint: string; title: string }[] = [
  { tool: 'select', label: '✥', hint: 'Q', title: 'Select / Pan (Q)' },
  { tool: 'move', label: '✛', hint: 'W', title: 'Move (W)' },
  { tool: 'rotate', label: '⟳', hint: 'E', title: 'Rotate (E)' },
  { tool: 'scale', label: '⤢', hint: 'R', title: 'Scale (R)' },
];

interface Props {
  /** Supplied by the viewport so new objects appear where the camera is looking. */
  spawnPoint(): [number, number, number];
}

export function Toolbar({ spawnPoint }: Props) {
  const { engine, history, storage, run } = useEditor();
  const fileInput = useRef<HTMLInputElement>(null);

  const tool = useEditorStore((s) => s.tool);
  const space = useEditorStore((s) => s.space);
  const snapEnabled = useEditorStore((s) => s.snapEnabled);
  const moveSnap = useEditorStore((s) => s.moveSnap);
  const rotateSnap = useEditorStore((s) => s.rotateSnap);
  const canUndo = useEditorStore((s) => s.canUndo);
  const canRedo = useEditorStore((s) => s.canRedo);
  const playing = useEditorStore((s) => s.playing);
  const shading = useEditorStore((s) => s.shading);
  const setShading = useEditorStore((s) => s.setShading);
  const graphicsVisible = useEditorStore((s) => s.graphicsVisible);
  const setGraphicsVisible = useEditorStore((s) => s.setGraphicsVisible);
  const statusMessage = useEditorStore((s) => s.statusMessage);
  const setTool = useEditorStore((s) => s.setTool);
  const setSpace = useEditorStore((s) => s.setSpace);
  const setSnapEnabled = useEditorStore((s) => s.setSnapEnabled);
  const setSnapValues = useEditorStore((s) => s.setSnapValues);
  const setSelection = useEditorStore((s) => s.setSelection);
  const setStatusMessage = useEditorStore((s) => s.setStatusMessage);

  const status = (message: string) => {
    setStatusMessage(message);
    setTimeout(() => {
      if (useEditorStore.getState().statusMessage === message) setStatusMessage(null);
    }, 4000);
  };

  /**
   * Saving, loading and exporting are edit-mode operations.
   *
   * While playing, the Scene holds the *running* simulation — a zombie is wherever it wandered
   * to — and the authored version only exists in the Engine's play snapshot. Saving there would
   * autosave a scene nobody authored; loading or importing would be discarded outright, because
   * pressing Stop restores the snapshot taken before the load. Both are quiet data loss, so the
   * buttons say why they are off rather than doing something surprising.
   */
  const persistenceTitle = (title: string) =>
    playing ? `${title} — stop playing first, the scene is running` : title;

  const addPrimitive = (kind: PrimitiveKind) => {
    const command = new AddEntityCommand(
      engine.scene,
      createPrimitiveEntity(kind, { position: spawnPoint() }),
    );
    run(command);
    setSelection([command.entityId]);
  };

  /** Prefabs can be several entities — a Player brings its camera — so they add as a group. */
  const addPrefab = (kind: PrefabKind) => {
    const command = new AddEntitiesCommand(
      engine.scene,
      createPrefab(kind, { position: spawnPoint() }),
    );
    run(command);
    setSelection(command.rootIds);
  };

  const onSave = async () => {
    try {
      await saveScene(storage, engine.scene, AUTOSAVE_KEY);
      status('Scene saved to local storage.');
    } catch (error) {
      status((error as Error).message);
    }
  };

  const onLoad = async () => {
    try {
      const loaded = await loadScene(storage, engine.scene, AUTOSAVE_KEY);
      // History refers to entities that no longer exist after a load, so it has to go.
      history.clear();
      status(loaded ? 'Scene loaded.' : 'No saved scene found.');
    } catch (error) {
      status(`Load failed: ${(error as Error).message}`);
    }
  };

  const onImport = async (file: File) => {
    try {
      await importSceneFile(engine.scene, file);
      history.clear();
      status(`Imported ${file.name}.`);
    } catch (error) {
      status(`Import failed: ${(error as Error).message}`);
    }
  };

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        {TOOLS.map((entry) => (
          <button
            key={entry.tool}
            className={`tool-button ${tool === entry.tool ? 'active' : ''}`}
            title={entry.title}
            onClick={() => setTool(entry.tool)}
          >
            <span>{entry.label}</span>
            <span className="hint">{entry.hint}</span>
          </button>
        ))}
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <button
          onClick={() => setSpace(space === 'local' ? 'world' : 'local')}
          title="Toggle gizmo orientation between the object's own axes and world axes (X)"
        >
          {space === 'local' ? 'Local' : 'Global'}
        </button>
        <button
          className={snapEnabled ? 'active' : ''}
          onClick={() => setSnapEnabled(!snapEnabled)}
          title="Toggle grid and angle snapping"
        >
          Snap
        </button>
        <label title="Grid snap increment for Move">
          Grid
          <input
            type="number"
            min={0.001}
            step={0.1}
            value={moveSnap}
            onChange={(event) => setSnapValues({ moveSnap: Number(event.currentTarget.value) || 1 })}
          />
        </label>
        <label title="Angle snap increment for Rotate, in degrees">
          Angle
          <input
            type="number"
            min={1}
            step={1}
            value={rotateSnap}
            onChange={(event) =>
              setSnapValues({ rotateSnap: Number(event.currentTarget.value) || 15 })
            }
          />
        </label>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <select
          value=""
          onChange={(event) => {
            if (event.currentTarget.value) addPrimitive(event.currentTarget.value as PrimitiveKind);
            event.currentTarget.value = '';
          }}
          title="Create an object — a solid, or a flat 2D profile to extrude or lathe"
        >
          <option value="" disabled>
            Add ▾
          </option>
          <optgroup label="3D">
            {SOLID_MENU.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </optgroup>
          <optgroup label="2D">
            {SHAPE_MENU.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </optgroup>
        </select>
        <select
          value=""
          onChange={(event) => {
            if (event.currentTarget.value) addPrefab(event.currentTarget.value as PrefabKind);
            event.currentTarget.value = '';
          }}
          title="Create a gameplay object — character, camera, light, environment"
        >
          <option value="" disabled>
            Game ▾
          </option>
          {PREFAB_MENU.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <select
          value={shading}
          onChange={(event) => setShading(event.currentTarget.value as typeof shading)}
          title="Viewport shading — wireframe shows what the modifier stack did to the topology"
        >
          <option value="shaded">Shaded</option>
          <option value="shadedWireframe">Shaded + Wireframe</option>
          <option value="wireframe">Wireframe</option>
        </select>
        <button
          className={graphicsVisible ? 'active' : ''}
          onClick={() => setGraphicsVisible(!graphicsVisible)}
          title="Graphics settings — antialiasing, shadows, tone mapping, resolution (F7)"
        >
          Graphics
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <button onClick={() => history.undo()} disabled={!canUndo} title="Undo (Ctrl+Z)">
          ↶
        </button>
        <button onClick={() => history.redo()} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
          ↷
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <button
          onClick={onSave}
          disabled={playing}
          title={persistenceTitle('Save to browser local storage (Ctrl+S)')}
        >
          Save
        </button>
        <button
          onClick={onLoad}
          disabled={playing}
          title={persistenceTitle('Load from browser local storage')}
        >
          Load
        </button>
        <button
          onClick={() => exportSceneFile(engine.scene)}
          disabled={playing}
          title={persistenceTitle('Download scene as JSON')}
        >
          Export
        </button>
        <button
          onClick={() => fileInput.current?.click()}
          disabled={playing}
          title={persistenceTitle('Import a scene JSON file')}
        >
          Import
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void onImport(file);
            event.currentTarget.value = '';
          }}
        />
      </div>

      <div className="toolbar-spacer" />

      {statusMessage && <span className="status">{statusMessage}</span>}

      <div className="toolbar-group">
        <button
          className={playing ? 'active' : ''}
          onClick={() => engine.setMode(playing ? 'edit' : 'play')}
          title="Run scripts, NPCs and the character controller through the scene's own camera. The scene is snapshotted and restored on stop. Esc stops."
        >
          {playing ? '■ Stop' : '▶ Play'}
        </button>
      </div>
    </div>
  );
}
