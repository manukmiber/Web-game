import { useEffect, useRef, useState } from 'react';
import type { FrameReport } from '@engine/perf/FrameStats';
import { CITY_PRESET, FOREST_PRESET, type StressStats } from '@engine/perf/StressScene';
import {
  ANTIALIAS_LABELS,
  ANTIALIAS_MODES,
  SHADOW_QUALITIES,
  shadowMapSizeFor,
  type AntialiasMode,
  type ShadowQuality,
} from '@engine/render/GraphicsSettings';
import { useEditorStore } from '../state/editorStore';
import type { ViewportController } from '../viewport/ViewportController';

/**
 * How often the readout refreshes. Deliberately not per frame: re-rendering React sixty times
 * a second to display a frame counter would itself distort the number being displayed.
 */
const REFRESH_MS = 250;

interface Props {
  viewport: ViewportController | null;
}

/**
 * Performance readout and the manual quality levers.
 *
 * This is the instrument that turns "will 25 km run?" into a table of numbers. Open it, pick a
 * stress preset, and move one slider at a time until the frame budget breaks — on the actual
 * target device, not on a developer desktop.
 */
export function PerfHud({ viewport }: Props) {
  const perf = useEditorStore((s) => s.perf);
  const setPerf = useEditorStore((s) => s.setPerf);
  const graphics = useEditorStore((s) => s.graphics);
  const setGraphics = useEditorStore((s) => s.setGraphics);
  const setGraphicsVisible = useEditorStore((s) => s.setGraphicsVisible);
  const [report, setReport] = useState<FrameReport | null>(null);
  const [stress, setStress] = useState<StressStats | null>(null);
  const [scatter, setScatter] = useState({ instances: 0, drawCalls: 0 });
  const lastPreset = useRef<string>('');

  // Poll rather than subscribe: the stats live inside the render loop, outside React.
  useEffect(() => {
    if (!viewport || !perf.hudVisible) return;
    const timer = setInterval(() => {
      setReport(viewport.frameReport());
      setStress(viewport.stressStats());
      setScatter(viewport.scatterStats());
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [viewport, perf.hudVisible]);

  // Rebuild the stress scene whenever a generation parameter changes.
  useEffect(() => {
    if (!viewport) return;
    const key = [
      perf.stressPreset,
      perf.density,
      perf.uniqueMeshes,
      perf.instanced,
      perf.renderDistance,
    ].join('|');
    if (key === lastPreset.current) return;
    lastPreset.current = key;
    viewport.setStressScene(perf.stressPreset, {
      density: perf.density,
      uniqueMeshes: perf.uniqueMeshes,
      instanced: perf.instanced,
      renderDistance: perf.renderDistance,
    });
  }, [
    viewport,
    perf.stressPreset,
    perf.density,
    perf.uniqueMeshes,
    perf.instanced,
    perf.renderDistance,
  ]);

  /**
   * Switching preset loads that preset's whole parameter set, not just its geometry style.
   *
   * The two presets differ mainly in density, mesh variety and whether they instance — which
   * is the entire point of having both. Carrying the previous preset's numbers across would
   * quietly measure a forest wearing city geometry, and the readout would look identical.
   */
  const selectPreset = (next: typeof perf.stressPreset) => {
    if (next === 'off') {
      setPerf({ stressPreset: 'off' });
      return;
    }
    const source = next === 'city' ? CITY_PRESET : FOREST_PRESET;
    setPerf({
      stressPreset: next,
      density: source.density,
      uniqueMeshes: source.uniqueMeshes,
      instanced: source.instanced,
      renderDistance: source.renderDistance,
    });
  };

  if (!perf.hudVisible) return null;

  const fps = report?.fps ?? 0;
  // 30fps is the floor the engine targets, so the readout is coloured against it rather than
  // against 60 — a green 45fps is a pass, not a near-miss.
  const fpsClass = fps >= 55 ? 'good' : fps >= 30 ? 'ok' : 'bad';

  return (
    <div className="perf-hud">
      <div className="perf-hud-header">
        <span>Performance</span>
        <button onClick={() => setPerf({ hudVisible: false })} title="Close (F8)">
          ✕
        </button>
      </div>

      <div className="perf-readout">
        <Metric label="FPS" value={fps.toFixed(0)} className={fpsClass} />
        <Metric label="median" value={`${(report?.medianMs ?? 0).toFixed(1)} ms`} />
        <Metric
          label="p95"
          value={`${(report?.p95Ms ?? 0).toFixed(1)} ms`}
          title="95th-percentile frame time — this is what stutter feels like, and a mean hides it"
        />
        <Metric label="worst" value={`${(report?.worstMs ?? 0).toFixed(1)} ms`} />
        <Metric
          label="js"
          value={`${(report?.medianJsMs ?? 0).toFixed(1)} ms`}
          title="JavaScript time per frame: systems, scripts and draw-call submission. The rest of the frame is spent waiting on the GPU."
        />
        <Metric
          label="submit"
          value={`${(report?.medianSubmitMs ?? 0).toFixed(1)} ms`}
          title="CPU cost of issuing draw calls. Not GPU time — that cannot be measured synchronously from JavaScript."
        />
        <Metric label="draws" value={String(report?.drawCalls ?? 0)} />
        <Metric label="tris" value={compact(report?.triangles ?? 0)} />
        <Metric label="geom" value={String(report?.geometries ?? 0)} />
        <Metric label="tex" value={String(report?.textures ?? 0)} />
        {scatter.instances > 0 && (
          <Metric
            label="scatter"
            value={compact(scatter.instances)}
            title={`Instances across ${scatter.drawCalls} scatter draw ${
              scatter.drawCalls === 1 ? 'call' : 'calls'
            }. This is the number the draw count would be without instancing.`}
          />
        )}
      </div>

      {report && report.bound !== 'unknown' && (
        <div className="perf-note">
          {report.bound === 'cpu' ? (
            <>
              <b>CPU bound</b> — {Math.round(report.jsShare * 100)}% of the frame is JavaScript.
              Fewer draw calls, less per-frame work.
            </>
          ) : (
            <>
              <b>GPU bound</b> — only {Math.round(report.jsShare * 100)}% of the frame is
              JavaScript. Resolution scale, overdraw and shader cost are the levers.
            </>
          )}
        </div>
      )}

      <div className="perf-section">Stress scene</div>
      <div className="perf-controls">
        <Row label="Preset">
          <select
            value={perf.stressPreset}
            onChange={(e) => selectPreset(e.currentTarget.value as typeof perf.stressPreset)}
          >
            <option value="off">Off</option>
            <option value="forest">Forest — many instances, few meshes</option>
            <option value="city">City — many unique meshes</option>
          </select>
        </Row>

        {perf.stressPreset !== 'off' && (
          <>
            <Slider
              label="Density"
              value={perf.density}
              min={0.05}
              max={4}
              step={0.05}
              format={(v) => `${v.toFixed(2)}/100m²`}
              onChange={(density) => setPerf({ density })}
            />
            <Slider
              label="Unique meshes"
              value={perf.uniqueMeshes}
              min={1}
              max={300}
              step={1}
              format={(v) => String(v)}
              onChange={(uniqueMeshes) => setPerf({ uniqueMeshes })}
            />
            <Slider
              label="Render distance"
              value={perf.renderDistance}
              min={50}
              max={800}
              step={10}
              format={(v) => `${v} m`}
              onChange={(renderDistance) => setPerf({ renderDistance })}
            />
            <Row label="Instanced">
              <input
                type="checkbox"
                checked={perf.instanced}
                onChange={(e) => setPerf({ instanced: e.currentTarget.checked })}
              />
            </Row>
            {stress && (
              <div className="perf-note">
                {stress.objects.toLocaleString()} objects · {stress.uniqueGeometries} prototypes ·{' '}
                {compact(stress.triangles)} tris · ~{stress.expectedDrawCalls.toLocaleString()}{' '}
                draws before culling
              </div>
            )}
          </>
        )}
      </div>

      {/*
        The two levers that move the frame time most, kept beside the readout so a measurement
        and the change that caused it are in the same glance. Everything else lives in the
        Graphics panel — these write the same settings, so the two never disagree.
      */}
      <div className="perf-section">Quality levers</div>
      <div className="perf-controls">
        <Slider
          label="Resolution"
          value={graphics.resolutionScale}
          min={0.25}
          max={1}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(resolutionScale) => setGraphics({ resolutionScale })}
        />
        <Row label="Shadows">
          <select
            value={graphics.shadowQuality}
            onChange={(e) =>
              setGraphics({ shadowQuality: e.currentTarget.value as ShadowQuality })
            }
          >
            {SHADOW_QUALITIES.map((quality) => (
              <option key={quality} value={quality}>
                {quality === 'off' ? 'Off' : `${quality} — ${shadowMapSizeFor(quality)}`}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Antialiasing">
          <select
            value={graphics.antialias}
            onChange={(e) => setGraphics({ antialias: e.currentTarget.value as AntialiasMode })}
          >
            {ANTIALIAS_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {ANTIALIAS_LABELS[mode]}
              </option>
            ))}
          </select>
        </Row>
        <button onClick={() => setGraphicsVisible(true)}>All graphics settings (F7)</button>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  className,
  title,
}: {
  label: string;
  value: string;
  className?: string;
  title?: string;
}) {
  return (
    <div className="perf-metric" title={title}>
      <span className="perf-metric-label">{label}</span>
      <span className={`perf-metric-value ${className ?? ''}`}>{value}</span>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="perf-row">
      <label>{label}</label>
      {children}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format(value: number): string;
  onChange(value: number): void;
}) {
  return (
    <div className="perf-row">
      <label>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
      <span className="perf-row-value">{format(value)}</span>
    </div>
  );
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}
