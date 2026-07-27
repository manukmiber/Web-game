import { describe, expect, it } from 'vitest';
import { validateInput, vec3Schema, type ObjectSchema } from './schema';

const SCHEMA: ObjectSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['Box', 'Sphere'] },
    count: { type: 'integer', minimum: 1, maximum: 10, default: 1 },
    position: vec3Schema('Where.'),
    enabled: { type: 'boolean', default: true },
    value: {},
    params: { type: 'object', properties: {}, additionalProperties: true },
  },
  required: ['kind'],
};

describe('tool input validation', () => {
  it('fills defaults for absent optional fields', () => {
    const result = validateInput(SCHEMA, { kind: 'Box' });
    expect(result).toMatchObject({ ok: true, value: { kind: 'Box', count: 1, enabled: true } });
  });

  it('reports every problem at once', () => {
    const result = validateInput(SCHEMA, { kind: 'Cube', count: 99 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // One round trip should be enough to fix a wrong enum and an out-of-range number together.
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain('Box, Sphere');
    expect(result.errors[1]).toContain('at most 10');
  });

  it('names the missing field rather than the type it was not', () => {
    const result = validateInput(SCHEMA, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain('missing required field "kind"');
  });

  it('rejects unknown fields and says what the real ones are', () => {
    const result = validateInput(SCHEMA, { kind: 'Box', positon: [1, 2, 3] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('unknown field "positon"');
      expect(result.errors[0]).toContain('position');
    }
  });

  it('coerces numeric strings, because models send them', () => {
    const result = validateInput(SCHEMA, { kind: 'Box', count: '3' });
    expect(result).toMatchObject({ ok: true, value: { count: 3 } });
  });

  it('does not coerce something that merely starts with a number', () => {
    const result = validateInput(SCHEMA, { kind: 'Box', count: '3 metres' });
    expect(result.ok).toBe(false);
  });

  it('holds a vec3 to exactly three numbers', () => {
    expect(validateInput(SCHEMA, { kind: 'Box', position: [1, 2] }).ok).toBe(false);
    expect(validateInput(SCHEMA, { kind: 'Box', position: [1, 2, 3, 4] }).ok).toBe(false);
    expect(validateInput(SCHEMA, { kind: 'Box', position: [1, '2', 3] })).toMatchObject({
      ok: true,
      value: { position: [1, 2, 3] },
    });
  });

  it('rejects a whole number given as a fraction', () => {
    const result = validateInput(SCHEMA, { kind: 'Box', count: 1.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain('whole number');
  });

  it('passes an untyped field through unchanged', () => {
    const result = validateInput(SCHEMA, { kind: 'Box', value: { nested: [1, null, 'x'] } });
    expect(result).toMatchObject({ ok: true, value: { value: { nested: [1, null, 'x'] } } });
  });

  it('lets a pass-through record keep its own keys', () => {
    const result = validateInput(SCHEMA, { kind: 'Box', params: { width: 2, depth: 3 } });
    expect(result).toMatchObject({ ok: true, value: { params: { width: 2, depth: 3 } } });
  });
});
