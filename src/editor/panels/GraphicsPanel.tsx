import {
  ANTIALIAS_LABELS,
  ANTIALIAS_MODES,
  SHADOW_FILTERS,
  SHADOW_FILTER_LABELS,
  SHADOW_QUALITIES,
  TONE_MAPPINGS,
  TONE_MAPPING_LABELS,
  needsPostProcessing,
  shadowMapSizeFor,
  type GraphicsSettings,
} from '@engine/render/GraphicsSettings';
import { useEditorStore } from '../state/editorStore';
import { Group, Row, Slider } from './controls';

const SHADOW_QUALITY_LABELS: Record<(typeof SHADOW_QUALITIES)[number], string> = {
  off: 'Off',
  low: 'Low — 512',
  medium: 'Medium — 1024',
  high: 'High — 2048',
  ultra: 'Ultra — 4096',
};

/**
 * The graphics settings panel.
 *
 * Every control here writes one field of `GraphicsSettings` and nothing else — the panel holds
 * no state of its own, so what it shows is by construction what the renderer is using. Values
 * are normalized on the way into the store, which is why a slider can be dragged anywhere
 * without the renderer and the readout ever disagreeing.
 *
 * The notes under each group are the point of the panel as much as the controls are: a quality
 * menu that does not say what a setting costs makes people turn everything up and then blame
 * the engine. In the bottom dock those notes finally have room to be read — as a floating
 * 314px column over the viewport, four sections of prose was a scrolling wall covering the very
 * thing whose image quality you were adjusting.
 */
export function GraphicsPanel() {
  const graphics = useEditorStore((s) => s.graphics);
  const setGraphics = useEditorStore((s) => s.setGraphics);
  const resetGraphics = useEditorStore((s) => s.resetGraphics);

  const patch = (values: Partial<GraphicsSettings>) => setGraphics(values);

  return (
    <div className="panel-content">
      <div className="panel-bar">
        <span className="panel-bar-note">
          Saved in this browser, not in the scene — quality belongs to the machine you are
          sitting at.
        </span>
        <button onClick={resetGraphics} title="Back to the shipped defaults">
          Reset to defaults
        </button>
      </div>

      <div className="panel-scroll panel-columns">
        <Group title="Antialiasing">
          <Row label="Mode">
            <select
              value={graphics.antialias}
              onChange={(e) =>
                patch({ antialias: e.currentTarget.value as GraphicsSettings['antialias'] })
              }
            >
              {ANTIALIAS_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {ANTIALIAS_LABELS[mode]}
                </option>
              ))}
            </select>
          </Row>
          <p className="note">
            {needsPostProcessing(graphics.antialias)
              ? 'The frame is drawn into an offscreen buffer and resolved to the canvas. That is what makes this switchable without reloading — and it is where tone mapping happens.'
              : 'Drawn straight to the canvas. Cheapest path, and geometry edges will stair-step.'}
          </p>
        </Group>

        <Group title="Shadows">
          <Row label="Quality">
            <select
              value={graphics.shadowQuality}
              onChange={(e) =>
                patch({ shadowQuality: e.currentTarget.value as GraphicsSettings['shadowQuality'] })
              }
            >
              {SHADOW_QUALITIES.map((quality) => (
                <option key={quality} value={quality}>
                  {SHADOW_QUALITY_LABELS[quality]}
                </option>
              ))}
            </select>
          </Row>
          {graphics.shadowQuality !== 'off' && (
            <>
              <Row label="Filter">
                <select
                  value={graphics.shadowFilter}
                  onChange={(e) =>
                    patch({
                      shadowFilter: e.currentTarget.value as GraphicsSettings['shadowFilter'],
                    })
                  }
                >
                  {SHADOW_FILTERS.map((filter) => (
                    <option key={filter} value={filter}>
                      {SHADOW_FILTER_LABELS[filter]}
                    </option>
                  ))}
                </select>
              </Row>
              <Slider
                label="Distance"
                value={graphics.shadowDistance}
                min={5}
                max={200}
                step={5}
                format={(v) => `${v} m`}
                onChange={(shadowDistance) => patch({ shadowDistance })}
              />
              <p className="note">
                {shadowMapSizeFor(graphics.shadowQuality)}² texels across{' '}
                {graphics.shadowDistance * 2} m — about{' '}
                {(
                  (graphics.shadowDistance * 200) /
                  shadowMapSizeFor(graphics.shadowQuality)
                ).toFixed(1)}{' '}
                cm per texel. Halving the distance sharpens shadows exactly as much as doubling
                the map, and costs no memory at all.
              </p>
              <p className="note">
                Applies to the built-in lighting. A scene with its own Light components sets
                range, map size and bias per light in the Inspector.
              </p>
            </>
          )}
        </Group>

        <Group title="Image">
          <Row label="Tone map">
            <select
              value={graphics.toneMapping}
              onChange={(e) =>
                patch({ toneMapping: e.currentTarget.value as GraphicsSettings['toneMapping'] })
              }
            >
              {TONE_MAPPINGS.map((mode) => (
                <option key={mode} value={mode}>
                  {TONE_MAPPING_LABELS[mode]}
                </option>
              ))}
            </select>
          </Row>
          <Slider
            label="Exposure"
            value={graphics.exposure}
            min={0.1}
            max={4}
            step={0.05}
            format={(v) => `${v.toFixed(2)}×`}
            onChange={(exposure) => patch({ exposure })}
          />
          <p className="note">
            {graphics.toneMapping === 'none'
              ? 'Without a curve, anything brighter than white clips per channel — a strong light turns a red surface orange, then yellow, rather than white.'
              : 'Highlights are rolled off instead of clipped, so bright lights keep their colour. Exposure scales the whole image before the curve.'}
          </p>
        </Group>

        <Group title="Resolution">
          <Slider
            label="Render scale"
            value={graphics.resolutionScale}
            min={0.25}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(resolutionScale) => patch({ resolutionScale })}
          />
          <Slider
            label="Pixel ratio"
            value={graphics.pixelRatioCap}
            min={1}
            max={3}
            step={0.5}
            format={(v) => `≤ ${v.toFixed(1)}×`}
            onChange={(pixelRatioCap) => patch({ pixelRatioCap })}
          />
          {/* A select rather than a slider: GPUs only implement powers of two, so every other
              stop on a slider would silently snap somewhere else. */}
          <Row label="Anisotropy">
            <select
              value={graphics.anisotropy}
              onChange={(e) => patch({ anisotropy: Number(e.currentTarget.value) })}
            >
              <option value={1}>Off</option>
              <option value={2}>2×</option>
              <option value={4}>4×</option>
              <option value={8}>8×</option>
              <option value={16}>16×</option>
            </select>
          </Row>
          <p className="note">
            Render scale is the strongest lever in a browser — fill cost scales with its square,
            and fill is what mobile GPUs run out of first. Anisotropy sharpens textures seen at a
            glancing angle, like a floor stretching away from the camera.
          </p>
        </Group>
      </div>
    </div>
  );
}
