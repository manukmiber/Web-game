import { useEffect, useState } from 'react';
import type { SceneStats } from '@engine/perf/SceneStats';
import { useEditorStore } from '../state/editorStore';
import { Group } from './controls';
import type { ViewportController } from '../viewport/ViewportController';

/** Polled rather than per frame, for the same reason the Performance panel is. */
const REFRESH_MS = 400;

interface Props {
  viewport: ViewportController | null;
}

/**
 * What the scene contains, and what each part of it costs.
 *
 * The Performance panel answers "is this frame fast enough". This one answers the question you
 * ask next, which is "what in here is expensive" — and they are genuinely different questions
 * with different shapes of answer. One is a handful of numbers that change every frame; this is
 * a census that changes when you edit the scene, and it is mostly a table.
 *
 * The two headline numbers the renderer already reported — draw calls and triangles — were the
 * least useful ones available. "1.4M triangles" is a fact about the scene you cannot act on.
 * "1.1M of them are in Rock, drawn 40 times, and 900k of those get re-submitted for shadows" is
 * a list of three things to try.
 */
export function StatisticsPanel({ viewport }: Props) {
  const [stats, setStats] = useState<SceneStats | null>(null);
  const [budget, setBudget] = useState({ active: 0, requested: 0, limit: 0 });
  const setSelection = useEditorStore((s) => s.setSelection);
  const sceneRevision = useEditorStore((s) => s.sceneRevision);

  useEffect(() => {
    if (!viewport) return;
    const sample = () => {
      setStats(viewport.sceneStats());
      setBudget(viewport.shadowBudget());
    };
    sample();
    const timer = setInterval(sample, REFRESH_MS);
    return () => clearInterval(timer);
    // Re-sampled immediately on a structural change, so adding an object updates the table now
    // rather than at the next tick of the interval.
  }, [viewport, sceneRevision]);

  if (!stats) {
    return (
      <div className="panel-content">
        <div className="panel-scroll">
          <div className="empty-note centered">Waiting for the viewport.</div>
        </div>
      </div>
    );
  }

  const { triangles, objects, lights, heaviest } = stats;

  return (
    <div className="panel-content">
      <div className="metric-strip">
        <Metric label="triangles" value={compact(triangles.total)} large />
        <Metric
          label="visible"
          value={compact(triangles.visible)}
          title="Triangles in entities that are not hidden. Frustum culling reduces this further before the GPU sees it."
        />
        <Metric
          label="unique"
          value={compact(triangles.unique)}
          title="Distinct triangles in memory, ignoring instancing. The memory axis — instancing does not help with this one."
        />
        <Metric
          label="shadow pass"
          value={compact(triangles.shadowPass)}
          title="Triangles re-submitted for shadow maps each frame: casters multiplied by the number of shadow-casting lights."
        />
        <Metric label="objects" value={objects.entities.toLocaleString()} />
        <Metric label="meshes" value={objects.meshes.toLocaleString()} />
        <Metric
          label="instances"
          value={compact(objects.scatterInstances)}
          title="Scatter instances. Each costs a matrix, not a draw call."
        />
        <Metric
          label="draws"
          value={objects.drawCallEstimate.toLocaleString()}
          title="Draw calls the scene should cost before culling — one per mesh, one per scatter batch."
        />
      </div>

      <div className="panel-scroll panel-columns">
        <Group title="Triangles">
          <StatRow label="Meshes" value={compact(triangles.meshes)} />
          <StatRow label="Scatter instances" value={compact(triangles.scatter)} />
          <StatRow label="Hidden" value={compact(triangles.hidden)} />
          <StatRow label="Unique in memory" value={compact(triangles.unique)} />
          <StatRow label="Shadow re-submits" value={compact(triangles.shadowPass)} />
          <StatRow label="Vertices" value={compact(objects.vertices)} />
        </Group>

        <Group title="Objects">
          <StatRow label="Entities" value={objects.entities.toLocaleString()} />
          <StatRow label="Roots" value={objects.rootEntities.toLocaleString()} />
          <StatRow label="Deepest nesting" value={String(objects.maxDepth)} />
          <StatRow label="Meshes" value={objects.meshes.toLocaleString()} />
          <StatRow label="Hidden meshes" value={objects.hiddenMeshes.toLocaleString()} />
          <StatRow label="Scatter batches" value={objects.scatterLayers.toLocaleString()} />
          <StatRow label="Unique geometries" value={objects.uniqueGeometries.toLocaleString()} />
          <StatRow label="Unique materials" value={objects.uniqueMaterials.toLocaleString()} />
        </Group>

        <Group title="Lights">
          <StatRow label="Total" value={String(lights.total)} />
          <StatRow label="Enabled" value={String(lights.enabled)} />
          <StatRow
            label="Shadows"
            value={
              budget.limit < 0
                ? `${budget.active} (no cap)`
                : `${budget.active} of ${budget.requested}`
            }
          />
          {Object.entries(lights.byType)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([kind, count]) => (
              <StatRow key={kind} label={kind} value={String(count)} />
            ))}
          {budget.limit >= 0 && budget.requested > budget.active && (
            <p className="note">
              {budget.requested - budget.active} light
              {budget.requested - budget.active === 1 ? '' : 's'} asked for a shadow and did not
              get one — the cap is {budget.limit}. Raise it in Graphics, or give the lights you
              care about a higher Shadow Priority.
            </p>
          )}
        </Group>

        <Group title="Components">
          {Object.entries(objects.components)
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => (
              <StatRow key={type} label={type} value={String(count)} />
            ))}
          {Object.keys(objects.components).length === 0 && (
            <p className="note">Nothing in the scene yet.</p>
          )}
        </Group>
        <div className="stats-table-wrap">
          <table className="stats-table">
            <caption>Heaviest objects — click a row to select it</caption>
            <thead>
              <tr>
                <th>Object</th>
                <th>Triangles</th>
                <th>Copies</th>
                <th>Draws</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {heaviest.map((entry) => (
                <tr
                  key={entry.id}
                  onClick={() => setSelection([entry.id])}
                  title={`Select ${entry.name}`}
                >
                  <td>{entry.name}</td>
                  <td className="numeric">{compact(entry.triangles)}</td>
                  <td className="numeric">{entry.instances.toLocaleString()}</td>
                  <td className="numeric">{entry.drawCalls.toLocaleString()}</td>
                  <td className="flags">
                    {entry.kind === 'scatter' && <span title="Instanced scatter layer">inst</span>}
                    {!entry.visible && (
                      <span title="Hidden — costs memory, not frame time">hidden</span>
                    )}
                    {entry.castsShadow && <span title="Re-drawn for every shadow map">shadow</span>}
                  </td>
                </tr>
              ))}
              {heaviest.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty-note">
                    No renderable objects in the scene.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="control-row stat-row">
      <label>{label}</label>
      <span className="control-value">{value}</span>
    </div>
  );
}

function Metric({
  label,
  value,
  title,
  large,
}: {
  label: string;
  value: string;
  title?: string;
  large?: boolean;
}) {
  return (
    <div className={`metric ${large ? 'large' : ''}`} title={title}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
    </div>
  );
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}
