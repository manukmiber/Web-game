import { snapshotScene, type Engine, type SceneSnapshot } from '../loop/Engine';
import type { GameStateSnapshot } from './GameState';

export const SAVE_GAME_VERSION = 1;

/**
 * A player's save file: the scene as it stood when it was written, plus the gameplay state that
 * lives outside the scene on purpose (`GameState`'s health, factions and script variables — see
 * its own doc comment on why that split exists).
 *
 * This is a different thing from the editor's scene autosave (`editor/state/persistence.ts`),
 * which remembers what someone was *authoring*. A save game remembers what someone was
 * *playing* — a zombie at 12 health is exactly the state the Play-mode snapshot throws away on
 * Stop (§6) and exactly the state a save file exists to keep.
 */
export interface SaveGameData {
  /** Bumped the day a save from an older build needs a migration this file doesn't have yet. */
  version: typeof SAVE_GAME_VERSION;
  savedAt: number;
  scene: SceneSnapshot;
  game: GameStateSnapshot;
}

/**
 * Captures everything a save needs to resume exactly where the player was.
 *
 * Works in either mode, deliberately: capturing outside Play returns an empty `GameState` (there
 * is nothing to lose) rather than refusing, so a "save on scene load" checkpoint does not need a
 * special case for the moment before the player has pressed Play at all.
 */
export function captureSaveGame(engine: Engine): SaveGameData {
  return {
    version: SAVE_GAME_VERSION,
    savedAt: Date.now(),
    scene: snapshotScene(engine.scene),
    game: engine.game.toJSON(),
  };
}

/**
 * Loads a save file into a running engine.
 *
 * This is not the same operation as `Engine.setMode('play')` restoring its snapshot, even though
 * both end in `scene.load` — that restore always returns to the *authored* scene and always
 * accompanies a mode flip. A save load can happen mid-session, replaces the scene with whatever
 * was true the moment it was written, and leaves the engine in whatever mode it was already in:
 * loading from a title screen is "load, then press Play", not a mode change on its own.
 *
 * NPC and script runtime state (an agent's wander target, a script's own closures) is
 * deliberately left alone. Those live in their systems, keyed by entity id, and a save/load
 * replacing positions and health while leaving *behaviour* running is the intended difference
 * from a Stop — see `GameState.fromJSON`'s note on `restored` vs `reset`.
 */
export function restoreSaveGame(engine: Engine, data: SaveGameData): void {
  engine.scene.load(data.scene);
  engine.game.fromJSON(data.game);
  // Every body described stale entities the load just replaced wholesale — the same reason
  // `Engine.setMode` clears physics when it restores the Play snapshot.
  engine.physics.clear();
}
