import { captureSaveGame, restoreSaveGame, type SaveGameData } from '@engine/gameplay/SaveGame';
import type { Engine } from '@engine/loop/Engine';
import type { ScenePersistence } from './persistence';

const PREFIX = 'webgame.save.';

/**
 * A keyed JSON store, same shape as `ScenePersistence` — but its own prefix and its own instance,
 * so a save-game slot and the editor's scene autosave can never collide on the same
 * `localStorage` key even though both end up going through `localStorage.setItem` underneath.
 * See `persistence.ts` for the scene-authoring half of this split, and `SaveGame.ts` for why the
 * two are different things to begin with.
 */
export class SaveGameStorage implements ScenePersistence {
  async save(key: string, json: string): Promise<void> {
    try {
      localStorage.setItem(PREFIX + key, json);
    } catch (error) {
      throw new Error(`Could not save "${key}" to local storage: ${(error as Error).message}`);
    }
  }

  async load(key: string): Promise<string | null> {
    return localStorage.getItem(PREFIX + key);
  }

  async list(): Promise<string[]> {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key.slice(PREFIX.length));
    }
    return keys.sort();
  }

  async remove(key: string): Promise<void> {
    localStorage.removeItem(PREFIX + key);
  }
}

export const QUICKSAVE_KEY = '__quicksave';

export async function saveGame(
  storage: ScenePersistence,
  engine: Engine,
  key = QUICKSAVE_KEY,
): Promise<void> {
  await storage.save(key, JSON.stringify(captureSaveGame(engine)));
}

export async function loadGame(
  storage: ScenePersistence,
  engine: Engine,
  key = QUICKSAVE_KEY,
): Promise<boolean> {
  const json = await storage.load(key);
  if (!json) return false;
  restoreSaveGame(engine, JSON.parse(json) as SaveGameData);
  return true;
}
