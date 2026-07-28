/**
 * The seam between the scene and the solver.
 *
 * Every frame it re-describes the scene's colliders as bodies, runs whole fixed steps out of an
 * accumulator, writes the results back onto entity transforms, and hands the resulting contacts
 * to whoever wants them. The `PhysicsWorld` beneath it never learns that a Scene exists, and
 * the Scene never learns that a solver does — which is the arrangement that lets either be
 * replaced without touching the other.
 */

import type { ColliderComponent } from '../components/Collider';
import {
  DEFAULT_PHYSICS_SETTINGS,
  type PhysicsComponent,
} from '../components/Physics';
import type { RigidBodyComponent } from '../components/RigidBody';
import { Emitter } from '../core/Emitter';
import type { Engine, EngineMode, System } from '../loop/Engine';
import type { Scene } from '../scene/Scene';
import type { Entity, EntityId, Vec3 } from '../scene/types';
import {
  composeTransforms,
  identityTransform,
  inverseTransformPoint,
  quatFromEuler,
  type RigidTransform,
} from './math';
import {
  PhysicsWorld,
  type BodyDescriptor,
  type ContactEvent,
  type StepSettings,
} from './PhysicsWorld';
import { resolveShape } from './shapes';

export interface PhysicsSystemEvents {
  /** A pair that was not touching last step and is now. */
  collisionEnter: ContactEvent;
  /** A pair still touching. Fired once per frame, not once per substep. */
  collisionStay: ContactEvent;
  collisionExit: { a: EntityId; b: EntityId; trigger: boolean };
}

export interface PhysicsDiagnostics {
  bodies: number;
  dynamicBodies: number;
  sleeping: number;
  contacts: number;
  pairsTested: number;
  /** Fixed steps run during the last frame. Above 1 means the frame was slower than the step. */
  steps: number;
  /** True when the substep cap was hit and simulated time fell behind real time. */
  throttled: boolean;
  /** Milliseconds spent inside `step` last frame. */
  stepMs: number;
}

/** Beyond this the accumulator is emptied rather than caught up. See `maxSubsteps`. */
const MAX_ACCUMULATED_SECONDS = 0.25;

export class PhysicsSystem implements System {
  readonly name = 'PhysicsSystem';
  readonly runsIn: readonly EngineMode[] = ['play'];
  readonly events = new Emitter<PhysicsSystemEvents>();

  /**
   * The world this system steps.
   *
   * Bound on the first update rather than constructed here: the Engine owns it, so scripts and
   * the CharacterSystem can reach it without going through the system list.
   */
  private world: PhysicsWorld = new PhysicsWorld();
  private accumulator = 0;
  private diagnostics: PhysicsDiagnostics = emptyDiagnostics();
  /** Settings resolved from the scene's `Physics` component, refreshed each frame. */
  private settings: PhysicsComponent = DEFAULT_PHYSICS_SETTINGS;

