import { describe, expect, it } from 'vitest';
import { consumesKey, isTextEntry } from './dom';

/** A stand-in for the focused element, which is all `consumesKey` reads. */
function target(tagName: string, isContentEditable = false) {
  return { tagName, isContentEditable } as unknown as EventTarget;
}

function key(init: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }) {
  return {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
  } as KeyboardEvent;
}

describe('isTextEntry', () => {
  it('claims every kind of field the user can type into', () => {
    expect(isTextEntry(target('INPUT'))).toBe(true);
    expect(isTextEntry(target('TEXTAREA'))).toBe(true);
    expect(isTextEntry(target('SELECT'))).toBe(true);
    expect(isTextEntry(target('DIV', true))).toBe(true);
    expect(isTextEntry(target('DIV'))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe('consumesKey', () => {
  it('gives a text field everything', () => {
    for (const k of ['a', 'Escape', 'F4', 'Delete', 'ArrowUp']) {
      expect(consumesKey(target('INPUT'), key({ key: k }))).toBe(true);
      expect(consumesKey(target('TEXTAREA'), key({ key: k }))).toBe(true);
    }
    expect(consumesKey(target('INPUT'), key({ key: 'z', ctrlKey: true }))).toBe(true);
  });

  it('leaves a focused select its type-ahead and its option keys', () => {
    // Typing "w" in the Add menu jumps to Wedge; it is not the Move tool's W.
    expect(consumesKey(target('SELECT'), key({ key: 'w' }))).toBe(true);
    expect(consumesKey(target('SELECT'), key({ key: 'ArrowDown' }))).toBe(true);
    expect(consumesKey(target('SELECT'), key({ key: 'Enter' }))).toBe(true);
  });

  /**
   * The regression this exists for: a `<select>` used to count as text entry outright, so every
   * shortcut died the moment anything was picked from the Add or Game menus — which is how
   * objects are created. No undo, no panel keys, no Ctrl+S, and no Escape out of Play mode.
   */
  it('does not let a focused select swallow the editor keys it cannot use', () => {
    const dead = [
      key({ key: 'Escape' }),
      key({ key: 'F4' }),
      key({ key: 'Delete' }),
      key({ key: 'z', ctrlKey: true }),
      key({ key: 's', ctrlKey: true }),
      key({ key: 'z', metaKey: true }),
      key({ key: 'd', ctrlKey: true }),
    ];
    for (const event of dead) expect(consumesKey(target('SELECT'), event)).toBe(false);
  });

  it('claims nothing for an ordinary element', () => {
    expect(consumesKey(target('CANVAS'), key({ key: 'w' }))).toBe(false);
    expect(consumesKey(null, key({ key: 'w' }))).toBe(false);
  });
});
