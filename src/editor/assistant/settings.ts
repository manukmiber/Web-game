import { ASSISTANT_MODELS, DEFAULT_MODEL, type AssistantModel } from './agent';

const KEY_STORAGE = 'web3d-editor.assistant.key';
const MODEL_STORAGE = 'web3d-editor.assistant.model';

export interface AssistantSettings {
  apiKey: string;
  model: AssistantModel;
}

/**
 * The key is the user's own, kept in their browser.
 *
 * There is no backend to proxy through — the editor is a static site — so the alternatives were
 * a key in the bundle (shared, and public the moment anyone opens devtools) or no assistant at
 * all. localStorage is the honest middle: it is the user's key, spent from their account, on
 * their machine. `VITE_ANTHROPIC_API_KEY` exists for local development so a key does not have
 * to be pasted in on every fresh profile; it must not be set for a deployed build, and the
 * README says so.
 */
export function loadAssistantSettings(): AssistantSettings {
  const stored = safeRead(KEY_STORAGE);
  const model = safeRead(MODEL_STORAGE) as AssistantModel | null;
  return {
    apiKey: stored ?? import.meta.env.VITE_ANTHROPIC_API_KEY ?? '',
    model: model && ASSISTANT_MODELS.includes(model) ? model : DEFAULT_MODEL,
  };
}

export function saveAssistantSettings(settings: Partial<AssistantSettings>): void {
  try {
    if (settings.apiKey !== undefined) {
      if (settings.apiKey) window.localStorage.setItem(KEY_STORAGE, settings.apiKey);
      else window.localStorage.removeItem(KEY_STORAGE);
    }
    if (settings.model !== undefined) window.localStorage.setItem(MODEL_STORAGE, settings.model);
  } catch {
    // Private browsing, or storage disabled. The session still works, it just won't persist.
  }
}

function safeRead(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
