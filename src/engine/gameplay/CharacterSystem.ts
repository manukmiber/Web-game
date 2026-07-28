import type { CharacterControllerComponent } from '../components/CharacterController';
import type { Engine, EngineMode, System } from '../loop/Engine';
import { DEG2RAD, wrapAngle } from '../ai/steering';
import { add, inverseTransformPoint, length, scale, sub } from '../physics/math';
import { worldTransformOf } from '../physics/PhysicsSystem';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { WorldShape } from '../physics/shapes';
import type { Entity, EntityId, Vec3 } from '../scene/types';

/** Depenetration passes per frame. Three resolves a corner; more is chasing rounding error. */
const RESOLVE_PASSES = 4;

/** Extra reach on the ground probe, so resting exactly on a surface still counts as grounded. */
const GROUND_PROBE_SKIN = 0.08;

/** Downhill snap distance. Beyond this the character is genuinely airborne, not on a slope. */
const GROUND_SNAP_DISTANCE = 0.4;

interface CharacterState {
  verticalVelocity: number;
  /** Seconds left in which a jump is still allowed after leaving the ground. */
  coyote: number;
  grounded: boolean;
  groundNormal: Vec3;
}

/**
 * Turns key state into character movement.
 *
 * The control scheme is the one that needs no mouse capture, since the editor viewport is a
 * panel in a page rather than a locked-pointer game window:
 *
 * - `W`/`S` or `↑`/`↓` — forward and back along the character's facing
 * - `A`/`D` — strafe
 * - `←`/`→` or `Q`/`E` — turn
 * - `Shift` — sprint
 * - `Space` — jump
 *
 * External hardware reaches the same character through three named analog axes — `move`,
 * `strafe` and `turn`, all positive forward/right/right — which are summed with the keys rather
 * than replacing them. A scene therefore does not have to know whether it is being played with a
 * keyboard or a cockpit, and one built with either works with the other.
 *
 * **Movement is kinematic and collision is resolved by depenetration**, not by the solver. The
 * character places its capsule where the input asked for, discovers what it is now inside, and
 * pushes back out along each contact normal. Doing it this way rather than by giving the player
 * a dynamic RigidBody is what keeps stopping instant, air control possible and jump height
 * exact — see `CharacterControllerComponent` for the longer version of that argument.
 *
 * A Camera entity parented to the character inherits all of it, which is the whole third-person
 * rig: no follow code, no lerp, just the transform hierarchy doing its job.
 */
export class CharacterSystem implements System {
  readonly name = 'CharacterSystem';
  readonly runsIn: readonly EngineMode[] = ['play'];

  private states = new Map<EntityId, CharacterState>();

  /** Dropped on every mode change, so a play session never starts mid-fall. */
  reset(): void {
    this.states.clear();
  }

  /** Whether a character is standing on something. Read by scripts through `entity.grounded`. */
  isGrounded(id: EntityId): boolean {
    return this.states.get(id)?.grounded ?? false;
  }

  verticalVelocity(id: EntityId): number {
    return this.states.get(id)?.verticalVelocity ?? 0;
  }

  /** Lets a script launch a character — a jump pad, a knockback, a grapple. */
  setVerticalVelocity(id: EntityId, value: number): void {
    const state = this.states.get(id);
    if (!state) return;
    state.verticalVelocity = value;
    if (value > 0) {
      state.grounded = false;
      state.coyote = 0;
    }
  }

