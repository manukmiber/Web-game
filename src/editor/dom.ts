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