  update(dt: number, engine: Engine): void {
    this.world = engine.physics;
    this.settings = findPhysics(engine.scene) ?? DEFAULT_PHYSICS_SETTINGS;
    this.syncBodies(engine.scene);

    const step = clampStep(this.settings.fixedTimestep);
    const maxSubsteps = Math.max(1, Math.round(this.settings.maxSubsteps));
    const stepSettings: StepSettings = {
      gravity: this.settings.gravity ?? [0, -9.81, 0],
      solverIterations: this.settings.solverIterations,
      positionCorrection: this.settings.positionCorrection,
      allowedPenetration: this.settings.allowedPenetration,
      sleepVelocity: this.settings.sleepVelocity,
      sleepDelay: this.settings.sleepDelay,
    };

    this.accumulator = Math.min(this.accumulator + dt, MAX_ACCUMULATED_SECONDS);

    const began = new Map<string, ContactEvent>();
    const persisted = new Map<string, ContactEvent>();
    const ended = new Map<string, { a: EntityId; b: EntityId; trigger: boolean }>();

    let steps = 0;
    let contacts = 0;
    let pairsTested = 0;
    const startedAt = now();

    while (this.accumulator >= step && steps < maxSubsteps) {
      const result = this.world.step(step, stepSettings);
      this.accumulator -= step;
      steps += 1;
      contacts = result.contactCount;
      pairsTested = result.pairsTested;

      /**
       * Events are collapsed across substeps before they are emitted.
       *
       * A frame that runs three substeps can see the same pair begin, end and begin again, and
       * a script that spawns an impact sound on `onCollisionEnter` would play three of them for
       * one landing. Keyed by pair, with a later `enter` cancelling an earlier `exit`, the
       * frame reports what actually changed between its start and its end.
       */
      for (const event of result.began) {
        const key = eventKey(event.a, event.b);
        if (ended.delete(key)) persisted.set(key, event);
        else began.set(key, event);
      }
      for (const event of result.persisted) {
        const key = eventKey(event.a, event.b);
        if (!began.has(key)) persisted.set(key, event);
      }
      for (const event of result.ended) {
        const key = eventKey(event.a, event.b);
        if (began.delete(key) || persisted.delete(key)) continue;
        ended.set(key, event);
      }
    }

    // Hit the cap: drop the backlog rather than carry it into the next frame, where it would
    // make that frame slower still. Simulation falls behind wall clock, which is the documented
    // and survivable failure.
    const throttled = this.accumulator >= step;
    if (throttled) this.accumulator = 0;

    if (steps > 0) this.writeBack(engine.scene);

    this.diagnostics = {
      bodies: this.world.size,
      dynamicBodies: this.world.list().filter((b) => b.invMass > 0).length,
      sleeping: this.world.list().filter((b) => b.sleeping).length,
      contacts,
      pairsTested,
      steps,
      throttled,
      stepMs: now() - startedAt,
    };

    for (const event of began.values()) this.events.emit('collisionEnter', event);
    for (const event of persisted.values()) this.events.emit('collisionStay', event);
    for (const event of ended.values()) this.events.emit('collisionExit', event);
  }

  reset(engine?: Engine): void {
    (engine?.physics ?? this.world).clear();
    this.accumulator = 0;
    this.diagnostics = emptyDiagnostics();
  }

  dispose(): void {
    this.reset();
    this.events.clear();
  }

  getDiagnostics(): PhysicsDiagnostics {
    return { ...this.diagnostics };
  }

  // ---------------------------------------------------------------- internal

  /**
   * Brings the world's bodies in line with the scene.
   *
   * Rebuilt from the scene every frame rather than maintained through events, and the reason is
   * that the two sources of truth genuinely both exist: the solver owns a falling crate's
   * position, and the Inspector owns its collider radius, its mass and whether someone just
   * dragged it somewhere with the gizmo. Re-describing is a handful of microseconds per body
   * and removes an entire class of "the collider did not follow the entity" bug.
   *
   * The one thing not overwritten is a dynamic body's position: that is the solver's, and
   * copying the scene's back over it every frame would pin every falling object in mid-air.
   */
  private syncBodies(scene: Scene): void {
    const alive = new Set<EntityId>();

    for (const entity of scene.all()) {
      const collider = entity.components.find(
        (c): c is ColliderComponent => c.type === 'Collider',
      );
      if (!collider) continue;

      const body = entity.components.find(
        (c): c is RigidBodyComponent => c.type === 'RigidBody',
      );
      alive.add(entity.id);

      // Keep the solver's position for a body it owns; take everything else from the scene.
      // The shape then has to be re-placed at the body's own origin rather than the entity's,
      // which is what `originOverride` is for.
      const existing = this.world.get(entity.id);
      const transform = worldTransformOf(
        scene,
        entity,
        existing && existing.invMass > 0 ? existing.origin : undefined,
      );
      this.world.upsert(describeBody(entity.id, collider, body ?? null, transform));
    }

    this.world.prune(alive);
  }

