import type { ScatterLayerComponent, ScatterPrototype } from '@engine/components/ScatterLayer';
import {
  EMPTY_SCATTER_DATA,
  createPrototype,
  refillLayer,
  scatterStats,
} from '@engine/scatter';
import type { EntityId } from '@engine/scene/types';
import { useEditor } from '../EditorContext';
import { SetComponentPropertiesCommand } from '../commands/sceneCommands';
import { NumberField } from './fields';

interface Props {
  entityId: EntityId;
  layer: ScatterLayerComponent;
}

/**
 * The scatter brush, in the Inspector below the Scatter Layer component.
 *
 * Sits here rather than in a panel of its own for the same reason the modifier stack does: the
 * settings belong to the component, and the one control that is not a settings field — the
 * button that actually fills the layer — has to be next to the numbers that decide what it
 * produces. The count it would place is shown *before* you press it, because a scatter brush is
 * one keystroke away from a million instances and finding that out afterwards is expensive.
 *
 * Prototypes are entities, not assets. That is the useful part: the tree you scatter is an
 * object in the scene you can select, re-colour, and put a modifier stack on — and every
 * instance follows, because the renderer borrows its geometry through the same cache.
 */
export function ScatterEditor({ entityId, layer }: Props) {
  const { engine, run } = useEditor();
  const scene = engine.scene;

  const prototypes: ScatterPrototype[] = layer.prototypes ?? [];
  const stats = scatterStats(scene, layer);

  /** Anything with a mesh, minus the layer itself — you cannot scatter a scatter layer. */
  const candidates = scene
    .all()
    .filter(
      (entity) =>
        entity.id !== entityId && entity.components.some((c) => c.type === 'MeshRenderer'),
    );

  const write = (patch: Record<string, unknown>, label: string) => {
    run(new SetComponentPropertiesCommand(scene, entityId, 'ScatterLayer', patch, label));
  };

  const setPrototypes = (next: ScatterPrototype[], label: string) => {
    // Instances carry a prototype index, so changing the list without re-rolling would leave
    // trees pointing at whatever moved into their slot. Refilling is the honest response.
    write({ prototypes: next, ...refillLayer({ ...layer, prototypes: next }) }, label);
  };

  return (
    <div className="inspector-section">
      <div className="inspector-section-header" style={{ cursor: 'default' }}>
        <span>Scatter</span>
        <span className="modifier-count">{prototypes.length}</span>
      </div>

      <div className="mesh-stats">
        <span title="Instances currently stored in this layer">
          {stats.instances.toLocaleString()} placed
        </span>
        <span
          className={stats.wouldPlace > 100_000 ? 'heavy' : undefined}
          title="What pressing Scatter would place with the current settings"
        >
          {stats.wouldPlace.toLocaleString()} pending
        </span>
        <span title="One draw call per prototype, however many instances it has">
          {stats.drawCalls} draw {stats.drawCalls === 1 ? 'call' : 'calls'}
        </span>
      </div>

      <div className="modifier-list">
        {prototypes.map((prototype, index) => {
          const source = scene.get(prototype.sourceId);
          return (
            <div className="modifier" key={prototype.id}>
              <div className="modifier-header">
                <span className="modifier-name" title={prototype.sourceId}>
                  {source?.name ?? 'Missing source'}
                </span>
                <NumberField
                  value={prototype.weight}
                  min={0}
                  step={0.5}
                  onChange={(weight) =>
                    setPrototypes(
                      prototypes.map((entry, i) => (i === index ? { ...entry, weight } : entry)),
                      'Set Scatter Weight',
                    )
                  }
                />
                <button
                  title="Remove this prototype"
                  onClick={() =>
                    setPrototypes(
                      prototypes.filter((_, i) => i !== index),
                      'Remove Scatter Prototype',
                    )
                  }
                >
                  ✕
                </button>
              </div>
              {!source && (
                <div className="mixed-note">
                  The source entity is gone — this prototype draws nothing until it is replaced.
                </div>
              )}
            </div>
          );
        })}

        {prototypes.length === 0 && (
          <div className="mixed-note">
            No prototypes. Add an object below and the layer scatters copies of it.
          </div>
        )}
      </div>

      <div style={{ padding: '0 8px 8px', display: 'grid', gap: 6 }}>
        <select
          value=""
          style={{ width: '100%' }}
          onChange={(event) => {
            const sourceId = event.currentTarget.value;
            event.currentTarget.value = '';
            if (!sourceId) return;
            setPrototypes(
              [...prototypes, createPrototype(sourceId)],
              'Add Scatter Prototype',
            );
          }}
        >
          <option value="" disabled>
            Add Prototype…
          </option>
          {candidates.map((entity) => (
            <option key={entity.id} value={entity.id}>
              {entity.name}
            </option>
          ))}
        </select>

        <div style={{ display: 'flex', gap: 6 }}>
          <button
            style={{ flex: 1 }}
            disabled={prototypes.length === 0}
            title={
              prototypes.length === 0
                ? 'Add a prototype first — there is nothing to scatter'
                : 'Fill the layer from the settings above. Same seed, same result.'
            }
            onClick={() => write(refillLayer(layer), 'Scatter')}
          >
            Scatter
          </button>
          <button
            style={{ flex: 1 }}
            disabled={prototypes.length === 0}
            title="Re-roll with a new seed"
            onClick={() => {
              const seed = ((layer.seed ?? 1) % 0xffffff) + 1;
              write({ seed, ...refillLayer({ ...layer, seed }) }, 'Re-roll Scatter');
            }}
          >
            Re-roll
          </button>
          <button
            style={{ flex: 1 }}
            disabled={stats.instances === 0}
            title="Empty the layer, keeping its prototypes and settings"
            onClick={() => write({ ...EMPTY_SCATTER_DATA }, 'Clear Scatter')}
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}
