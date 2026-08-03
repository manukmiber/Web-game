import type { ScriptPropValue } from '../components/Script';
import type { InputState } from '../input/InputState';
import type {
  EntityHandle,
  ScriptAudio,
  ScriptClock,
  ScriptConsole,
  ScriptGame,
  ScriptHardware,
  ScriptMath,
  ScriptPhysics,
  ScriptWorld,
} from './ScriptApi';

/** Everything injected into a script's scope. Order must match `CONTEXT_KEYS`. */
export interface ScriptContext {
  entity: EntityHandle;
  scene: ScriptWorld;
  input: InputState;
  time: ScriptClock;
  props: Record<string, ScriptPropValue>;
  game: ScriptGame;
  physics: ScriptPhysics;
  hardware: ScriptHardware;
  audio: ScriptAudio;
  mathf: ScriptMath;
  console: ScriptConsole;
}

/** One collision or trigger overlap, as a script sees it. */
export interface ScriptCollision {
  /** The other entity's id. Resolve it with `scene.byId(...)` when a handle is wanted. */
  otherId: string;
  /** Unit vector pointing from this entity towards the other one. */
  normal: [number, number, number];
  point: [number, number, number];
  /** Overlap along the normal, in metres. */
  depth: number;
  /** Closing speed at the moment of contact — impact damage is a function of this. */
  impactSpeed: number;
}

/**
 * The hooks a script may define.
 *
 * All optional and all picked up by name, so the simplest useful script is three lines. The
 * list grew in v0.7.5 from three hooks to nine, which is the difference between "a script can
 * move something" and "a script can be a behaviour": physics needs a fixed-rate hook, a camera
 * needs to run after everything it follows, contacts need somewhere to arrive, and several
 * scripts on one object need a way to talk.
 */
export interface ScriptHooks {
  start?: (() => void) | null;
  update?: ((dt: number) => void) | null;
  /**
   * Called once per physics step, with the fixed step as `dt`.
   *
   * Anything that applies force belongs here rather than in `update`. A push applied once per
   * *frame* is a push whose strength depends on the frame rate, which is the single most
   * common physics bug in every engine that offers both hooks.
   */
  fixedUpdate?: ((dt: number) => void) | null;
  /** After every `update` in the scene has run. Where a follow camera belongs. */
  lateUpdate?: ((dt: number) => void) | null;
  onCollisionEnter?: ((collision: ScriptCollision) => void) | null;
  onCollisionStay?: ((collision: ScriptCollision) => void) | null;
  onCollisionExit?: ((otherId: string) => void) | null;
  onTriggerEnter?: ((collision: ScriptCollision) => void) | null;
  onTriggerExit?: ((otherId: string) => void) | null;
  /** A message from another script — see `scene.send` and `scene.broadcast`. */
  onMessage?: ((name: string, payload: unknown, senderId: string | null) => void) | null;
  destroy?: (() => void) | null;
}

/** Built once per unique source, called once per entity that uses it. */
export type ScriptFactory = (context: ScriptContext) => ScriptHooks;

export type CompileResult = { ok: true; factory: ScriptFactory } | { ok: false; error: string };

const CONTEXT_KEYS = [
  'entity',
  'scene',
  'input',
  'time',
  'props',
  'game',
  'physics',
  'hardware',
  'audio',
  'mathf',
  'console',
] as const;

/**
 * Identifiers bound to `undefined` in the script's scope.
 *
 * **This is a guard rail, not a sandbox.** It stops the accidents — a script that reaches for
 * `document`, a `setTimeout` that keeps firing after Play mode stops, a `fetch` in a loop — and
 * it makes the intended API discoverable, because the alternatives are visibly missing. It does
 * *not* contain hostile code: `eval` cannot be shadowed at all (it is illegal as a parameter
 * name in strict mode), and any object's `constructor.constructor` reconstructs `Function`
 * regardless. Scene JSON is therefore executable code and must be treated as such — do not run
 * a scene you would not run a script from.
 *
 * Real isolation is `engine/worker` (a script now genuinely runs on a different thread, with no
 * `document`/`window`/`localStorage` to reach *at all* — not merely shadowed, categorically
 * absent from that global scope). That does not make this list decorative: `constructor.
 * constructor` still rebuilds the *real* `Function`, and from there a script running inside the
 * simulation Worker could call the Worker's own genuine `postMessage`/`close`/
 * `addEventListener` directly, bypassing this wrapper and reaching the raw channel
 * `worker/protocol.ts` and `SimulationHost` are built to distrust. Shadowing the parameter names
 * here is what a script reaches for *first*, in both places it might be running — the point is
 * to keep the accidental path closed even though the deliberate one cannot be.
 */
