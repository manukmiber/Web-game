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
import { Group, Row, Slider } from './controls';
import { FrameGraph } from './FrameGraph';
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
 *
 * In v0.7.4 it moved out of the corner of the viewport and into the bottom dock, which is the
 * arrangement its content always wanted: the metrics are a table, and a table in a 300px
 * floating box is ten rows of two columns that you scroll. Here it is one row of tiles, read at
 * a glance, next to the scene it is measuring rather than on top of it.
 *
 * The polling only runs while this is the frontmost tab — the dock unmounts the others — so an
 * open bottom dock costs nothing when you are looking at something else.
 */
export function PerformancePanel({ viewport }: Props) {
  const perf = useEditorStore((s) => s.perf);
  const setPerf = useEditorStore((s) => s.setPerf);
  const graphics = useEditorStore((s) => s.graphics);
  const setGraphics = useEditorStore((s) => s.setGraphics);
  const showPanel = useEditorStore((s) => s.showPanel);
  const [report, setReport] = useState<FrameReport | null>(null);
  const [stress, setStress] = useState<StressStats | null>(null);
  const [scatter, setScatter] = useState({ instances: 0, drawCalls: 0 });
  const [schedule, setSchedule] = useState<{ name: string; stage: string; modes: string }[]>([]);
  const lastPreset = useRef<string>('');

  // Poll rather than subscribe: the stats live inside the render loop, outside React.
  useEffect(() => {
    if (!viewport) return;
    const timer = setInterval(() => {
      setReport(viewport.frameReport());
      setStress(viewport.stressStats());
      setScatter(viewport.scatterStats());
      setSchedule(viewport.systemSchedule());
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [viewport]);

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

  const fps = report?.fps ?? 0;
  // 30fps is the floor the engine targets, so the readout is coloured against it rather than
  // against 60 — a green 45fps is a pass, not a near-miss.
  const fpsClass = fps >= 55 ? 'good' : fps >= 30 ? 'ok' : 'bad';
  const low1 = report?.low1Fps ?? 0;
  // The 1% low is graded harder than the average, because that is the whole point of it: a
  // scene whose worst percent drops to 35 fps stutters, even though 35 would be a fine average.
  const lowClass = low1 >= 48 ? 'good' : low1 >= 28 ? 'ok' : 'bad';

  return (
    <div className="panel-content">
      <div className="metric-strip">
        <Metric label="fps" value={fps.toFixed(0)} className={fpsClass} large />
        <Metric
          label="1% low"
          value={low1.toFixed(0)}
          className={lowClass}
          large
          title="Average of the slowest 1% of frames, as fps. The number that decides whether a run feels smooth — an average never will."
        />
        <Metric
          label="0.1% low"
          value={(report?.low01Fps ?? 0).toFixed(0)}
          title="Slowest one frame in a thousand. Where the true hitches live."
        />
        <Metric
          label="avg"
          value={(report?.averageFps ?? 0).toFixed(0)}
          title="Mean frame rate. Above the median when the run is spiky, which is exactly why it is not the headline."
        />
        <Metric label="median" value={`${(report?.medianMs ?? 0).toFixed(1)} ms`} />
        <Metric
          label="p95"
          value={`${(report?.p95Ms ?? 0).toFixed(1)} ms`}
          title="95th-percentile frame time — this is what stutter feels like, and a mean hides it"
        />
        <Metric
          label="p99"
          value={`${(report?.p99Ms ?? 0).toFixed(1)} ms`}
          title="99th-percentile frame time"
        />
        <Metric label="worst" value={`${(report?.worstMs ?? 0).toFixed(1)} ms`} />
        <Metric
          label="hitches"
          value={String(report?.stutterCount ?? 0)}
          className={(report?.stutterCount ?? 0) > 0 ? 'ok' : undefined}
          title="Frames at least twice the median, or 8 ms over it — the ones you can feel. Counted across the sample window."
        />
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

      {report && report.history.length > 0 && <FrameGraph history={report.history} />}

      {report && report.bound !== 'unknown' && (
        <div className={`verdict ${report.bound}`}>
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

      <div className="panel-scroll panel-columns">
        {/*
          Where the JavaScript half of the frame actually goes. Before v0.7.5 the panel could
          say "11 ms of this 14 ms frame is JavaScript" and stop there, which left bisecting by
          commenting systems out as the only way to find the other half of the answer.
        */}
        {report && report.sections.length > 0 && (
          <Group title="Frame breakdown">
            {report.sections.map((section) => (
              <div className="control-row section-row" key={section.name}>
                <label>{section.name.replace(/System$/, '')}</label>
                <span className="section-bar">
                  <span
                    className="section-fill"
                    style={{ width: `${Math.min(100, section.share * 100)}%` }}
                  />
                </span>
                <span className="control-value" title={`worst ${section.worstMs.toFixed(2)} ms`}>
                  {section.medianMs.toFixed(2)} ms
                </span>
              </div>
            ))}
            <p className="note">
              Median per system, worst first. Systems only tick in Play mode, so this is empty
              until you press Play.
            </p>
          </Group>
        )}

        {/*
          The frame breakdown above is sorted by cost; this is sorted by *time*, which answers a
          different question. Since v0.7.6 the order is computed from each system's stage and its
          declared dependencies rather than from the order someone called `addSystem`, and a
          computed order needs to be readable or it is worse than a hand-written one.
        */}
        {schedule.length > 0 && (
          <Group title="Schedule">
            {schedule.map((system, index) => (
              <div className="control-row section-row" key={system.name}>
                <label>
                  {index + 1}. {system.name.replace(/System$/, '')}
                </label>
                <span className="control-value" title={`Ticks in ${system.modes} mode`}>
                  {system.stage}
                </span>
              </div>
            ))}
            <p className="note">
              Tick order, resolved from each system&rsquo;s stage and its declared dependencies.
            </p>
          </Group>
        )}

        <Group title="Stress scene">
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
                <p className="note">
                  {stress.objects.toLocaleString()} objects · {stress.uniqueGeometries} prototypes ·{' '}
                  {compact(stress.triangles)} tris · ~{stress.expectedDrawCalls.toLocaleString()}{' '}
                  draws before culling
                </p>
              )}
            </>
          )}
        </Group>

        {/*
          The two levers that move the frame time most, kept beside the readout so a measurement
          and the change that caused it are in the same glance. Everything else lives in the
          Graphics panel — these write the same settings, so the two never disagree.
        */}
        <Group title="Quality levers">
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
              onChange={(e) => setGraphics({ shadowQuality: e.currentTarget.value as ShadowQuality })}
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
          <button onClick={() => showPanel('graphics')}>All graphics settings (F7)</button>
        </Group>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  className,
  title,
  large,
}: {
  label: string;
  value: string;
  className?: string;
  title?: string;
  large?: boolean;
}) {
  return (
    <div className={`metric ${large ? 'large' : ''}`} title={title}>
      <span className="metric-label">{label}</span>
      <span className={`metric-value ${className ?? ''}`}>{value}</span>
    </div>
  );
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}
