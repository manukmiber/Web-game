import { getModifierDefinition, listModifierDefinitions } from '@engine/mesh/modifiers';
import type { MeshRendererComponent } from '@engine/components/MeshRenderer';
import { meshStats } from '@engine/render/geometry';
import type { EntityId } from '@engine/scene/types';
import { useEditor } from '../EditorContext';
import {
  AddModifierCommand,
  MoveModifierCommand,
  RemoveModifierCommand,
  SetModifierPropertyCommand,
} from '../commands/modifierCommands';
import { ComponentField } from './ComponentField';

interface Props {
  entityId: EntityId;
  renderer: MeshRendererComponent;
}

/**
 * The modifier stack, in the Inspector below the Mesh Renderer.
 *
 * Deliberately shows the evaluated topology at the top. A modifier stack is where a scene
 * quietly turns into millions of triangles, and a modeller needs to see that cost while
 * deciding, not after the viewport has already dropped to single-digit frames.
 */
export function ModifierStack({ entityId, renderer }: Props) {
  const { engine, run } = useEditor();
  const modifiers = renderer.modifiers ?? [];
  const stats = meshStats(renderer);

  const available = listModifierDefinitions();

  return (
    <div className="inspector-section">
      <div className="inspector-section-header" style={{ cursor: 'default' }}>
        <span>Modifiers</span>
        <span className="modifier-count">{modifiers.length}</span>
      </div>

      <div className="mesh-stats">
        <span title="Vertices after the stack has run">{stats.vertices.toLocaleString()} verts</span>
        <span title="Polygon faces, before triangulation">{stats.faces.toLocaleString()} faces</span>
        <span
          className={stats.triangles > 200_000 ? 'heavy' : undefined}
          title="Triangles handed to the GPU"
        >
          {stats.triangles.toLocaleString()} tris
        </span>
      </div>

      <div className="modifier-list">
        {modifiers.map((modifier, index) => {
          const definition = getModifierDefinition(modifier.type);
          return (
            <div className="modifier" key={`${modifier.type}-${index}`}>
              <div className="modifier-header">
                <input
                  type="checkbox"
                  checked={modifier.enabled !== false}
                  title="Toggle without removing"
                  onChange={(event) =>
                    run(
                      new SetModifierPropertyCommand(
                        engine.scene,
                        entityId,
                        index,
                        'enabled',
                        event.currentTarget.checked,
                      ),
                    )
                  }
                />
                <span className="modifier-name">{definition?.label ?? modifier.type}</span>
                <button
                  disabled={index === 0}
                  title="Move up — order changes the result"
                  onClick={() =>
                    run(new MoveModifierCommand(engine.scene, entityId, index, index - 1))
                  }
                >
                  ▲
                </button>
                <button
                  disabled={index === modifiers.length - 1}
                  title="Move down"
                  onClick={() =>
                    run(new MoveModifierCommand(engine.scene, entityId, index, index + 1))
                  }
                >
                  ▼
                </button>
                <button
                  title="Remove"
                  onClick={() => run(new RemoveModifierCommand(engine.scene, entityId, index))}
                >
                  ✕
                </button>
              </div>

              {definition && (
                <div className="modifier-body">
                  {definition.fields(modifier).map((schema) => (
                    <ComponentField
                      key={schema.key}
                      schema={schema}
                      value={modifier[schema.key]}
                      onChange={(value) =>
                        run(
                          new SetModifierPropertyCommand(
                            engine.scene,
                            entityId,
                            index,
                            schema.key,
                            value,
                          ),
                        )
                      }
                    />
                  ))}
                </div>
              )}

              {!definition && (
                <div className="mixed-note">
                  Unknown modifier — preserved on save, but not applied by this build.
                </div>
              )}
            </div>
          );
        })}

        {modifiers.length === 0 && (
          <div className="mixed-note">No modifiers. The mesh renders as generated.</div>
        )}
      </div>

      <div style={{ padding: '0 8px 8px' }}>
        <select
          value=""
          style={{ width: '100%' }}
          onChange={(event) => {
            const definition = getModifierDefinition(event.currentTarget.value);
            if (definition) {
              run(new AddModifierCommand(engine.scene, entityId, definition.create()));
            }
            event.currentTarget.value = '';
          }}
        >
          <option value="" disabled>
            Add Modifier…
          </option>
          {available.map((definition) => (
            <option key={definition.type} value={definition.type}>
              {definition.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
