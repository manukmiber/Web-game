import type { Component } from '../scene/types';
import { registerComponent, type FieldSchema } from './registry';

export const BODY_TYPES = ['Dynamic', 'Kinematic', 'Static'] as const;
export type BodyType = (typeof BODY_TYPES)[number];

/**
 * Makes an entity move under the solver.
 *
 * Three kinds, and the distinction is the one every engine draws:
 *
 * - **Dynamic** — gravity applies, contacts push it, scripts can shove it. A crate.
 * - **Kinematic** — moved by a script or an animation, pushes dynamic bodies, is never pushed
 *   back. A lift, a moving platform, a door.
 * - **Static** — never moves. Identical to a bare `Collider`, and offered anyway because
 *   "this entity has a body and it happens to be immovable" is how people think about it after
 *   toggling the dropdown twice.
 *
 * **Linear dynamics only: there is no angular velocity.** That is a real limitation and it is
 * chosen rather than missed. Rotational response needs an inertia tensor per shape, angular
 * impulses at contact points, and a solver that couples the two — perhaps three times the code
 * here — and the payoff is tumbling debris. What a survival game actually needs is that
 * characters fall, stop on floors, slide along walls and cannot walk through rocks, all of
 * which is linear. Bodies keep whatever rotation the author or a script gives them; contacts
 * simply never spin them. When tumbling is the feature being asked for, the honest move is a
 * real rigid-body library, not a half-solver grown here.
 */
export interface RigidBodyComponent extends Component {
  type: 'RigidBody';
  bodyType: BodyType;
  /** Kilograms. Ignored for non-dynamic bodies, which behave as infinitely heavy. */
  mass: number;
  /** Multiplies the scene's gravity for this body. 0 floats, negative rises, 2 falls hard. */
  gravityScale: number;
  /** Velocity retained per second, as a decay rate. 0 is a vacuum; 1 stops almost at once. */
  linearDamping: number;
  /** Terminal speed in metres per second. 0 means no limit. */
  maxSpeed: number;
  /** Motion locks, applied after integration — a 2D game locks Z, a lift locks X and Z. */
  lockX: boolean;
  lockY: boolean;
  lockZ: boolean;
  /**
   * Lets the body stop being simulated once it has been still for a while.
   *
   * Sleeping is not an optimisation detail you can leave out: without it a stack of crates
   * jitters forever, because the solver's positional correction and gravity trade a fraction of
   * a millimetre back and forth every frame and never agree.
   */
  canSleep: boolean;
}

export function createRigidBody(overrides: Partial<RigidBodyComponent> = {}): RigidBodyComponent {
  return {
    type: 'RigidBody',
    bodyType: 'Dynamic',
    mass: 1,
    gravityScale: 1,
    linearDamping: 0.02,
    maxSpeed: 0,
    lockX: false,
    lockY: false,
    lockZ: false,
    canSleep: true,
    ...overrides,
  };
}

registerComponent<RigidBodyComponent>({
  type: 'RigidBody',
  label: 'Rigid Body',
  create: createRigidBody,
  fields(component) {
    const fields: FieldSchema[] = [
      { kind: 'enum', key: 'bodyType', label: 'Type', options: BODY_TYPES },
    ];
    if (component.bodyType === 'Dynamic') {
      fields.push(
        { kind: 'number', key: 'mass', label: 'Mass', min: 0.001, step: 0.1 },
        { kind: 'number', key: 'gravityScale', label: 'Gravity Scale', step: 0.1 },
        { kind: 'number', key: 'linearDamping', label: 'Damping', min: 0, max: 1, step: 0.01 },
        { kind: 'number', key: 'maxSpeed', label: 'Max Speed', min: 0, step: 0.5 },
      );
    }
    fields.push(
      { kind: 'boolean', key: 'lockX', label: 'Lock X' },
      { kind: 'boolean', key: 'lockY', label: 'Lock Y' },
      { kind: 'boolean', key: 'lockZ', label: 'Lock Z' },
    );
    if (component.bodyType === 'Dynamic') {
      fields.push({ kind: 'boolean', key: 'canSleep', label: 'Can Sleep' });
    }
    return fields;
  },
});
