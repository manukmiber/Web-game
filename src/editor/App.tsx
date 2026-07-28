import { useCallback, useEffect, useState } from 'react';
import { createStarterScene } from '@engine/scene/prefabs';
import { EditorProvider, useEditor } from './EditorContext';
import { AssistantPanel } from './panels/AssistantPanel';
import { Console } from './panels/Console';
import { GraphicsPanel } from './panels/GraphicsPanel';
import { HardwarePanel } from './panels/HardwarePanel';
import { Hierarchy } from './panels/Hierarchy';
import { Inspector } from './panels/Inspector';
import { PerfHud } from './panels/PerfHud';
import { Toolbar } from './panels/Toolbar';
import { Viewport } from './viewport/Viewport';
import type { ViewportController } from './viewport/ViewportController';
import { useShortcuts } from './useShortcuts';
import { AUTOSAVE_KEY, loadScene } from './state/persistence';
import './styles/theme.css';

function EditorShell() {
  const { engine, storage, setSpawnPoint } = useEditor();
  const [viewport, setViewport] = useState<ViewportController | null>(null);
  useShortcuts(viewport);

  // Restore the last session, or seed a starter scene so the viewport is never blank.
  useEffect(() => {
    let cancelled = false;
    void loadScene(storage, engine.scene, AUTOSAVE_KEY)
      .catch(() => false)
      .then((restored) => {
        if (cancelled || restored || engine.scene.size > 0) return;
        // A playable scene rather than two grey primitives: press Play and the character
        // walks, the camera follows and the zombies notice. Everything this version added is
        // invisible until something in the scene uses it.
        for (const entity of createStarterScene()) engine.scene.add(entity);
      });
    return () => {
      cancelled = true;
    };
  }, [engine, storage]);

  const spawnPoint = useCallback(
    (): [number, number, number] => viewport?.spawnPoint() ?? [0, 0, 0],
    [viewport],
  );

  // The assistant and any attached MCP client place objects the same way the Add menu does:
  // where the camera is looking, not at the world origin.
  useEffect(() => setSpawnPoint(spawnPoint), [setSpawnPoint, spawnPoint]);

  return (
    <div className="editor">
      <Toolbar spawnPoint={spawnPoint} />
      <div className="editor-body">
        <Hierarchy />
        <div className="viewport-host">
          <Viewport onReady={setViewport} />
          <PerfHud viewport={viewport} />
          <GraphicsPanel />
          <Console />
          <HardwarePanel />
          <AssistantPanel />
        </div>
        <Inspector />
      </div>
    </div>
  );
}

export function App() {
  return (
    <EditorProvider>
      <EditorShell />
    </EditorProvider>
  );
}
