import { NpcSystem } from '../ai/NpcSystem';
import type { Engine } from '../loop/Engine';
import { ScriptSystem } from '../scripting/ScriptSystem';
import { CharacterSystem } from './CharacterSystem';

export interface GameplaySystems {
  scripts: ScriptSystem;
  characters: CharacterSystem;
  npcs: NpcSystem;
}

/**
 * Installs the Play-mode systems and hands back the instances, so a host can read diagnostics
 * off them (script messages, agent states) without going through the engine's system list.
 *
 * Lives here rather than in `Engine` so the loop stays ignorant of gameplay — the editor and
 * the runtime both call this, and a headless simulation can install a different set.
 *
 * **Order is the design.** Scripts run first, so a decision a script makes is visible to
 * everything else in the same frame rather than the next one. The character moves next, so
 * agents chase where the player *is*, not where they were a frame ago — a one-frame lag that
 * is invisible at 60 fps and very visible at 20.
 */
export function installGameplaySystems(engine: Engine): GameplaySystems {
  const scripts = new ScriptSystem();
  const characters = new CharacterSystem();
  const npcs = new NpcSystem();
  engine.addSystem(scripts);
  engine.addSystem(characters);
  engine.addSystem(npcs);
  return { scripts, characters, npcs };
}
