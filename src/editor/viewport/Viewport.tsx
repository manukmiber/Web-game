import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../EditorContext';
import { hasTouchInput } from '../dom';
import { TouchControls } from '../panels/TouchControls';
import { useEditorStore, type ViewMode } from '../state/editorStore';
import { ViewportController } from './ViewportController';

interface Props {
  onReady(controller: ViewportController): void;
}

/**
 * Thin React host for the canvas. Everything inside the canvas is imperative — React owns the
 * DOM panels around it and never the render loop, which is what keeps a re-render from
 * costing a frame.
 */
/**
 * What the corner of the viewport says you can do right now.
 *
 * Kept as a function rather than a nested ternary because there are three axes to it — playing,
 * projection, pointer kind — and the 2D view genuinely offers a different set of gestures: there
 * is no orbit to describe, and dragging pans instead of turning.
 */
function hintFor(playing: boolean, viewMode: ViewMode, touch: boolean): string {
  if (playing) return 'Editor tools are paused while playing';
  if (viewMode === '2D') {
    return touch
      ? 'Top-down 2D · Pan: drag · Zoom: pinch · Select: tap'
      : 'Top-down 2D · Pan: drag · Zoom: scroll · Focus: F · Back to 3D: 3';
  }
  return touch
    ? 'Orbit: one finger · Pan & zoom: two fingers · Select: tap'
    : 'Orbit: drag · Pan: middle / right drag · Zoom: scroll · Focus: F · 2D: 2';
}

export function Viewport({ onReady }: Props) {
  const { engine, history } = useEditor();
  const containerRef = useRef<HTMLDivElement>(null);
  const playing = useEditorStore((s) => s.playing);
  const viewMode = useEditorStore((s) => s.viewMode);
  // Read once. Whether the device has a touch screen does not change while the tab is open, and
  // re-checking it on every render would be a media query per frame.
  const [touch] = useState(hasTouchInput);

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
          {touch
            ? 'Play mode — left pad moves · right pad turns · Stop on the toolbar to restore the scene'
            : 'Play mode — WASD move  ·  click to look with the mouse  ·  Shift run  ·  ' +
              'Esc frees the mouse, then stops'}
        </div>
      )}
      {/*
        The hint is the only thing left drawn over the canvas, and it now has the corner to
        itself — the Console, Hardware and Assistant toggles used to sit on the same 8px of
        viewport edge, overlapping it and each other.
      */}
      <div className="viewport-hint">{hintFor(playing, viewMode, touch)}</div>
      {/*
        Drawn over the canvas like the hint, and for the same reason: on a phone there is no
        keyboard, so without these Play mode is a scene you can look at and not move through.
      */}
      {touch && <TouchControls input={engine.input} playing={playing} />}
    </div>
  );
}
