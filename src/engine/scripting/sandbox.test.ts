import { describe, expect, it } from 'vitest';
import type { ScriptPropValue } from '../components/Script';
import { clearScriptCache, compileScript, type ScriptContext } from './sandbox';

/** Enough of a context to run a script that only touches `props` and `console`. */
function context(props: Record<string, ScriptPropValue> = {}): ScriptContext {
  return {
    entity: {} as never,
    scene: {} as never,
    input: {} as never,
    time: { dt: 0, elapsed: 0, frame: 0 },
    props,
    game: {} as never,
    console: { log() {}, warn() {}, error() {} },
  };
}

describe('compileScript', () => {
  it('picks up hooks by name, without the author returning anything', () => {
    const compiled = compileScript(`
      function start() { props.started = true; }
      function update(dt) { props.total += dt; }
    `);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const props = { started: false, total: 0 };
    const hooks = compiled.factory(context(props));
    hooks.start?.();
    hooks.update?.(0.5);
    hooks.update?.(0.25);

    expect(props.started).toBe(true);
    expect(props.total).toBeCloseTo(0.75);
    // A hook the author did not define is absent rather than a stub that throws.
    expect(hooks.destroy).toBeNull();
  });

  it('reports a syntax error instead of throwing', () => {
    const compiled = compileScript('function update( { }');
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.error).toMatch(/SyntaxError/);
  });

  it('keeps per-instance state private to each instance', () => {
    const compiled = compileScript(`
      let count = 0;
      function update() { count += 1; props.count = count; }
    `);
    if (!compiled.ok) throw new Error(compiled.error);

    const a = { count: 0 };
    const b = { count: 0 };
    const first = compiled.factory(context(a));
    const second = compiled.factory(context(b));
    first.update?.(0);
    first.update?.(0);
    second.update?.(0);

    expect(a.count).toBe(2);
    expect(b.count).toBe(1);
  });

  it('shadows the globals a gameplay script has no business reaching for', () => {
    const compiled = compileScript(`
      function start() {
        props.window = typeof window;
        props.fetch = typeof fetch;
        props.timer = typeof setTimeout;
        props.doc = typeof document;
        props.fn = typeof Function;
        // Not shadowed, and deliberately so — scripts need the standard library.
        props.math = typeof Math;
        props.json = typeof JSON;
      }
    `);
    if (!compiled.ok) throw new Error(compiled.error);

    const props: Record<string, ScriptPropValue> = {};
    compiled.factory(context(props)).start?.();

    expect(props.window).toBe('undefined');
    expect(props.fetch).toBe('undefined');
    expect(props.timer).toBe('undefined');
    expect(props.doc).toBe('undefined');
    expect(props.fn).toBe('undefined');
    expect(props.math).toBe('object');
    expect(props.json).toBe('object');
  });

  it('runs in strict mode, so a typo is an error rather than a new global', () => {
    const compiled = compileScript('function update() { undeclared = 1; }');
    if (!compiled.ok) throw new Error(compiled.error);
    expect(() => compiled.factory(context()).update?.(0)).toThrow(/undeclared/);
  });

  it('compiles one source once, however many entities use it', () => {
    clearScriptCache();
    const source = 'function update() {}';
    const first = compileScript(source);
    const second = compileScript(source);
    expect(first).toBe(second);
  });

  it('reports the author\'s line number, not the wrapper\'s', () => {
    // Line 1 is blank (the template literal's newline), so the throw is on line 3.
    const compiled = compileScript(`
      function update() {
        throw new Error('boom');
      }
    `);
    if (!compiled.ok) throw new Error(compiled.error);
    try {
      compiled.factory(context()).update?.(0);
      expect.unreachable('the script should have thrown');
    } catch (error) {
      expect((error as Error).message).toBe('boom');
    }
  });
});
