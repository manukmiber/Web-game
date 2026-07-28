import {
  DEFAULT_GRAPHICS,
  normalizeGraphics,
  type GraphicsSettings,
} from '@engine/render/GraphicsSettings';

const STORAGE = 'web3d-editor.graphics';

/**
 * Graphics settings persist per browser, not per scene.
 *
 * That split is deliberate and it is the same one every engine makes: how sharp the shadows are
 * is a property of the machine you are sitting at, while what colour the sky is belongs to the
 * scene and lives in the Environment component. Storing antialiasing in the scene file would
 * mean opening a colleague's scene on a laptop and having it try to run at their 8× MSAA.
 */
export function loadGraphicsSettings(): GraphicsSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE);
    if (!raw) return { ...DEFAULT_GRAPHICS };
    // Everything goes through normalize rather than being trusted: this is user-editable
    // storage that feeds straight into render-target allocation.
    return normalizeGraphics(JSON.parse(raw) as Partial<GraphicsSettings>);
  } catch {
    return { ...DEFAULT_GRAPHICS };
  }
}

export function saveGraphicsSettings(settings: GraphicsSettings): void {
  try {
    window.localStorage.setItem(STORAGE, JSON.stringify(settings));
  } catch {
    // Private browsing, or storage disabled. The session still works, it just won't persist.
  }
}
