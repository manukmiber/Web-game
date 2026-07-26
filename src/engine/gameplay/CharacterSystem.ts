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

      const turn = input.axis('ArrowRight', 'ArrowLeft') + input.axis('KeyE', 'KeyQ');
      const forward = input.axis('KeyS', 'KeyW') + input.axis('ArrowDown', 'ArrowUp');
      const strafe = input.axis('KeyD', 'KeyA');

      let moved = false;

      if (turn !== 0) {
        rotation[1] = wrapAngle(rotation[1] + Math.sign(turn) * controller.turnSpeed * dt);
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
        // Normalising is what stops diagonal movement being 1.41x faster than straight ahead.
        const length = Math.hypot(dx, dz);
        if (length > 1e-6) {
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
