/**
 * True when the user is typing, so shortcuts and Play-mode input don't hijack their keystrokes.
 *
 * Shared by the shortcut layer and the viewport: both listen on `window`, and both have to
 * agree on what "the user is typing" means, or renaming an entity mid-play would walk the
 * character across the map.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
}

/**
 * Whether the focused element will do something with *this* key itself.
 *
 * `isTextEntry` answers the coarser question — should the character the user just typed be
 * theirs — and a `<select>` has to count for it, or typing "w" to jump to "Wedge" in the Add
 * menu would walk the character forward instead. But it is far too broad as a shortcut guard: a
 * native select claims type-ahead and its arrow keys and nothing else, and treating it like a
 * text field is why every shortcut in the editor went dead after picking anything from a menu.
 * The menus are how objects get created, so this was reachable within two clicks of opening the
 * editor: no undo, no panel keys, no Ctrl+S — and no Escape to leave Play mode, which left the
 * toolbar's Stop button as the only way out of a running scene.
 *
 * Chords and named keys are therefore always the editor's. The select keeps what it can use.
 */
export function consumesKey(target: EventTarget | null, event: KeyboardEvent): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || element.isContentEditable) return true;
  if (tag !== 'SELECT') return false;
  // A modified key is never type-ahead, so it cannot be the select's.
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  // Single characters are type-ahead; the rest of a select's keyboard steps its options.
  if (event.key.length === 1) return true;
  return SELECT_KEYS.has(event.key);
}

/** The named keys an open or focused `<select>` acts on. Everything else belongs to the editor. */
const SELECT_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter']);

/**
 * Whether the primary pointer is a finger rather than a mouse.
 *
 * Asked rather than assumed from screen width, because the two are genuinely independent: a
 * 13-inch touchscreen laptop is a wide coarse pointer and a desktop window dragged narrow is a
 * narrow fine one. What changes for a finger is hit-target size — the transform gizmo's arrows
 * are about three millimetres wide on a phone — and that has nothing to do with how much room
 * the panels get.
 *
 * `matchMedia` is guarded because this module is imported by tests that run without a DOM.
 */
export function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

/** True when the device can deliver touch events at all — a tablet, a phone, a touch laptop. */
export function hasTouchInput(): boolean {
  if (typeof window === 'undefined') return false;
  return 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
}
