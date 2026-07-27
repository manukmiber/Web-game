/**
 * The JSON Schema subset used to describe tool inputs.
 *
 * A subset rather than the whole specification because these schemas travel to two places at
 * once: they are handed verbatim to a model as a tool's `input_schema`, and they are the
 * runtime guard between that model's guess and the scene document. Anything the validator here
 * could not enforce would be a promise on the wire that the code does not keep — so the
 * authored type and the checked type are deliberately the same type.
 *
 * The shapes are valid JSON Schema as written, so they serialise straight onto the wire with no
 * conversion step to drift out of sync.
 */

export interface SchemaBase {
  description?: string;
}

export interface StringSchema extends SchemaBase {
  type: 'string';
  enum?: readonly string[];
  default?: string;
}

export interface NumberSchema extends SchemaBase {
  type: 'number' | 'integer';
  minimum?: number;
  maximum?: number;
  default?: number;
}

export interface BooleanSchema extends SchemaBase {
  type: 'boolean';
  default?: boolean;
}

export interface ArraySchema extends SchemaBase {
  type: 'array';
  items: ToolSchema;
  minItems?: number;
  maxItems?: number;
  default?: readonly unknown[];
}

export interface ObjectSchema extends SchemaBase {
  type: 'object';
  properties: Record<string, ToolSchema>;
  required?: readonly string[];
  /** Defaults to false. True turns the object into a pass-through record. */
  additionalProperties?: boolean;
}

/**
 * Any JSON value. A schema with no `type` accepts anything, which is what JSON Schema already
 * means — `type: undefined` is the explicit marker that keeps the union discriminable in
 * TypeScript and disappears from the serialised form.
 */
export interface AnySchema extends SchemaBase {
  type?: undefined;
}

export type ToolSchema =
  | StringSchema
  | NumberSchema
  | BooleanSchema
  | ArraySchema
  | ObjectSchema
  | AnySchema;

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/**
 * Validates and normalises a tool's arguments.
 *
 * Every error is collected rather than thrown on the first one. A model that gets told about
 * three mistakes fixes them in one turn; told about the first, it spends three.
 */
export function validateInput<T = Record<string, unknown>>(
  schema: ObjectSchema,
  input: unknown,
): Validated<T> {
  const errors: string[] = [];
  const value = check(schema, input ?? {}, '', errors);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as T };
}

function label(path: string): string {
  return path === '' ? 'input' : `"${path}"`;
}

function child(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path === '' ? key : `${path}.${key}`;
}

function check(schema: ToolSchema, value: unknown, path: string, errors: string[]): unknown {
  if (schema.type === undefined) return value;

  switch (schema.type) {
    case 'string':
      return checkString(schema, value, path, errors);
    case 'number':
    case 'integer':
      return checkNumber(schema, value, path, errors);
    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push(`${label(path)}: expected true or false, got ${describe(value)}`);
        return undefined;
      }
      return value;
    case 'array':
      return checkArray(schema, value, path, errors);
    case 'object':
      return checkObject(schema, value, path, errors);
  }
}

function checkString(
  schema: StringSchema,
  value: unknown,
  path: string,
  errors: string[],
): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${label(path)}: expected a string, got ${describe(value)}`);
    return undefined;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${label(path)}: "${value}" is not one of ${schema.enum.join(', ')}`);
    return undefined;
  }
  return value;
}

/**
 * Numbers arrive as strings often enough to be worth accepting.
 *
 * Models emit `"3"` for a number field regularly, and rejecting it costs a whole round trip to
 * fix a value that was never ambiguous. The coercion is exact or nothing — `Number("3px")` is
 * NaN and still an error — so nothing is silently reinterpreted.
 */
function checkNumber(
  schema: NumberSchema,
  value: unknown,
  path: string,
  errors: string[],
): number | undefined {
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) {
    errors.push(`${label(path)}: expected a number, got ${describe(value)}`);
    return undefined;
  }
  if (schema.type === 'integer' && !Number.isInteger(numeric)) {
    errors.push(`${label(path)}: expected a whole number, got ${numeric}`);
    return undefined;
  }
  if (schema.minimum !== undefined && numeric < schema.minimum) {
    errors.push(`${label(path)}: must be at least ${schema.minimum}, got ${numeric}`);
    return undefined;
  }
  if (schema.maximum !== undefined && numeric > schema.maximum) {
    errors.push(`${label(path)}: must be at most ${schema.maximum}, got ${numeric}`);
    return undefined;
  }
  return numeric;
}

function checkArray(
  schema: ArraySchema,
  value: unknown,
  path: string,
  errors: string[],
): unknown[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${label(path)}: expected an array, got ${describe(value)}`);
    return undefined;
  }
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push(`${label(path)}: expected at least ${schema.minItems} items, got ${value.length}`);
    return undefined;
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    errors.push(`${label(path)}: expected at most ${schema.maxItems} items, got ${value.length}`);
    return undefined;
  }
  return value.map((item, index) => check(schema.items, item, child(path, index), errors));
}

function checkObject(
  schema: ObjectSchema,
  value: unknown,
  path: string,
  errors: string[],
): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${label(path)}: expected an object, got ${describe(value)}`);
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const required = new Set(schema.required ?? []);

  for (const [key, property] of Object.entries(schema.properties)) {
    const present = Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined;
    if (!present) {
      if (required.has(key)) errors.push(`${label(path)}: missing required field "${key}"`);
      else if ('default' in property && property.default !== undefined) out[key] = property.default;
      continue;
    }
    // A required field explicitly set to null reads as "I meant to leave this out"; treat it
    // the same as absent so the error says what is missing rather than what type it wasn't.
    if (source[key] === null && required.has(key)) {
      errors.push(`${label(path)}: missing required field "${key}"`);
      continue;
    }
    out[key] = check(property, source[key], child(path, key), errors);
  }

  if (schema.additionalProperties) {
    for (const [key, item] of Object.entries(source)) {
      if (!(key in schema.properties)) out[key] = item;
    }
    return out;
  }

  // Unknown fields are an error, not a shrug. A model that misspells `positon` and gets a
  // silent no-op will report success; one that gets the list of real field names fixes it.
  const known = Object.keys(schema.properties);
  for (const key of Object.keys(source)) {
    if (key in schema.properties) continue;
    errors.push(
      `${label(path)}: unknown field "${key}"${known.length > 0 ? ` — expected one of ${known.join(', ')}` : ''}`,
    );
  }
  return out;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return `the string "${value}"`;
  return String(value);
}

/** `{ type: 'number' }` three times over, which is how every position and colour is written. */
export function vec3Schema(description: string): ArraySchema {
  return { type: 'array', description, items: { type: 'number' }, minItems: 3, maxItems: 3 };
}
