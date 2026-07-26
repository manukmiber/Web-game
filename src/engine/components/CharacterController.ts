import type { Component } from '../scene/types';
import { registerComponent } from './registry';

/**
 * The player-driven character. One per scene in practice, though nothing enforces that.
 *
 * Movement is kinematic: the controller writes the transform directly and clamps to a ground
 * height. There is no collision and no gravity, because there is no physics engine yet — and
 * a hand-rolled half-physics would be harder to remove later than to add now. What this does
 * give is the thing Play mode needed to stop being a no-op: something the camera can follow
 * and something the NPCs can react to.
 */
export interface CharacterControllerComponent extends Component {
  type: 'CharacterController';
  /** Metres per second walking. */
  moveSpeed: number;
  /** Multiplier applied while Shift is held. */
  sprintMultiplier: number;
  /** Degrees per second for the turn keys. */
  turnSpeed: number;
  /** Faction the NPC system matches against. */
  faction: string;
  maxHealth: number;
  /** Y the character is pinned to. A stand-in for ground collision. */
  groundHeight: number;
}

export function createCharacterController(
  overrides: Partial<CharacterControllerComponent> = {},
): CharacterControllerComponent {
  return {
    type: 'CharacterController',
    moveSpeed: 4,
    sprintMultiplier: 1.8,
    turnSpeed: 140,
    faction: 'survivor',
    maxHealth: 100,
    groundHeight: 0,
    ...overrides,
  };
}

registerComponent<CharacterControllerComponent>({
  type: 'CharacterController',
  label: 'Character Controller',
  create: createCharacterController,
  fields() {
    return [
      { kind: 'number', key: 'moveSpeed', label: 'Move Speed', min: 0, step: 0.1 },
      { kind: 'number', key: 'sprintMultiplier', label: 'Sprint x', min: 1, step: 0.1 },
      { kind: 'number', key: 'turnSpeed', label: 'Turn Speed', min: 1, step: 10 },
      { kind: 'string', key: 'faction', label: 'Faction' },
      { kind: 'number', key: 'maxHealth', label: 'Max Health', min: 1, step: 1 },
      { kind: 'number', key: 'groundHeight', label: 'Ground Height', step: 0.1 },
    ];
  },
});
