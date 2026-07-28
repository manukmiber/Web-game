import { NpcSystem } from '../ai/NpcSystem';
import { HardwareSystem } from '../hardware/HardwareSystem';
import type { Engine } from '../loop/Engine';
import { PhysicsSystem } from '../physics/PhysicsSystem';
import { ScriptSystem } from '../scripting/ScriptSystem';
import { CharacterSystem } from './CharacterSystem';

export interface GameplaySystems {
  hardware: HardwareSystem;
  physics: PhysicsSystem;
  scripts: ScriptSystem;
  characters: CharacterSystem;
  npcs: NpcSystem;
}

/**
 * Installs the Play-mode systems and hands back the instances, so a host can read diagnostics
 * off them (script messages, agent states, solver load) without going through the engine's
 * system list.
 *
 * Lives here rather than in `Engine` so the loop stays ignorant of gameplay — the editor and
 * the runtime both call this, and a headless simulation can install a different set.
 *
 * **Order is the design.**
 *
 * 1. **Hardware** first, so a physical button that arrived between two frames is
 *    indistinguishable from a key pressed in the same frame — anything later would give the rig
 *    a systematic one-frame handicap against the keyboard.
 * 2. **Physics** next. It steps the world with the velocities scripts set last frame and emits
 *    this frame's contacts, which is what lets the ScriptSystem below deliver
 *    `onCollisionEnter` in the frame the collision happened rather than the one after. It is
 *    also why `fixedUpdate` can be driven off the step count the solver just reported.
 * 3. **Scripts**, so a decision a script makes is visible to everything else in the same frame.
 * 4. **The character**, so agents chase where the player *is*, not where they were a frame ago
 *    — a one-frame lag that is invisible at 60 fps and very visible at 20.
 * 5. **NPCs** last, reacting to a world that has finished moving.
 */
export function installGameplaySystems(engine: Engine): GameplaySystems {
  const hardware = new HardwareSystem();
  const physics = new PhysicsSystem();
  const characters = new CharacterSystem();
  const scripts = new ScriptSystem({ physics, characters });
  const npcs = new NpcSystem();

  engine.addSystem(hardware);
  engine.addSystem(physics);
  engine.addSystem(scripts);
  engine.addSystem(characters);
  engine.addSystem(npcs);

  return { hardware, physics, scripts, characters, npcs };
}
