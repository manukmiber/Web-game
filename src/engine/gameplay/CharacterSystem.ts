import type { CharacterControllerComponent } from '../components/CharacterController';
import type { Engine, EngineMode, System } from '../loop/Engine';
import { DEG2RAD, wrapAngle } from '../ai/steering';

/**
 * Turns key state into character movement.
 *
 * Kinematic and deliberately simple — see CharacterControllerComponent for why there is no
 * gravity or collision yet. The control scheme is the one that needs no mouse capture, since
 * the editor viewport is a panel in a page rather than a locked-pointer game window:
 *
 * - `W`/`S` or `↑`/`↓` — forward and back along the character's facing
 * - `A`/`D` — strafe
 * - `←`/`→` or `Q`/`E` — turn
 * - `Shift` — sprint
 *
 * External hardware reaches the same character through three named analog axes — `move`,
 * `strafe` and `turn`, all positive forward/right/right — which are summed with the keys
 * rather than replacing them. A scene therefore does not have to know whether it is being
 * played with a keyboard or a cockpit, and one built with either works with the other.
 *
 * A Camera entity parented to the character inherits all of it, which is the whole third-person
 * rig: no follow code, no lerp, just the transform hierarchy doing its job.
 */
export class CharacterSystem implements System {
  readonly name = 'CharacterSystem';
  readonly runsIn: readonly EngineMode[] = ['play'];

  update(dt: number, engine: Engine): void {
    const { scene, input, game } = engine;

    for (const entity of scene.all()) {
      const controller = entity.components.find(
        (c): c is CharacterControllerComponent => c.type === 'CharacterController',
      );
      if (!controller) continue;

      game.register(entity.id, controller.faction, controller.maxHealth);
      if (!game.isAlive(entity.id)) continue;

      const { position, rotation } = entity.transform;

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

      let moved = false;

      if (turn !== 0) {
        // Analog turn is proportional; the keys still turn at full rate because they read ±1.
        const rate = Math.max(-1, Math.min(1, turn));
        rotation[1] = wrapAngle(rotation[1] + rate * controller.turnSpeed * dt);
        moved = true;
      }

      const forwardInput = Math.max(-1, Math.min(1, forward));
      const strafeInput = Math.max(-1, Math.min(1, strafe));
      if (forwardInput !== 0 || strafeInput !== 0) {
        const yaw = rotation[1] * DEG2RAD;
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
         * Normalising still stops diagonal movement being 1.41x faster than straight ahead —
         * two keys give a length of √2 and come back to 1 — but it also rescaled *every*
         * input to full speed, which is invisible with keys (they only ever read 0 or ±1) and
         * ruins an analog stick: a third of the travel walked at full pace. Only shortening
         * what is longer than 1 keeps both.
         */
        const length = Math.hypot(dx, dz);
        if (length > 1) {
          dx /= length;
          dz /= length;
        }

        const speed =
          controller.moveSpeed * (input.isDown('ShiftLeft') ? controller.sprintMultiplier : 1);
        position[0] += dx * speed * dt;
        position[2] += dz * speed * dt;
        moved = true;
      }

      if (position[1] !== controller.groundHeight) {
        position[1] = controller.groundHeight;
        moved = true;
      }

      if (moved) scene.markTransformDirty(entity.id);
    }
  }
}