  update(dt: number, engine: Engine): void {
    const { scene, input, game, physics } = engine;
    const live = new Set<EntityId>();

    for (const entity of scene.all()) {
      const controller = entity.components.find(
        (c): c is CharacterControllerComponent => c.type === 'CharacterController',
      );
      if (!controller) continue;

      live.add(entity.id);
      game.register(entity.id, controller.faction, controller.maxHealth);

      let state = this.states.get(entity.id);
      if (!state) {
        // Assumed grounded on the first frame. A character is authored standing on something,
        // and starting airborne means the first press of Space after entering Play mode does
        // nothing — which reads as a dropped input rather than as physics being careful.
        state = { verticalVelocity: 0, coyote: 0, grounded: true, groundNormal: [0, 1, 0] };
        this.states.set(entity.id, state);
      }

      if (!game.isAlive(entity.id)) continue;

      const { rotation } = entity.transform;

      // Keys and the named analog axes are summed, so a stick and the keyboard drive the same
      // character without either knowing about the other — and an unplugged rig leaves the
      // axes at zero, which is exactly the keyboard-only behaviour this had before.
      const turn =
        input.axis('ArrowRight', 'ArrowLeft') + input.axis('KeyE', 'KeyQ') - input.getAxis('turn');
      const forward =
        input.axis('KeyS', 'KeyW') + input.axis('ArrowDown', 'ArrowUp') + input.getAxis('move');
      // A strafes left. It used to strafe right — `axis('KeyD', 'KeyA')` reads "A minus D",
      // and local +X is right — which nobody noticed until an analog stick had to agree with
      // it and the sign had to be written down.
      const strafe = input.axis('KeyA', 'KeyD') + input.getAxis('strafe');

      if (turn !== 0) {
        // Analog turn is proportional; the keys still turn at full rate because they read ±1.
        const rate = Math.max(-1, Math.min(1, turn));
        rotation[1] = wrapAngle(rotation[1] + rate * controller.turnSpeed * dt);
      }

      const [dx, dz] = horizontalStep(controller, rotation[1], forward, strafe, input, dt);
      const dy = this.verticalStep(controller, state, input, dt);

      this.move(engine, entity, controller, state, [dx, dy, dz], physics);
    }

    // A character deleted mid-play must not leave its fall speed behind; ids are unique, so
    // nothing would inherit it, but the map would grow for the whole session.
    for (const id of [...this.states.keys()]) if (!live.has(id)) this.states.delete(id);
  }

  // ---------------------------------------------------------------- internal

  /** Gravity, jumping and coyote time. Returns the vertical displacement for this frame. */
  private verticalStep(
    controller: CharacterControllerComponent,
    state: CharacterState,
    input: Engine['input'],
    dt: number,
  ): number {
    if (controller.useGravity === false) {
      state.verticalVelocity = 0;
      return 0;
    }

    state.coyote = state.grounded ? controller.coyoteTime : Math.max(0, state.coyote - dt);

    if (input.wasPressed('Space') && (state.grounded || state.coyote > 0)) {
      state.verticalVelocity = controller.jumpSpeed;
      state.grounded = false;
      state.coyote = 0;
    } else if (state.grounded && state.verticalVelocity <= 0) {
      // A small downward bias rather than zero. It is what keeps a character pinned to the
      // ground while walking over a seam between two floor colliders, instead of being lifted
      // by the first millimetre of penetration correction and re-landing every few steps.
      state.verticalVelocity = -1;
    } else {
      state.verticalVelocity -= controller.gravity * dt;
    }

    const terminal = -Math.abs(controller.maxFallSpeed);
    if (state.verticalVelocity < terminal) state.verticalVelocity = terminal;
    return state.verticalVelocity * dt;
  }