const SHADOWED_GLOBALS = [
  'globalThis',
  'window',
  'document',
  'self',
  'top',
  'parent',
  'frames',
  'opener',
  'navigator',
  'location',
  'history',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'BroadcastChannel',
  'MessageChannel',
  'MessagePort',
  'Worker',
  'SharedWorker',
  'importScripts',
  'postMessage',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'close',
  'alert',
  'confirm',
  'prompt',
  'require',
  'process',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'Function',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'clearInterval',
  'queueMicrotask',
  'requestAnimationFrame',
] as const;

/**
 * Hooks are picked up by name rather than returned by the author.
 *
 * `typeof x === 'function'` on an identifier that was never declared is safe even under strict
 * mode — the one place `typeof` does not throw on an undeclared name — so a script that only
 * defines `update` needs no boilerplate for the two it skipped.
 */
const HOOK_NAMES = [
  'start',
  'update',
  'fixedUpdate',
  'lateUpdate',
  'onCollisionEnter',
  'onCollisionStay',
  'onCollisionExit',
  'onTriggerEnter',
  'onTriggerExit',
  'onMessage',
  'destroy',
] as const;

function wrap(source: string): string {
  // Built from the list rather than written out, so adding a hook is one entry in one array
  // instead of an edit here that has to agree with the `ScriptHooks` type by eye.
  const collected = HOOK_NAMES.map(
    (hook) => `  ${hook}: typeof ${hook} === 'function' ? ${hook} : null,`,
  ).join('\n');
  return `'use strict';
${source}
;return {
${collected}
};`;
}

/**
 * Compiled scripts, keyed by source text.
 *
 * A hundred zombies sharing one script compile once — which is the reason per-entity tuning
 * lives in `props` rather than in the source. Bounded because the editor recompiles on every
 * keystroke while a script is being typed during Play mode.
 */
const cache = new Map<string, CompileResult>();
const CACHE_LIMIT = 64;

export function compileScript(source: string): CompileResult {
  const cached = cache.get(source);
  if (cached) return cached;

  let result: CompileResult;
  try {
    const raw = new Function(...CONTEXT_KEYS, ...SHADOWED_GLOBALS, wrap(source)) as (
      ...args: unknown[]
    ) => ScriptHooks;
    const blanks = SHADOWED_GLOBALS.map(() => undefined);
    result = {
      ok: true,
      // Read off CONTEXT_KEYS rather than listed by hand: the parameter names and the
      // arguments are positional, and a hand-written list drifts from the array above the
      // first time a key is added in the middle — silently, because the mismatch shows up as
      // `console` being whatever the key after it holds.
      factory: (context) => raw(...CONTEXT_KEYS.map((key) => context[key]), ...blanks),
    };
  } catch (error) {
    result = { ok: false, error: describeError(error) };
  }

  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(source, result);
  return result;
}

export function clearScriptCache(): void {
  cache.clear();
}

/** Message plus the first stack frame that is inside the script, if there is one. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const line = /<anonymous>:(\d+):(\d+)/.exec(error.stack ?? '');
    // The wrapper adds one line ('use strict') above the author's first line, and Function
    // itself adds one for the parameter list — so the reported line is the author's + 2.
    const where = line ? ` (line ${Math.max(1, Number(line[1]) - 2)})` : '';
    return `${error.name}: ${error.message}${where}`;
  }
  return String(error);
}
