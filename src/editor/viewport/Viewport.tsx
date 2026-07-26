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
          Play mode — WASD move &nbsp;·&nbsp; ←/→ turn &nbsp;·&nbsp; Shift run &nbsp;·&nbsp; Esc
          stops and restores the scene
        </div>
      )}
      <div className="viewport-hint">
        {playing
          ? 'Editor tools are paused while playing'
          : 'Orbit: drag · Pan: middle / right drag · Zoom: scroll · Focus: F'}
      </div>
    </div>
  );
}
