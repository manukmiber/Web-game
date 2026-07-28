import type { FieldSchema } from '@engine/components/registry';
import { Field, NumberField, Vec2Field, Vec3Field } from './fields';

/**
 * Renders one field from a registry field schema.
 *
 * Shared by the component Inspector and the modifier stack: both describe their editable
 * properties with the same schema, so both get the same widgets for free. Adding a new field
 * kind here reaches every panel at once.
 */
export function ComponentField({
  schema,
  value,
  onChange,
}: {
  schema: FieldSchema;
  value: unknown;
  onChange(value: unknown): void;
}) {
  switch (schema.kind) {
    case 'number':
      return (
        <Field label={schema.label}>
          <NumberField
            value={typeof value === 'number' ? value : 0}
            min={schema.min}
            max={schema.max}
            step={schema.step}
            integer={schema.integer}
            onChange={onChange}
          />
        </Field>
      );
    case 'vec3': {
      // Writes the whole triple rather than one axis, because the command layer records a value
      // per path — a per-axis path would make an undo entry for X and one for Y out of a single
      // drag across the row.
      const vector: [number, number, number] = Array.isArray(value)
        ? [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0]
        : [0, 0, 0];
      return (
        <Field label={schema.label}>
          <Vec3Field
            value={vector}
            step={schema.step}
            onChange={(axis, next) => {
              const updated: [number, number, number] = [...vector];
              updated[axis] = next;
              onChange(updated);
            }}
          />
        </Field>
      );
    }
    case 'vec2': {
      // The stored value may be longer than two — a Rect collider's size is a Vec3 whose third
      // component belongs to the extrusion depth — so the tail is carried through untouched
      // rather than truncated. Editing a 2D shape must not discard its 3D size.
      const source = Array.isArray(value) ? value : [];
      const pair: [number, number] = [Number(source[0]) || 0, Number(source[1]) || 0];
      return (
        <Field label={schema.label}>
          <Vec2Field
            value={pair}
            step={schema.step}
            labels={schema.labels}
            onChange={(axis, next) => {
              const updated = [...source];
              while (updated.length < 2) updated.push(0);
              updated[axis] = next;
              onChange(updated);
            }}
          />
        </Field>
      );
    }
    case 'group':
      return <div className="field-group">{schema.label}</div>;
    case 'boolean':
      return (
        <Field label={schema.label}>
          <input
            type="checkbox"
            checked={Boolean(value)}
            style={{ justifySelf: 'start', width: 'auto' }}
            onChange={(event) => onChange(event.currentTarget.checked)}
          />
        </Field>
      );
    case 'color':
      return (
        <Field label={schema.label}>
          <input
            type="color"
            value={typeof value === 'string' ? value : '#ffffff'}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        </Field>
      );
    case 'enum':
      return (
        <Field label={schema.label}>
          <select value={String(value ?? '')} onChange={(event) => onChange(event.currentTarget.value)}>
            {schema.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>
      );
    case 'string':
      return (
        <Field label={schema.label}>
          <input
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.currentTarget.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
        </Field>
      );
    case 'text':
      // Full width, under its label rather than beside it: a binding list is read in lines,
      // and squeezing it into the value column of a two-column grid makes both unreadable.
      return (
        <div className="field field-text">
          <label>{schema.label}</label>
          <textarea
            className={schema.monospace === false ? '' : 'mono'}
            rows={schema.rows ?? 4}
            spellCheck={false}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.currentTarget.value)}
            // Play mode owns the keyboard, and W is "walk forward" there — a textarea has to
            // swallow keys or editing a binding would drive the character.
            onKeyDown={(event) => event.stopPropagation()}
          />
        </div>
      );
    case 'asset':
      // Texture slots need the asset browser to be useful; wired up in Phase 2.
      return (
        <Field label={schema.label}>
          <input value={typeof value === 'string' ? value : 'None'} disabled />
        </Field>
      );
    default:
      return null;
  }
}
