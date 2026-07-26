import { useEffect, useRef } from 'react';
import { useEditor } from '../EditorContext';
import { useEditorStore } from '../state/editorStore';
import { ViewportController } from './ViewportController';

interface Props {
  onReady(controller: ViewportController): void;
}

/**
 * Thin React host for the canvas. Everything inside the canvas is imperative — React owns the
 * DOM panels around it and never the render loop, which is what keeps a re-render from
 * costing a frame.
 */
export function Viewport({ onReady }: Props) {
  const { engine, history } = useEditor();
  const containerRef = useRef<HTMLDivElement>(null);
  const playing = useEditorStore((s) => s.playing);
  const dragReadout = useEditorStore((s) => s.dragReadout);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const controller = new ViewportController(container, engine, history);
    onReady(controller);
    return () => controller.dispose();
    // Intentionally mount-only: rebuilding this would drop the WebGL context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="viewport" ref={containerRef}>
      {playing && (
        <div className="play-banner">
          Play mode — gameplay systems land in Phase 3. Scene restores on stop.
        </div>
      )}
      {/* Live numbers while a handle is held, so a drag is as precise as typing. */}
      {dragReadout && <div className="drag-readout">{dragReadout}</div>}
      <div className="viewport-hint">
        Orbit: drag &nbsp;·&nbsp; Pan: middle / right drag &nbsp;·&nbsp; Zoom: scroll &nbsp;·&nbsp; Focus: F
        &nbsp;·&nbsp; Esc cancels a drag
      </div>
    </div>
  );
}
