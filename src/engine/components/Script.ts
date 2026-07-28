import type { Component } from '../scene/types';
import { registerComponent, type FieldSchema } from './registry';

/** Only these types survive a round-trip through scene JSON, so only these are offered. */
export type ScriptPropValue = number | string | boolean;

export interface ScriptComponent extends Component {
  type: 'Script';
  /**
   * Identity of this behaviour, stable across edits and reloads.
   *
   * Needed the moment an entity can carry several scripts: the running instance, its console
   * output and its error state all have to stay attached to *this* behaviour while the one
   * above it is renamed, reordered or deleted. Position in the array cannot do that — deleting
   * the first script would silently hand its running state to the second.
   */
  id: string;
  /** Shown in the console and in error messages; purely cosmetic. */
  name: string;
  /** The behaviour body. See docs/SCRIPTING.md for the API it is evaluated against. */
  source: string;
  enabled: boolean;
  /**
   * Execution order within a frame. Lower runs first; ties break on scene order.
   *
   * With one script per entity the order was whatever scene iteration happened to produce, and
   * nothing depended on it. With several — an input reader, a movement behaviour, a camera that
   * follows the result — order is the difference between a camera that tracks the player and
   * one that lags a frame behind them. The same idea as Unity's script execution order, and a
   * number rather than a global list so it travels with the component.
   */
  order: number;
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
// Injected: entity, scene, input, time, props, game, physics, hardware, mathx, console.

function start() {
  console.log(entity.name + ' started');
}

function update(dt) {
  entity.rotation.y += props.spin * dt;
}
`;

let scriptCounter = 0;

/** Unique enough for a scene file, and short enough to read in one. */
export function generateScriptId(): string {
  scriptCounter += 1;
  return `s${Date.now().toString(36)}${scriptCounter.toString(36)}`;
}

export function createScript(overrides: Partial<ScriptComponent> = {}): ScriptComponent {
  return {
    type: 'Script',
    id: generateScriptId(),
    name: 'New Script',
    source: DEFAULT_SCRIPT_SOURCE,
    enabled: true,
    order: 0,
    ...overrides,
    // The default prop belongs to the default source. A caller supplying its own props gets
    // exactly those, or every script in the project would carry a stray `spin`.
    props: overrides.props ? { ...overrides.props } : { spin: 45 },
  };
}

/**
 * The id of a script, inventing a stable one for components saved before the field existed.
 *
 * Derived from the entity and the component's position rather than generated fresh, so the
 * same script gets the same id on every load and its running instance survives the frame —
 * a fresh `generateScriptId()` here would rebuild every legacy script sixty times a second.
 */
export function scriptIdOf(script: ScriptComponent, entityId: string, index: number): string {
  return script.id || `${entityId}#${index}`;
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
   * One entity, many behaviours.
   *
   * The alternative — one script per entity, and a second entity when you need a second
   * behaviour — is what this build had until v0.7.5, and it distorts scenes: a crate that
   * floats, spins and explodes on contact became three nested entities whose transforms had
   * nothing to do with the structure. Composition is the point of a component model, and
   * scripts were the one component that could not compose.
   */
  allowMultiple: true,
  /**
   * `source` is deliberately absent: it gets the dedicated editor panel below the component,
   * the same way the modifier stack does, because a one-line text input is not a code editor.
   */
  fields(component) {
    return [
      { kind: 'string', key: 'name', label: 'Name' },
      { kind: 'boolean', key: 'enabled', label: 'Enabled' },
      { kind: 'number', key: 'order', label: 'Order', step: 1, integer: true },
      ...Object.entries(component.props ?? {}).map(([key, value]) => fieldForProp(key, value)),
    ];
  },
});
