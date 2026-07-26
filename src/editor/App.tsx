import { useCallback, useEffect, useState } from 'react';
import { createStarterScene } from '@engine/scene/prefabs';
import { EditorProvider, useEditor } from './EditorContext';
import { Console } from './panels/Console';
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
  const { engine, storage } = useEditor();
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

  return (
    <div className="editor">
      <Toolbar spawnPoint={spawnPoint} />
      <div className="editor-body">
        <Hierarchy />
        <div className="viewport-host">
          <Viewport onReady={setViewport} />
          <PerfHud viewport={viewport} />
          <Console />
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