  /** Copies solver positions back onto the scene, converting world space into local. */
  private writeBack(scene: Scene): void {
    for (const body of this.world.list()) {
      if (body.invMass === 0 && body.bodyType !== 'Kinematic') continue;
      const entity = scene.get(body.id);
      if (!entity) continue;

      const parent = entity.parentId ? scene.get(entity.parentId) : undefined;
      const local = parent
        ? inverseTransformPoint(worldTransformOf(scene, parent), body.origin)
        : body.origin;

      const position = entity.transform.position;
      if (position[0] === local[0] && position[1] === local[1] && position[2] === local[2]) {
        continue;
      }
      position[0] = local[0]!;
      position[1] = local[1]!;
      position[2] = local[2]!;
      scene.markTransformDirty(body.id);
    }
  }
}

/**
 * World transform of an entity, accumulated through its parents.
 *
 * `Scene.worldPositionOf` deliberately ignores parent rotation because it only ever needed a
 * chunk bucket; physics cannot, so the full composition lives here. `originOverride` lets the
 * caller substitute a position the solver owns for the one the scene stores.
 */
export function worldTransformOf(
  scene: Scene,
  entity: Entity,
  originOverride?: Vec3,
): RigidTransform {
  const chain: Entity[] = [];
  let current: Entity | undefined = entity;
  const guard = new Set<EntityId>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    chain.push(current);
    current = current.parentId ? scene.get(current.parentId) : undefined;
  }

  let out = identityTransform();
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const node = chain[i]!;
    const isTarget = i === 0;
    const position =
      isTarget && originOverride && !node.parentId ? originOverride : node.transform.position;
    out = composeTransforms(out, {
      position: [...position],
      rotation: quatFromEuler(node.transform.rotation),
      scale: [...node.transform.scale],
    });
  }

  // A parented body's solver position is world space, so it replaces the composed result
  // outright rather than being folded in as a local offset.
  if (originOverride && entity.parentId) out.position = [...originOverride];
  return out;
}

function describeBody(
  id: EntityId,
  collider: ColliderComponent,
  body: RigidBodyComponent | null,
  transform: RigidTransform,
): BodyDescriptor {
  return {
    id,
    // No RigidBody means the world, not a thing in it. See ColliderComponent.
    bodyType: body?.bodyType ?? 'Static',
    shape: resolveShape(collider, transform),
    origin: [...transform.position],
    rotation: [...transform.rotation],
    mass: Math.max(0.0001, body?.mass ?? 1),
    gravityScale: body?.gravityScale ?? 1,
    linearDamping: Math.max(0, body?.linearDamping ?? 0),
    maxSpeed: Math.max(0, body?.maxSpeed ?? 0),
    locks: [body?.lockX ?? false, body?.lockY ?? false, body?.lockZ ?? false],
    restitution: clamp01(collider.restitution ?? 0),
    friction: Math.max(0, collider.friction ?? 0.5),
    isTrigger: collider.isTrigger ?? false,
    layer: collider.layer || 'default',
    mask: collider.mask ?? '*',
    canSleep: body?.canSleep ?? true,
  };
}

/** The first `Physics` component in scene order wins, exactly as `Environment` does. */
export function findPhysics(scene: Scene): PhysicsComponent | null {
  for (const entity of scene.all()) {
    const component = entity.components.find((c): c is PhysicsComponent => c.type === 'Physics');
    if (component) return component;
  }
  return null;
}

function clampStep(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1 / 60;
  return Math.min(1 / 20, Math.max(1 / 240, value));
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function eventKey(a: EntityId, b: EntityId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function emptyDiagnostics(): PhysicsDiagnostics {
  return {
    bodies: 0,
    dynamicBodies: 0,
    sleeping: 0,
    contacts: 0,
    pairsTested: 0,
    steps: 0,
    throttled: false,
    stepMs: 0,
  };
}

/** `performance` is not guaranteed in every host the engine runs in; `Date` always is. */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
