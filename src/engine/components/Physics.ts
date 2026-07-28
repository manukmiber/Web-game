import type { Component, Vec3 } from '../scene/types';
import { registerComponent } from './registry';

/** Earth, to two decimals. The default because a scene should fall the way people expect. */
export const EARTH_GRAVITY: Vec3 = [0, -9.81, 0];

/**
 * Scene-wide simulation settings: gravity, the fixed timestep, and how hard the solver works.
 *
 * A component on an entity, for exactly the reasons `Environment` is one — it round-trips
 * through the serializer, gets an Inspector from its field schema, and undoes through the
 * ordinary component command, all without a line of bespoke code. The first `Physics` component
 * in scene order wins; a scene without one simulates with these defaults, so gravity works the
 * moment you add a RigidBody rather than after you remember to configure the world.
 */
export interface PhysicsComponent extends Component {
  type: 'Physics';
  /** Acceleration in metres per second squared. Moon is about -1.62; a platformer wants -20. */
  gravity: Vec3;
  /**
   * Seconds per simulation step.
   *
   * Physics runs on a fixed step rather than the frame's `dt`, and this is the single most
   * important decision in the file. A variable step makes the simulation depend on frame rate:
   * the same jump reaches a different height on a 144 Hz monitor than on a 30 fps laptop,
   * penetration recovery oscillates when frames stutter, and a replay never reproduces. A fixed
   * step costs an accumulator and gives determinism.
   */
  fixedTimestep: number;
  /**
   * Ceiling on steps per frame.
   *
   * Without it, a frame that took 400 ms queues 24 steps, each of which takes longer than a
   * frame's budget, which makes the next frame worse — the "spiral of death" every fixed-step
   * loop has to defend against. Hitting the cap means time is discarded and the simulation runs
   * slow, which is the right failure: slow motion beats a locked tab.
   */
  maxSubsteps: number;
  /** Sequential-impulse passes per step. More is stiffer; 4–10 is the useful range. */
  solverIterations: number;
  /**
   * Fraction of remaining penetration pushed out per step, 0..1.
   *
   * Resolving overlap in one go adds energy the contact never had — bodies pop apart. Pushing
   * out a fraction each step converges without the pop.
   */
  positionCorrection: number;
  /**
   * Penetration left alone, in metres.
   *
   * Contacts have to be allowed to overlap slightly or resting bodies chatter: the solver
   * separates them, gravity presses them back, and the pair alternates every step forever.
   */
  allowedPenetration: number;
  /** Dynamic bodies slower than this for `sleepDelay` seconds stop being simulated. */
  sleepVelocity: number;
  sleepDelay: number;
}

export function createPhysics(overrides: Partial<PhysicsComponent> = {}): PhysicsComponent {
  return {
    type: 'Physics',
    fixedTimestep: 1 / 60,
    maxSubsteps: 4,
    solverIterations: 6,
    positionCorrection: 0.4,
    allowedPenetration: 0.005,
    sleepVelocity: 0.06,
    sleepDelay: 0.6,
    ...overrides,
    gravity: overrides.gravity ? [...overrides.gravity] : [...EARTH_GRAVITY],
  };
}

/** The settings a scene with no `Physics` component simulates with. */
export const DEFAULT_PHYSICS_SETTINGS: PhysicsComponent = createPhysics();

registerComponent<PhysicsComponent>({
  type: 'Physics',
  label: 'Physics',
  create: createPhysics,
  fields() {
    return [
      { kind: 'vec3', key: 'gravity', label: 'Gravity', step: 0.1 },
      {
        kind: 'number',
        key: 'fixedTimestep',
        label: 'Fixed Step',
        min: 1 / 240,
        max: 1 / 20,
        step: 0.001,
      },
      { kind: 'number', key: 'maxSubsteps', label: 'Max Substeps', min: 1, max: 16, integer: true },
      {
        kind: 'number',
        key: 'solverIterations',
        label: 'Iterations',
        min: 1,
        max: 32,
        integer: true,
      },
      {
        kind: 'number',
        key: 'positionCorrection',
        label: 'Correction',
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        kind: 'number',
        key: 'allowedPenetration',
        label: 'Slop',
        min: 0,
        max: 0.1,
        step: 0.001,
      },
      { kind: 'number', key: 'sleepVelocity', label: 'Sleep Below', min: 0, step: 0.01 },
      { kind: 'number', key: 'sleepDelay', label: 'Sleep After', min: 0, step: 0.1 },
    ];
  },
});