  /**
   * Applies a displacement, resolves whatever it collided with, and writes the result back.
   *
   * Horizontal and vertical motion are resolved together in one pass rather than separately.
   * Two passes is the textbook arrangement and it produces a character that can climb walls by
   * jumping into them: the vertical pass sees a wall contact with an upward component and reads
   * it as ground. One pass with an explicit slope test does not.
   */
  private move(
    engine: Engine,
    entity: Entity,
    controller: CharacterControllerComponent,
    state: CharacterState,
    delta: Vec3,
    physics: PhysicsWorld,
  ): void {
    const world = worldTransformOf(engine.scene, entity);
    const wasGrounded = state.grounded;
    let position = add(world.position, delta);

    const radius = Math.max(0.02, controller.radius);
    const halfBarrel = Math.max(0, controller.height / 2 - radius);
    const minGroundY = Math.cos(Math.min(89, Math.max(0, controller.maxSlopeAngle)) * DEG2RAD);

    state.grounded = false;
    state.groundNormal = [0, 1, 0];

    if (controller.useGravity !== false && physics.size > 0) {
      for (let pass = 0; pass < RESOLVE_PASSES; pass += 1) {
        const overlaps = physics.overlapContacts(capsuleAt(position, halfBarrel, radius), {
          ignore: [entity.id],
        });
        if (overlaps.length === 0) break;

        let resolved = false;
        for (const { contact } of overlaps) {
          if (contact.depth <= 0) continue;
          // The contact normal points from the character towards what it hit, so the escape
          // direction — and the surface normal as the character experiences it — is its
          // negation.
          const escape = scale(contact.normal, -1);
          position = add(position, scale(escape, contact.depth));
          resolved = true;

          if (escape[1] >= minGroundY) {
            state.grounded = true;
            state.groundNormal = escape;
            if (state.verticalVelocity < 0) state.verticalVelocity = 0;
          } else if (escape[1] < -0.5 && state.verticalVelocity > 0) {
            // Head hit a ceiling: stop rising rather than grinding along it for the rest of
            // the jump.
            state.verticalVelocity = 0;
          }
        }
        if (!resolved) break;
      }

      /**
       * Resting exactly on a surface produces no overlap at all, so the loop above sees nothing
       * and the character reads as airborne — which becomes a fall, a landing, and a fall
       * again, sixty times a second. A short probe below the feet settles it, and doubles as
       * the downhill snap: without it, walking off the top of a ramp is a series of small hops
       * rather than a walk.
       */
      if (!state.grounded && state.verticalVelocity <= 0) {
        const feet: Vec3 = [position[0], position[1] - halfBarrel, position[2]];
        const reach = radius + (wasGrounded ? GROUND_SNAP_DISTANCE : GROUND_PROBE_SKIN);
        const hit = physics.raycast(feet, [0, -1, 0], reach, { ignore: [entity.id] });
        if (hit && hit.normal[1] >= minGroundY) {
          state.grounded = true;
          state.groundNormal = [...hit.normal];
          state.verticalVelocity = 0;
          position = [position[0], hit.point[1] + halfBarrel + radius, position[2]];
        }
      }
    }

    // The floor of last resort. A scene with no colliders at all — which is every scene until
    // someone adds one — still has to be playable rather than an infinite fall.
    if (controller.useGravity === false) {
      position = [position[0], controller.groundHeight, position[2]];
    } else if (position[1] < controller.groundHeight) {
      position = [position[0], controller.groundHeight, position[2]];
      if (state.verticalVelocity < 0) state.verticalVelocity = 0;
      state.grounded = true;
      state.groundNormal = [0, 1, 0];
    }

    if (length(sub(position, world.position)) <= 1e-7) return;

    const parent = entity.parentId ? engine.scene.get(entity.parentId) : undefined;
    const local = parent
      ? inverseTransformPoint(worldTransformOf(engine.scene, parent), position)
      : position;
    entity.transform.position[0] = local[0]!;
    entity.transform.position[1] = local[1]!;
    entity.transform.position[2] = local[2]!;
    engine.scene.markTransformDirty(entity.id);
  }
}

/** The character's collision volume at a candidate position. */
function capsuleAt(center: Vec3, halfBarrel: number, radius: number): WorldShape {
  return {
    kind: 'capsule',
    a: [center[0], center[1] + halfBarrel, center[2]],
    b: [center[0], center[1] - halfBarrel, center[2]],
    radius,
  };
}

/** Ground-plane displacement for this frame, in world units. */
function horizontalStep(
  controller: CharacterControllerComponent,
  yawDegrees: number,
  forward: number,
  strafe: number,
  input: Engine['input'],
  dt: number,
): [number, number] {
  const forwardInput = Math.max(-1, Math.min(1, forward));
  const strafeInput = Math.max(-1, Math.min(1, strafe));
  if (forwardInput === 0 && strafeInput === 0) return [0, 0];

  const yaw = yawDegrees * DEG2RAD;
  // Local -Z is forward and local +X is right, matching Three's camera convention.
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);

  let dx = fx * forwardInput + rx * strafeInput;
  let dz = fz * forwardInput + rz * strafeInput;
  /**
   * Clamped to the unit disc rather than normalised to it.
   *
   * Normalising still stops diagonal movement being 1.41x faster than straight ahead — two keys
   * give a length of √2 and come back to 1 — but it also rescaled *every* input to full speed,
   * which is invisible with keys (they only ever read 0 or ±1) and ruins an analog stick: a
   * third of the travel walked at full pace. Only shortening what is longer than 1 keeps both.
   */
  const magnitude = Math.hypot(dx, dz);
  if (magnitude > 1) {
    dx /= magnitude;
    dz /= magnitude;
  }

  const speed = controller.moveSpeed * (input.isDown('ShiftLeft') ? controller.sprintMultiplier : 1);
  return [dx * speed * dt, dz * speed * dt];
}
