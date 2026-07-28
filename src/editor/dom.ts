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
