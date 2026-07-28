import type { AudioSourceComponent } from '../components/AudioSource';
import { findPrimaryCamera } from '../components/Camera';
import type { Engine, EngineMode, System, SystemStage } from '../loop/Engine';
import { transformDirection } from '../physics/math';
import { worldTransformOf } from '../physics/PhysicsSystem';
import type { EntityId, Vec3 } from '../scene/types';
import type { AudioHandle } from './AudioEngine';

const AUDIO_SOURCES = { all: ['AudioSource'] } as const;

/** -Z, the engine's forward convention (`EntityHandle.forward`, `README` "Lights and cameras"). */
const FORWARD: Vec3 = [0, 0, -1];
const UP: Vec3 = [0, 1, 0];

/**
 * Drives `AudioSource` autoplay and keeps the Web Audio listener where the camera is.
 *
 * `present`-stage and last in the frame on purpose: by the time it runs, the character has
 * moved, the agents have reacted, and scripts have made every decision they are going to make
 * this frame — so the sound a script started with `audio.play` this tick and the position an
 * NPC ended up at both read correctly, the same reason the Performance panel's telemetry and a
 * follow camera also want to run last.
 *
 * Owns exactly one thing scripts do not: which `AudioSource` components are currently playing,
 * so a looping ambience does not restart every frame and a disabled or deleted one stops. Sounds
 * started directly through the `audio` script API are the caller's to stop; this system never
 * touches them.
 */
export class AudioSystem implements System {
  readonly name = 'AudioSystem';
  readonly runsIn: readonly EngineMode[] = ['play'];
  readonly stage: SystemStage = 'present';

  private handles = new Map<EntityId, AudioHandle>();

  reset(): void {
    // `Engine.setMode` already called `audio.stopAll()` before systems are reset — every handle
    // in here is already stopped. This just forgets them, so a fresh Play session starts clean.
    this.handles.clear();
  }

  dispose(): void {
    this.handles.clear();
  }

  update(_dt: number, engine: Engine): void {
    const { scene, audio, ecs } = engine;

    const camera = findPrimaryCamera(scene.all());
    if (camera) {
      const world = worldTransformOf(scene, camera);
      audio.setListenerTransform(
        world.position,
        transformDirection(world, FORWARD),
        transformDirection(world, UP),
      );
    }

    const live = new Set<EntityId>();
    for (const entity of ecs.entities(AUDIO_SOURCES)) {
      const source = entity.components.find(
        (c): c is AudioSourceComponent => c.type === 'AudioSource',
      )!;
      live.add(entity.id);

      const existing = this.handles.get(entity.id);
      if (!source.enabled || !source.clip) {
        if (existing) {
          existing.stop();
          this.handles.delete(entity.id);
        }
        continue;
      }

      if (!existing) {
        if (!source.autoplay) continue;
        const world = source.spatial ? worldTransformOf(scene, entity) : null;
        const handle = audio.play(source.clip, {
          bus: source.bus,
          volume: source.volume,
          loop: source.loop,
          position: world ? world.position : undefined,
          refDistance: source.refDistance,
          maxDistance: source.maxDistance,
        });
        this.handles.set(entity.id, handle);
        continue;
      }

      if (source.spatial) existing.setPosition(worldTransformOf(scene, entity).position);
    }

    // Entities whose AudioSource vanished — deleted, or the component removed by a script.
    for (const [id, handle] of [...this.handles]) {
      if (live.has(id)) continue;
      handle.stop();
      this.handles.delete(id);
    }
  }
}
