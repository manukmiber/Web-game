import type { Component } from '../scene/types';
import { registerComponent, type FieldSchema } from './registry';

/**
 * The player-driven character. One per scene in practice, though nothing enforces that.
 *
 * Movement is kinematic — the controller writes the transform directly rather than pushing a
 * rigid body around — and that is the same choice Unity's `CharacterController` and Godot's
 * `CharacterBody3D` make, for the same reason: a player driven by forces feels like a shopping
 * trolley. Instant stops, air control and a jump that reaches a chosen height are all things a
 * dynamic body actively fights.
 *
 * What it *does* take from the solver, as of v0.7.5, is the world: gravity pulls it down, a
 * downward cast finds the floor it lands on, and a horizontal sweep stops it walking through
 * walls. Before that it was pinned to a fixed `groundHeight` with no collision at all, which
 * made every scene a flat plane whatever was actually built in it.
 */
export interface CharacterControllerComponent extends Component {
  type: 'CharacterController';
  /** Metres per second walking. */
  moveSpeed: number;
  /** Multiplier applied while Shift is held. */
  sprintMultiplier: number;
  /** Degrees per second for the turn keys. */
  turnSpeed: number;
  /**
   * Whether pointer travel turns the character.
   *
   * On by default, because "I moved the mouse and nothing happened" is the first thing anyone
   * reports about a first-person scene. It is still a field rather than a constant: a top-down
   * or side-on game wants the pointer aiming at something on screen, not steering the body, and
   * that is one tick box rather than a fork of this system.
   */
  mouseLook: boolean;
  /** Degrees of turn per pixel of pointer travel. 0.1–0.3 is the range shooters ship with. */
  lookSensitivity: number;
  /** Flips vertical look, the way a flight-sim player expects it. */
  invertLook: boolean;
  /**
   * How far the rig's camera may pitch away from level, in degrees.
   *
   * Short of 90 on purpose: at exactly 90 the view is looking straight down its own up axis,
   * where yaw and roll become the same rotation and the horizon spins.
   */
  maxPitch: number;
  /** Faction the NPC system matches against. */
  faction: string;
  maxHealth: number;
  /**
   * Y the character falls back to when nothing is below it.
   *
   * Still here, and still useful: a scene with no floor collider would otherwise drop the
   * player forever. It is the safety net rather than the mechanism now.
   */
  groundHeight: number;
  /** Turns gravity, jumping and ground casting off — the pre-v0.7.5 behaviour, on demand. */
  useGravity: boolean;
  /** Metres per second squared. Separate from scene gravity so a floaty player is one field. */
  gravity: number;
  /**
   * Take-off speed in metres per second.
   *
   * Expressed as a speed rather than a height because it composes: `v²/2g` gives the height,
   * so halving gravity for a floaty jump keeps the same take-off feel while doubling the arc,
   * which is what a designer actually wants from that dial.
   */
  jumpSpeed: number;
  /** Downward speed cap, so a long fall does not tunnel through the floor. */
  maxFallSpeed: number;
  /**
   * Grace period after walking off a ledge during which a jump still works, in seconds.
   *
   * Named after the cartoon, and in every platformer that feels good. Without it, players who
   * press jump on the last frame of the ledge — which is most of them — get nothing, and the
   * controls feel unresponsive rather than strict.
   */
  coyoteTime: number;
  /** Capsule radius used for the ground cast and the wall sweep. */
  radius: number;
  /** Capsule height, caps included. The camera usually sits near the top of it. */
  height: number;
  /** Slopes steeper than this are walls, in degrees. */
  maxSlopeAngle: number;
}

export function createCharacterController(
  overrides: Partial<CharacterControllerComponent> = {},
): CharacterControllerComponent {
  return {
    type: 'CharacterController',
    moveSpeed: 4,
    sprintMultiplier: 1.8,
    turnSpeed: 140,
    mouseLook: true,
    lookSensitivity: 0.15,
    invertLook: false,
    maxPitch: 80,
    faction: 'survivor',
    maxHealth: 100,
    groundHeight: 0,
    useGravity: true,
    gravity: 22,
    jumpSpeed: 7,
    maxFallSpeed: 40,
    coyoteTime: 0.12,
    radius: 0.4,
    height: 1.8,
    maxSlopeAngle: 50,
    ...overrides,
  };
}

registerComponent<CharacterControllerComponent>({
  type: 'CharacterController',
  label: 'Character Controller',
  create: createCharacterController,
  fields(component) {
    const fields: FieldSchema[] = [
      { kind: 'number', key: 'moveSpeed', label: 'Move Speed', min: 0, step: 0.1 },
      { kind: 'number', key: 'sprintMultiplier', label: 'Sprint x', min: 1, step: 0.1 },
      { kind: 'number', key: 'turnSpeed', label: 'Turn Speed', min: 1, step: 10 },
      { kind: 'boolean', key: 'mouseLook', label: 'Mouse Look' },
      { kind: 'string', key: 'faction', label: 'Faction' },
      { kind: 'number', key: 'maxHealth', label: 'Max Health', min: 1, step: 1 },
      { kind: 'number', key: 'radius', label: 'Radius', min: 0.05, step: 0.05 },
      { kind: 'number', key: 'height', label: 'Height', min: 0.2, step: 0.1 },
      { kind: 'boolean', key: 'useGravity', label: 'Use Gravity' },
    ];

    // Shown only when the control they configure is on, for the same reason the gravity fields
    // below are: a sensitivity slider that moves nothing is a bug report waiting to be filed.
    if (component.mouseLook) {
      fields.push(
        {
          kind: 'number',
          key: 'lookSensitivity',
          label: 'Look °/px',
          min: 0.01,
          max: 2,
          step: 0.01,
        },
        { kind: 'boolean', key: 'invertLook', label: 'Invert Look' },
        { kind: 'number', key: 'maxPitch', label: 'Max Pitch °', min: 0, max: 89, step: 1 },
      );
    }

    if (component.useGravity) {
      fields.push(
        { kind: 'number', key: 'gravity', label: 'Gravity', min: 0, step: 0.5 },
        { kind: 'number', key: 'jumpSpeed', label: 'Jump Speed', min: 0, step: 0.5 },
        { kind: 'number', key: 'maxFallSpeed', label: 'Max Fall', min: 1, step: 1 },
        { kind: 'number', key: 'coyoteTime', label: 'Coyote Time', min: 0, max: 1, step: 0.01 },
        { kind: 'number', key: 'maxSlopeAngle', label: 'Max Slope °', min: 0, max: 89, step: 1 },
      );
    }

    fields.push({ kind: 'number', key: 'groundHeight', label: 'Ground Height', step: 0.1 });
    return fields;
  },
});
