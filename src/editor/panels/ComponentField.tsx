import type { FieldSchema } from '@engine/components/registry';
import { Field, NumberField } from './fields';

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
