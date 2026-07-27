import type { Component } from '../scene/types';
import { registerComponent, type FieldSchema } from './registry';

/** Only these types survive a round-trip through scene JSON, so only these are offered. */
export type ScriptPropValue = number | string | boolean;

export interface ScriptComponent extends Component {
  type: 'Script';
  /** Shown in the console and in error messages; purely cosmetic. */
  name: string;
  /** The behaviour body. See docs/SCRIPTING.md for the API it is evaluated against. */
  source: string;
  enabled: boolean;
  /**
   * Author-declared tunables, exposed to the script as `props` and to the Inspector as fields.
   *
   * They exist so a script can be written once and tuned per entity — twenty zombies sharing
   * one source but each with its own `speed` — which is also what keeps the compile cache
   * effective: props vary, source doesn't, so twenty entities compile once.
   */
  props: Record<string, ScriptPropValue>;
}

export const DEFAULT_SCRIPT_SOURCE = `// Runs in Play mode. See docs/SCRIPTING.md for the full API.
// Injected: entity, scene, input, time, props, game, hardware, console.

function start() {
  console.log(entity.name + ' started');
}

function update(dt) {
  entity.rotation.y += props.spin * dt;
}
`;

export function createScript(overrides: Partial<ScriptComponent> = {}): ScriptComponent {
  return {
    type: 'Script',
    name: 'New Script',
    source: DEFAULT_SCRIPT_SOURCE,
    enabled: true,
    ...overrides,
    // The default prop belongs to the default source. A caller supplying its own props gets
    // exactly those, or every script in the project would carry a stray `spin`.
    props: overrides.props ? { ...overrides.props } : { spin: 45 },
  };
}

/** Inspector widget kind for a prop, chosen from the value it currently holds. */
function fieldForProp(key: string, value: ScriptPropValue): FieldSchema {
  const label = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
  if (typeof value === 'number') return { kind: 'number', key: `props.${key}`, label, step: 0.1 };
  if (typeof value === 'boolean') return { kind: 'boolean', key: `props.${key}`, label };
  // A colour prop is worth the guess: "#rrggbb" in a text box is unusable next to a swatch.
  if (/^#[0-9a-f]{6}$/i.test(value)) return { kind: 'color', key: `props.${key}`, label };
  return { kind: 'string', key: `props.${key}`, label };
}

registerComponent<ScriptComponent>({
  type: 'Script',
  label: 'Script',
  create: createScript,
  /**
   * `source` is deliberately absent: it gets the dedicated editor panel below the component,
   * the same way the modifier stack does, because a one-line text input is not a code editor.
   */
  fields(component) {
    return [
      { kind: 'string', key: 'name', label: 'Name' },
      { kind: 'boolean', key: 'enabled', label: 'Enabled' },
      ...Object.entries(component.props ?? {}).map(([key, value]) => fieldForProp(key, value)),
    ];
  },
});
