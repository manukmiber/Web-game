import { useEffect, useState } from 'react';
import type { FrameReport } from '@engine/perf/FrameStats';
import { useEditorStore } from '../state/editorStore';
import { FrameGraph } from './FrameGraph';
import type { ViewportController } from '../viewport/ViewportController';

/** Four times a second. Fast enough to feel live, slow enough not to distort what it measures. */
const REFRESH_MS = 250;

interface Props {
  viewport: ViewportController | null;
}

/**
 * The frame readout, over the viewport.
 *
 * v0.7.4 moved every panel off the canvas and into docks, on the argument that a 3D editor whose
 * UI covers the 3D is answering the wrong question. This is the deliberate exception, and the
 * reason is Play mode: the one moment you most need to know the frame rate is while you are
 * playing, and that is exactly when a bottom dock is either closed or covering the game. A
 * corner overlay is what every engine ships for this, and it is opt-in — off by default, toggled
 * from the fps chip in the status bar.
 *
 * It shows what a frame *feels* like rather than what it averages: the median, the 1% low, and
 * the trace. A single averaged number is the one statistic that cannot tell a smooth run from a
 * stuttering one.
 */
export function FpsOverlay({ viewport }: Props) {
  const visible = useEditorStore((s) => s.hudVisible);
  const playing = useEditorStore((s) => s.playing);
  const [report, setReport] = useState<FrameReport | null>(null);

  useEffect(() => {
    if (!viewport || !visible) return;
    const sample = () => setReport(viewport.frameReport());
    sample();
    const timer = setInterval(sample, REFRESH_MS);
    return () => clearInterval(timer);
  }, [viewport, visible]);

  if (!visible || !report) return null;

  const fpsClass = report.fps >= 55 ? 'good' : report.fps >= 30 ? 'ok' : 'bad';
  const lowClass = report.low1Fps >= 48 ? 'good' : report.low1Fps >= 28 ? 'ok' : 'bad';
  // Only the systems, not the render submit — in edit mode there are none, and a breakdown of
  // an empty list is a heading with nothing under it.
  const worstSection = report.sections[0];

  return (
    <div className="fps-overlay" role="status" aria-label="Frame rate">
      <div className="fps-overlay-head">
        <span className={`fps-overlay-fps ${fpsClass}`}>{report.fps.toFixed(0)}</span>
        <span className="fps-overlay-unit">fps</span>
        <span className={`fps-overlay-low ${lowClass}`} title="Average of the slowest 1% of frames">
          {report.low1Fps.toFixed(0)} low
        </span>
      </div>

      <FrameGraph history={report.history} height={32} />

      <dl className="fps-overlay-rows">
        <div>
          <dt>frame</dt>
          <dd>{report.medianMs.toFixed(1)} ms</dd>
        </div>
        <div>
          <dt>p95</dt>
          <dd>{report.p95Ms.toFixed(1)} ms</dd>
        </div>
        <div>
          <dt>js</dt>
          <dd>{report.medianJsMs.toFixed(1)} ms</dd>
        </div>
        <div>
          <dt>draws</dt>
          <dd>{report.drawCalls.toLocaleString()}</dd>
        </div>
        <div>
          <dt>tris</dt>
          <dd>{compact(report.triangles)}</dd>
        </div>
        <div>
          <dt>hitches</dt>
          <dd>{report.stutterCount}</dd>
        </div>
        {playing && worstSection && (
          <div title="Slowest system this frame">
            <dt>{worstSection.name.replace(/System$/, '').toLowerCase()}</dt>
            <dd>{worstSection.medianMs.toFixed(2)} ms</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}
