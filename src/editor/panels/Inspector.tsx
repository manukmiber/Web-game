import { useEffect, useState } from 'react';
import { getComponentDefinition, listComponentDefinitions } from '@engine/components/registry';
import type { Component, EntityId, Transform } from '@engine/scene/types';
import { useEditor } from '../EditorContext';
import { useEditorStore } from '../state/editorStore';
import {
  AddComponentCommand,
  RemoveComponentCommand,
  RenameEntityCommand,
  SetComponentPropertyCommand,
  SetTransformCommand,
  readPath,
} from '../commands/sceneCommands';
import { Field, Section, Vec3Field } from './fields';
import { ComponentField } from './ComponentField';
import { ModifierStack } from './ModifierStack';
import { ScatterEditor } from './ScatterEditor';
import { ScriptEditor } from './ScriptEditor';

type TransformKey = keyof Transform;

export function Inspector() {
  const { engine, run } = useEditor();
  const scene = engine.scene;
  const selection = useEditorStore((s) => s.selection);
  const sceneRevision = useEditorStore((s) => s.sceneRevision);

  /**
   * The gizmo writes transforms every frame during a drag, and those changes deliberately do
   * not bump `sceneRevision` (that would re-render the Hierarchy sixty times a second). So
   * the Inspector subscribes to transform events directly and re-renders only itself.
   */
  const [transformTick, setTransformTick] = useState(0);
  useEffect(() => {
    return scene.events.on('transformChanged', () => setTransformTick((n) => n + 1));
  }, [scene]);
  void transformTick;
  void sceneRevision;

  if (selection.length === 0) {
    return (
      <div className="panel-content">
        <div className="panel-scroll">
          <div className="empty-note centered">
            Nothing selected. Pick an object in the viewport or the Hierarchy.
          </div>
        </div>
      </div>
    );
  }

  const entities = selection.map((id) => scene.get(id)).filter((e) => e !== undefined);
  if (entities.length === 0) {
    return (
      <div className="panel-content">
        <div className="panel-scroll" />
      </div>
    );
  }

  const primary = entities[0]!;
  const multi = entities.length > 1;

  const transformValue = (key: TransformKey): [number, number, number] =>
    primary.transform[key] as [number, number, number];

  /** Per-axis disagreement across a multi-selection. */
  const transformMixed = (key: TransformKey): [boolean, boolean, boolean] => {
    const base = transformValue(key);
    const flags: [boolean, boolean, boolean] = [false, false, false];
    for (const entity of entities.slice(1)) {
      const other = entity.transform[key];
      for (let i = 0; i < 3; i += 1) if (other[i] !== base[i]) flags[i] = true;
    }
    return flags;
  };

  const setTransformAxis = (key: TransformKey, axis: 0 | 1 | 2, value: number) => {
    const next = new Map<EntityId, Partial<Transform>>();
    for (const entity of entities) {
      const vector = [...entity.transform[key]] as [number, number, number];
      vector[axis] = value;
      next.set(entity.id, { [key]: vector });
    }
    run(new SetTransformCommand(scene, next));
  };

  /**
   * What to draw, in the order the entity stores it.
   *
   * Two kinds of entry. A single-instance type is one section shared by the whole selection,
   * addressed by type — editing it applies to every selected object. A type that allows several
   * (`Script`) gets one section per component, addressed by its position in the array, and only
   * on a single selection: "the second Script" is not a thing a multi-selection can agree on
   * when the objects have different numbers of them.
   *
   * Types the whole selection does not share are skipped, since editing one would silently
   * apply to only some of the selected objects.
   */
  const sections: { key: string; type: string; component: Component; index?: number }[] = [];
  const seenTypes = new Set<string>();

  for (const [index, component] of primary.components.entries()) {
    const definition = getComponentDefinition(component.type);

    if (definition?.allowMultiple && !multi) {
      sections.push({
        key: `${component.type}:${index}`,
        type: component.type,
        component,
        index,
      });
      continue;
    }

    if (seenTypes.has(component.type)) continue;
    seenTypes.add(component.type);
    const shared = entities.every((entity) => entity.components.some((c) => c.type === component.type));
    if (!shared) continue;
    sections.push({ key: component.type, type: component.type, component });
  }

  const missingDefinitions = listComponentDefinitions().filter(
    (definition) =>
      definition.addable !== false &&
      // A type that allows several is always offered, however many the entity already has.
      (definition.allowMultiple ||
        !entities.every((entity) => entity.components.some((c) => c.type === definition.type))),
  );

  return (
    <div className="panel-content">
      <div className="panel-scroll">
        <div className="entity-header">
          <input
            key={`${primary.id}:${primary.name}`}
            defaultValue={multi ? `${entities.length} selected` : primary.name}
            disabled={multi}
            onBlur={(event) => {
              const value = event.currentTarget.value.trim();
              if (!multi && value && value !== primary.name) {
                run(new RenameEntityCommand(scene, primary.id, value));
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              event.stopPropagation();
            }}
          />
        </div>

        <Section title="Transform">
          <Field label="Position">
            <Vec3Field
              value={transformValue('position')}
              mixed={multi ? transformMixed('position') : undefined}
              step={0.1}
              onChange={(axis, value) => setTransformAxis('position', axis, value)}
            />
          </Field>
          <Field label="Rotation">
            <Vec3Field
              value={transformValue('rotation')}
              mixed={multi ? transformMixed('rotation') : undefined}
              step={1}
              onChange={(axis, value) => setTransformAxis('rotation', axis, value)}
            />
          </Field>
          <Field label="Scale">
            <Vec3Field
              value={transformValue('scale')}
              mixed={multi ? transformMixed('scale') : undefined}
              step={0.1}
              onChange={(axis, value) => setTransformAxis('scale', axis, value)}
            />
          </Field>
        </Section>

        {sections.map(({ key, type, component, index }) => (
          <div key={key}>
            <ComponentSection
              type={type}
              component={component}
              // A named instance is worth labelling: three sections all headed "Script" is
              // exactly as useless as it sounds.
              title={index !== undefined ? instanceTitle(type, component) : undefined}
              onRemove={() => {
                if (index !== undefined) {
                  run(new RemoveComponentCommand(scene, primary.id, type, index));
                  return;
                }
                for (const entity of entities) {
                  run(new RemoveComponentCommand(scene, entity.id, type));
                }
              }}
              onChange={(path, value) => {
                run(
                  new SetComponentPropertyCommand(
                    scene,
                    index !== undefined ? [primary.id] : entities.map((e) => e.id),
                    type,
                    path,
                    value,
                    index,
                  ),
                );
              }}
            />
            {/* The stack belongs to the mesh pipeline, so it sits directly under its renderer.
                Single selection only: reordering a stack across several objects at once has
                no unambiguous meaning. */}
            {type === 'MeshRenderer' && !multi && (
              <ModifierStack entityId={primary.id} renderer={component as never} />
            )}
            {/* Same reasoning as the modifier stack: the source belongs directly under its
                component, and editing one across a multi-selection has no clear meaning. */}
            {type === 'Script' && index !== undefined && (
              <ScriptEditor
                entityId={primary.id}
                componentIndex={index}
                script={component as never}
              />
            )}
            {/* The brush belongs with the layer it fills, and its prototype list names entities
                in this scene — neither survives being applied across a multi-selection. */}
            {type === 'ScatterLayer' && !multi && (
              <ScatterEditor entityId={primary.id} layer={component as never} />
            )}
          </div>
        ))}

        {multi && sections.length < primary.components.length && (
          <div className="mixed-note">
            Only components shared by all {entities.length} selected objects are shown.
          </div>
        )}

        {missingDefinitions.length > 0 && (
          <div className="add-component">
            <select
              value=""
              onChange={(event) => {
                const definition = getComponentDefinition(event.currentTarget.value);
                if (!definition) return;
                for (const entity of entities) {
                  // A repeatable type always adds another; anything else is skipped on the
                  // entities that already have one, so one pick across a mixed selection tops
                  // everyone up rather than doubling up on some of them.
                  if (
                    !definition.allowMultiple &&
                    entity.components.some((c) => c.type === definition.type)
                  ) {
                    continue;
                  }
                  run(new AddComponentCommand(scene, entity.id, definition.create()));
                }
                event.currentTarget.value = '';
              }}
            >
              <option value="" disabled>
                Add Component…
              </option>
              {missingDefinitions.map((definition) => (
                <option key={definition.type} value={definition.type}>
                  {definition.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </div>
  );
}

/** "Script — Zombie AI", so three sections headed "Script" are told apart at a glance. */
function instanceTitle(type: string, component: Component): string | undefined {
  const definition = getComponentDefinition(type);
  const name = typeof component.name === 'string' ? component.name.trim() : '';
  if (!definition) return undefined;
  return name ? `${definition.label} — ${name}` : definition.label;
}

interface ComponentSectionProps {
  type: string;
  component: Component;
  /** Overrides the registry label. Used to name one instance of a repeatable component. */
  title?: string;
  onRemove(): void;
  onChange(path: string, value: unknown): void;
}

function ComponentSection({ type, component, title, onRemove, onChange }: ComponentSectionProps) {
  const definition = getComponentDefinition(type);

  // An unregistered type is still valid data (a scene from a newer build). Show it read-only
  // rather than pretending it isn't there.
  if (!definition) {
    return (
      <Section title={type} defaultOpen={false}>
        <div className="mixed-note">Unknown component type — preserved but not editable here.</div>
      </Section>
    );
  }

  return (
    <Section
      title={title ?? definition.label}
      actions={
        <button onClick={onRemove} title={`Remove ${definition.label}`}>
          ✕
        </button>
      }
    >
      {definition.fields(component).map((schema) => (
        <ComponentField
          key={schema.key}
          schema={schema}
          value={readPath(component, schema.key)}
          onChange={(value) => onChange(schema.key, value)}
        />
      ))}
    </Section>
  );
}
