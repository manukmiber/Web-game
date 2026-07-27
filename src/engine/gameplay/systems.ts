import { NpcSystem } from '../ai/NpcSystem';
import { HardwareSystem } from '../hardware/HardwareSystem';
import type { Engine } from '../loop/Engine';
import { ScriptSystem } from '../scripting/ScriptSystem';
import { CharacterSystem } from './CharacterSystem';

export interface GameplaySystems {
  hardware: HardwareSystem;
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
 * **Order is the design.** Hardware runs first, so a physical button that arrived between two
 * frames is indistinguishable from a key pressed in the same frame — anything later would give
 * the rig a systematic one-frame handicap against the keyboard. Scripts run next, so a decision
 * a script makes is visible to everything else in the same frame rather than the next one. The
 * character moves after that, so agents chase where the player *is*, not where they were a
 * frame ago — a one-frame lag that is invisible at 60 fps and very visible at 20.
 */
export function installGameplaySystems(engine: Engine): GameplaySystems {
  const hardware = new HardwareSystem();
  const scripts = new ScriptSystem();
  const characters = new CharacterSystem();
  const npcs = new NpcSystem();
  engine.addSystem(hardware);
  engine.addSystem(scripts);
  engine.addSystem(characters);
  engine.addSystem(npcs);
  return { hardware, scripts, characters, npcs };
}
