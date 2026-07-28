import { useCallback, useEffect, useState } from 'react';
import { createStarterScene } from '@engine/scene/prefabs';
import { EditorProvider, useEditor } from './EditorContext';
import { Dock } from './layout/Dock';
import { Splitter } from './layout/Splitter';
import { AssistantPanel } from './panels/AssistantPanel';
import { Console } from './panels/Console';
import { GraphicsPanel } from './panels/GraphicsPanel';
import { HardwarePanel } from './panels/HardwarePanel';
import { Hierarchy } from './panels/Hierarchy';
import { Inspector } from './panels/Inspector';
import { PerformancePanel } from './panels/PerformancePanel';
import { StatusBar } from './panels/StatusBar';
import { Toolbar } from './panels/Toolbar';
import { Viewport } from './viewport/Viewport';
import type { ViewportController } from './viewport/ViewportController';
import { useShortcuts } from './useShortcuts';
import { useEditorStore } from './state/editorStore';
import type { PanelId } from './state/layout';
import { AUTOSAVE_KEY, loadScene } from './state/persistence';
import './styles/theme.css';

/**
 * The editor shell.
 *
 * Three docks around a viewport, and nothing floating over the canvas. Every panel takes space
 * from the viewport rather than covering it, which is the whole of the v0.7.4 revamp: the
 * previous shell had the Hierarchy and Inspector docked and the other five panels absolutely
 * positioned on top of the render, where they overlapped each other and hid the thing being
 * edited. A 3D editor whose UI covers the 3D is answering the wrong question.
 *
 * The grid is declared here rather than in CSS variables set from JS, so the layout is one
 * readable expression: `[left] [split] [viewport] [split] [right]`, with the bottom dock
 * spanning the viewport column only — docks that run the full width would push the Hierarchy
 * and Inspector up off the screen for a panel neither of them relates to.
 */
function EditorShell() {
  const { engine, storage, setSpawnPoint } = useEditor();
  const [viewport, setViewport] = useState<ViewportController | null>(null);
  const layout = useEditorStore((s) => s.layout);
  const setLayout = useEditorStore((s) => s.setLayout);
  const refitLayout = useEditorStore((s) => s.refitLayout);
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

  // A layout saved on a wide monitor has to survive being opened on a laptop, and a window
  // dragged between the two has to keep a usable viewport on the way.
  useEffect(() => {
    window.addEventListener('resize', refitLayout);
    return () => window.removeEventListener('resize', refitLayout);
  }, [refitLayout]);

  const spawnPoint = useCallback(
    (): [number, number, number] => viewport?.spawnPoint() ?? [0, 0, 0],
    [viewport],
  );

  // The assistant and any attached MCP client place objects the same way the Add menu does:
  // where the camera is looking, not at the world origin.
  useEffect(() => setSpawnPoint(spawnPoint), [setSpawnPoint, spawnPoint]);

  const columns = [
    layout.leftOpen ? `${layout.leftWidth}px auto` : '',
    'minmax(0, 1fr)',
    layout.rightOpen ? `auto ${layout.rightWidth}px` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="editor">
      <Toolbar spawnPoint={spawnPoint} />

      <div className="editor-body" style={{ gridTemplateColumns: columns }}>
        {layout.leftOpen && (
          <>
            <Dock dock="left">{() => <Hierarchy />}</Dock>
            <Splitter
              axis="x"
              size={layout.leftWidth}
              onResize={(leftWidth) => setLayout({ leftWidth })}
              label="Hierarchy width"
            />
          </>
        )}

        <div className="viewport-column">
          <div className="viewport-host">
            <Viewport onReady={setViewport} />
          </div>
          {layout.bottomOpen && (
            <>
              <Splitter
                axis="y"
                invert
                size={layout.bottomHeight}
                onResize={(bottomHeight) => setLayout({ bottomHeight })}
                label="Bottom dock height"
              />
              <div className="bottom-dock-host" style={{ height: layout.bottomHeight }}>
                <Dock dock="bottom">
                  {(panel) => <BottomPanel panel={panel} viewport={viewport} />}
                </Dock>
              </div>
            </>
          )}
        </div>

        {layout.rightOpen && (
          <>
            <Splitter
              axis="x"
              invert
              size={layout.rightWidth}
              onResize={(rightWidth) => setLayout({ rightWidth })}
              label="Inspector width"
            />
            <Dock dock="right">
              {(panel) => (panel === 'assistant' ? <AssistantPanel /> : <Inspector />)}
            </Dock>
          </>
        )}
      </div>

      <StatusBar viewport={viewport} />
    </div>
  );
}

function BottomPanel({ panel, viewport }: { panel: PanelId; viewport: ViewportController | null }) {
  switch (panel) {
    case 'performance':
      return <PerformancePanel viewport={viewport} />;
    case 'graphics':
      return <GraphicsPanel />;
    case 'hardware':
      return <HardwarePanel />;
    default:
      return <Console />;
  }
}

export function App() {
  return (
    <EditorProvider>
      <EditorShell />
    </EditorProvider>
  );
}
