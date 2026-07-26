import type { ScriptPropValue } from '../components/Script';
import type { InputState } from '../input/InputState';
import type { EntityHandle, ScriptConsole, ScriptGame, ScriptTime, ScriptWorld } from './ScriptApi';

/** Everything injected into a script's scope. Order must match `CONTEXT_KEYS`. */
export interface ScriptContext {
  entity: EntityHandle;
  scene: ScriptWorld;
  input: InputState;
  time: ScriptTime;
  props: Record<string, ScriptPropValue>;
  game: ScriptGame;
  console: ScriptConsole;
}

export interface ScriptHooks {
  start?: (() => void) | null;
  update?: ((dt: number) => void) | null;
  destroy?: (() => void) | null;
}

/** Built once per unique source, called once per entity that uses it. */
export type ScriptFactory = (context: ScriptContext) => ScriptHooks;

export type CompileResult = { ok: true; factory: ScriptFactory } | { ok: false; error: string };

const CONTEXT_KEYS = ['entity', 'scene', 'input', 'time', 'props', 'game', 'console'] as const;

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
 * Real isolation means a Worker or a sandboxed iframe with its own CSP, where the script has no
 * shared heap to reach into. That is a Phase 3 item, and it needs the script API to be
 * message-based first; this list is what makes the API worth freezing before then.
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
  'Worker',
  'SharedWorker',
  'importScripts',
  'postMessage',
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
function wrap(source: string): string {
  return `'use strict';
${source}
;return {
  start: typeof start === 'function' ? start : null,
  update: typeof update === 'function' ? update : null,
  destroy: typeof destroy === 'function' ? destroy : null,
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
      factory: (context) =>
        raw(
          context.entity,
          context.scene,
          context.input,
          context.time,
          context.props,
          context.game,
          context.console,
          ...blanks,
        ),
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
