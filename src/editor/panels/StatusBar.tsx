import { useEffect, useState } from 'react';
import { useEditor } from '../EditorContext';
import { isPanelVisible, useEditorStore } from '../state/editorStore';
import { DOCK_ORDER, DOCK_PANELS, PANELS } from '../state/layout';
import type { ViewportController } from '../viewport/ViewportController';

/** Slow enough not to matter, fast enough that the number feels live. */
const FPS_REFRESH_MS = 500;

/**
 * Every panel, in dock order — derived, not listed.
 *
 * This used to be a hand-written array beside the one in `layout.ts`, which made §14.2's claim
 * that "adding a panel is one entry plus a render case" quietly false: a new panel appeared in
 * its tab strip and under its function key, and was missing from the one row whose whole job is
 * to be the index of what exists.
 */
const TOGGLES = DOCK_ORDER.flatMap((dock) => DOCK_PANELS[dock]);

interface Props {
  viewport: ViewportController | null;
}

/**
 * The bottom strip: what is open, what is selected, and how fast it is running.
 *
 * This replaces the buttons that used to be scattered along the canvas edge — Console at
 * `left: 10px`, Hardware at `left: 96px`, Assistant at `right: 10px`, on top of the viewport
 * hint and each other, with the Performance HUD reachable only by knowing that F8 existed.
 * Every panel is now one click from the same row, in the same order as the docks, and a panel
 * with nothing to show is dim rather than absent.
 *
 * The frame rate lives here too. It was previously inside the Performance panel, which meant
 * the cheapest question in the editor — "is this still running at speed?" — cost opening a
 * panel that covered the thing you were asking about.
 */
export function StatusBar({ viewport }: Props) {
  const { engine } = useEditor();
  const layout = useEditorStore((s) => s.layout);
  const togglePanel = useEditorStore((s) => s.togglePanel);
  const selection = useEditorStore((s) => s.selection);
  const sceneRevision = useEditorStore((s) => s.sceneRevision);
  const playing = useEditorStore((s) => s.playing);
  const paused = useEditorStore((s) => s.paused);
  const timeScale = useEditorStore((s) => s.timeScale);
  const statusMessage = useEditorStore((s) => s.statusMessage);
  const errors = useEditorStore(
    (s) => s.consoleMessages.filter((m) => m.level === 'error').length,
  );

  const hudVisible = useEditorStore((s) => s.hudVisible);
  const toggleHud = useEditorStore((s) => s.toggleHud);
  const [fps, setFps] = useState(0);
  const [low1, setLow1] = useState(0);

  useEffect(() => {
    if (!viewport) return;
    const timer = setInterval(() => {
      const report = viewport.frameReport();
      setFps(report.fps);
      setLow1(report.low1Fps);
    }, FPS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [viewport]);

  void sceneRevision; // The entity count is derived from the scene, not from the store.
  const entities = engine.scene.size;
  // Coloured against 30fps, the floor the engine targets — a green 45 is a pass, not a
  // near-miss. Same thresholds the Performance panel uses, so the two never disagree.
  const fpsClass = fps >= 55 ? 'good' : fps >= 30 ? 'ok' : 'bad';

  return (
    <footer className="status-bar">
      <div className="status-toggles">
        {TOGGLES.map((id) => {
          const panel = PANELS[id];
          const open = isPanelVisible(layout, id);
          return (
            <button
              key={id}
              className={`status-toggle ${open ? 'active' : ''}`}
              aria-pressed={open}
              title={panel.title}
              onClick={() => togglePanel(id)}
            >
              <span className="status-toggle-icon">{panel.icon}</span>
              <span className="status-toggle-label">{panel.label}</span>
              {id === 'console' && errors > 0 && <span className="badge badge-error">{errors}</span>}
            </button>
          );
        })}
      </div>

      <div className="status-message" role="status">
        {statusMessage}
      </div>

      <div className="status-readouts">
        {/*
          One chip for the whole clock, because "playing", "paused" and "at a fifth speed" are
          three states of one thing and three chips for them would leave the reader assembling
          the sentence. A frame rate that looks wrong is almost always a time scale nobody
          remembered setting, so the scale is shown wherever it is not 1.
        */}
        {playing && (
          <span className={`status-chip playing ${paused ? 'paused' : ''}`}>
            {paused ? '❚❚ Paused' : '▶ Playing'}
            {timeScale !== 1 && ` · ${timeScale}×`}
          </span>
        )}
        <span className="status-chip" title="Objects in the scene">
          {entities} obj
        </span>
        <span className="status-chip" title="Selected objects">
          {selection.length} sel
        </span>
        <button
          className={`status-chip fps ${fpsClass} ${hudVisible ? 'active' : ''}`}
          aria-pressed={hudVisible}
          title={`Frames per second — 1% low ${low1.toFixed(0)}. Click for the viewport overlay.`}
          onClick={toggleHud}
        >
          {fps.toFixed(0)} fps
        </button>
      </div>
    </footer>
  );
}
