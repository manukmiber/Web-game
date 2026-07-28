/**
 * The simulation itself: bodies, contacts, the solver, and the spatial queries built on them.
 *
 * Knows nothing about the Scene, components or the engine loop. It is handed bodies, told to
 * step, and asked what happened — which is what makes it testable without a scene graph and
 * movable to a Worker without untangling it from the editor first (ARCHITECTURE.md §9.5).
 *
 * **Sequential impulses over a fixed timestep**, the same family of solver as Box2D and PhysX.
 * Each step integrates velocity, integrates position, finds contacts, then runs several passes
 * that each apply a small corrective impulse per contact. Several cheap passes converge on a
 * stack far better than one expensive exact solve, and — the practical reason — a pass that runs
 * out of budget degrades into a slightly softer stack rather than an explosion.
 */

import type { BodyType } from '../components/RigidBody';
import type { EntityId, Vec3 } from '../scene/types';
import { collide, tangentBasis, type Contact } from './collision';
import {
  add,
  clamp,
  dot,
  EPSILON,
  isFiniteVec,
  length,
  scale,
  sub,
  type Quat,
} from './math';
import { raycastShape } from './raycast';
import { aabbOverlaps, shapeBounds, type Aabb, type WorldShape } from './shapes';

/** How far a surface can tilt and still count as ground: about 45°. */
export const GROUND_NORMAL_THRESHOLD = 0.7;

/** Broadphase cell edge, metres. Roughly the size of the things that collide most. */
const DEFAULT_CELL_SIZE = 4;

/** A body whose bounds span more cells than this skips the grid and is tested against all. */
const MAX_CELLS_PER_BODY = 512;

export interface BodyDescriptor {
  id: EntityId;
  bodyType: BodyType;
  shape: WorldShape;
  /** World position of the entity origin. The shape may sit at an offset from it. */
  origin: Vec3;
  /** World orientation, carried so queries can report it; the solver never changes it. */
  rotation: Quat;
  mass: number;
  gravityScale: number;
  linearDamping: number;
  maxSpeed: number;
  locks: [boolean, boolean, boolean];
  restitution: number;
  friction: number;
  isTrigger: boolean;
  layer: string;
  mask: string;
  canSleep: boolean;
}

export interface PhysicsBody extends BodyDescriptor {
  velocity: Vec3;
  /** Zero for static and kinematic bodies — the solver's whole definition of "immovable". */
  invMass: number;
  sleeping: boolean;
  sleepTimer: number;
  /** True when something was pressed against this body's underside this step. */
  grounded: boolean;
  groundNormal: Vec3;
  groundId: EntityId | null;
  bounds: Aabb;
  /** Offset from `origin` to the shape's own centre, constant while rotation is unchanged. */
  shapeOffset: Vec3;
}

export interface ContactEvent {
  a: EntityId;
  b: EntityId;
  /** Points from `a` towards `b`. */
  normal: Vec3;
  point: Vec3;
  depth: number;
  /** Closing speed along the normal at the moment of contact. Useful for impact damage. */
  impactSpeed: number;
  trigger: boolean;
}

export interface RayHit {
  entityId: EntityId;
  distance: number;
  point: Vec3;
  normal: Vec3;
}

export interface QueryOptions {
  /** Only report bodies whose layer is in this list. Empty or absent means every layer. */
  layers?: readonly string[];
  /** Entities to ignore — almost always the entity doing the casting. */
  ignore?: readonly EntityId[];
  /** Trigger volumes are skipped by default: a bullet should not stop at a checkpoint. */
  includeTriggers?: boolean;
}

export interface StepSettings {
  gravity: Vec3;
  solverIterations: number;
  positionCorrection: number;
  allowedPenetration: number;
  sleepVelocity: number;
  sleepDelay: number;
}

export const DEFAULT_STEP_SETTINGS: StepSettings = {
  gravity: [0, -9.81, 0],
  solverIterations: 6,
  positionCorrection: 0.4,
  allowedPenetration: 0.005,
  sleepVelocity: 0.06,
  sleepDelay: 0.6,
};

/** What one call to `step` produced, for the system above to turn into script hooks. */
export interface PhysicsStepResult {
  began: ContactEvent[];
  persisted: ContactEvent[];
  ended: { a: EntityId; b: EntityId; trigger: boolean }[];
  contactCount: number;
  pairsTested: number;
}

interface ResolvedContact {
  a: PhysicsBody;
  b: PhysicsBody;
  contact: Contact;
  restitution: number;
  friction: number;
  impactSpeed: number;
}

export class PhysicsWorld {
  private bodies = new Map<EntityId, PhysicsBody>();
  /** Pairs currently touching, as `a|b` with ids sorted, so enter/exit can be diffed. */
  private touching = new Set<string>();
  private cellSize = DEFAULT_CELL_SIZE;
  private grid = new Map<string, PhysicsBody[]>();
  /** Bodies too large to bucket usefully — planes, mostly — tested against everything. */
  private unbounded: PhysicsBody[] = [];

  // ------------------------------------------------------------------ bodies

  /**
   * Adds a body, or updates the one already registered for that entity.
   *
   * Updating in place rather than replacing is what preserves velocity and sleep state across a
   * frame: the system re-describes every body from the scene each frame (a collider radius may
   * have been edited in the Inspector) and a body that forgot its velocity every time would
   * never fall.
   */
  upsert(descriptor: BodyDescriptor): PhysicsBody {
    const existing = this.bodies.get(descriptor.id);
    const dynamic = descriptor.bodyType === 'Dynamic';
    const invMass = dynamic && descriptor.mass > 0 ? 1 / descriptor.mass : 0;
    const shapeOffset = sub(shapeCenter(descriptor.shape), descriptor.origin);

    if (existing) {
      Object.assign(existing, descriptor);
      existing.invMass = invMass;
      existing.shapeOffset = shapeOffset;
      existing.bounds = shapeBounds(descriptor.shape);
      if (!dynamic) existing.sleeping = false;
      return existing;
    }

    const body: PhysicsBody = {
      ...descriptor,
      velocity: [0, 0, 0],
      invMass,
      sleeping: false,
      sleepTimer: 0,
      grounded: false,
      groundNormal: [0, 1, 0],
      groundId: null,
      bounds: shapeBounds(descriptor.shape),
      shapeOffset,
    };
    this.bodies.set(descriptor.id, body);
    return body;
  }

  remove(id: EntityId): void {
    if (!this.bodies.delete(id)) return;
    // Drop every pair the body was in, so its partners get an `exit` rather than a stuck `stay`.
    for (const key of [...this.touching]) {
      if (key.startsWith(`${id}|`) || key.endsWith(`|${id}`)) this.touching.delete(key);
    }
  }

  get(id: EntityId): PhysicsBody | undefined {
    return this.bodies.get(id);
  }

  has(id: EntityId): boolean {
    return this.bodies.has(id);
  }

  list(): PhysicsBody[] {
    return [...this.bodies.values()];
  }

  get size(): number {
    return this.bodies.size;
  }

  /** Ids present in the world but not in `keep` — entities whose collider or body went away. */
  prune(keep: ReadonlySet<EntityId>): EntityId[] {
    const dropped: EntityId[] = [];
    for (const id of this.bodies.keys()) if (!keep.has(id)) dropped.push(id);
    for (const id of dropped) this.remove(id);
    return dropped;
  }

  clear(): void {
    this.bodies.clear();
    this.touching.clear();
    this.grid.clear();
    this.unbounded = [];
  }

  /** Teleports a body: position is set, velocity is untouched, contacts are re-evaluated. */
  setPosition(id: EntityId, position: Vec3): void {
    const body = this.bodies.get(id);
    if (!body || !isFiniteVec(position)) return;
    this.moveTo(body, position);
    this.wake(body);
  }

  setVelocity(id: EntityId, velocity: Vec3): void {
    const body = this.bodies.get(id);
    if (!body || !isFiniteVec(velocity)) return;
    body.velocity = [...velocity];
    this.wake(body);
  }

  /** Instantaneous change in momentum — a jump, a jolt, an explosion. */
  applyImpulse(id: EntityId, impulse: Vec3): void {
    const body = this.bodies.get(id);
    if (!body || body.invMass === 0 || !isFiniteVec(impulse)) return;
    body.velocity = add(body.velocity, scale(impulse, body.invMass));
    this.wake(body);
  }

  /** Continuous force, integrated over `dt` — wind, thrust, a conveyor. */
  applyForce(id: EntityId, force: Vec3, dt: number): void {
    if (dt <= 0) return;
    this.applyImpulse(id, scale(force, dt));
  }

  wake(body: PhysicsBody): void {
    body.sleeping = false;
    body.sleepTimer = 0;
  }

  // -------------------------------------------------------------------- step

  /**
   * Advances the simulation by exactly `dt`.
   *
   * The caller is responsible for calling this with a fixed `dt`; nothing here adapts to a
   * variable one, and that is the point (see `PhysicsComponent.fixedTimestep`).
   */
  step(dt: number, settings: StepSettings = DEFAULT_STEP_SETTINGS): PhysicsStepResult {
    if (dt <= 0) {
      return { began: [], persisted: [], ended: [], contactCount: 0, pairsTested: 0 };
    }

    this.integrate(dt, settings);
    const { contacts, pairsTested } = this.findContacts();
    this.solve(contacts, settings);
    this.correctPositions(contacts, settings);
    this.updateSleep(dt, settings);

    return { ...this.diffContacts(contacts), contactCount: contacts.length, pairsTested };
  }

  private integrate(dt: number, settings: StepSettings): void {
    for (const body of this.bodies.values()) {
      if (body.bodyType === 'Static') continue;
      // A sleeping body keeps its ground: it is asleep *because* it is resting on something, and
      // its contact pair is skipped by the broadphase, so nothing would set the flag again.
      // Clearing it here made `grounded` go false the moment a character stopped moving.
      if (body.sleeping) continue;

      body.grounded = false;
      body.groundId = null;

      if (body.bodyType === 'Dynamic') {
        body.velocity = add(body.velocity, scale(settings.gravity, body.gravityScale * dt));

        // Damping as an exponential decay rather than a per-frame multiply: the latter makes
        // drag depend on the step size, which is exactly the frame-rate dependence the fixed
        // timestep exists to remove.
        if (body.linearDamping > 0) {
          const retained = Math.exp(-body.linearDamping * 60 * dt);
          body.velocity = scale(body.velocity, retained);
        }

        if (body.maxSpeed > 0) {
          const speed = length(body.velocity);
          if (speed > body.maxSpeed) body.velocity = scale(body.velocity, body.maxSpeed / speed);
        }
      }

      if (body.locks[0]) body.velocity[0] = 0;
      if (body.locks[1]) body.velocity[1] = 0;
      if (body.locks[2]) body.velocity[2] = 0;

      if (!isFiniteVec(body.velocity)) body.velocity = [0, 0, 0];
      if (length(body.velocity) < EPSILON) continue;
      this.moveTo(body, add(body.origin, scale(body.velocity, dt)));
    }
  }

  // ------------------------------------------------------------- broadphase

  private rebuildGrid(): void {
    this.grid.clear();
    this.unbounded = [];

    for (const body of this.bodies.values()) {
      const { min, max } = body.bounds;
      const x0 = Math.floor(min[0] / this.cellSize);
      const x1 = Math.floor(max[0] / this.cellSize);
      const y0 = Math.floor(min[1] / this.cellSize);
      const y1 = Math.floor(max[1] / this.cellSize);
      const z0 = Math.floor(min[2] / this.cellSize);
      const z1 = Math.floor(max[2] / this.cellSize);

      const cells = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
      // An infinite plane covers 10^18 cells. Bucketing it would be slower than the brute-force
      // list it goes into instead, and there are only ever a handful of these.
      if (!Number.isFinite(cells) || cells > MAX_CELLS_PER_BODY) {
        this.unbounded.push(body);
        continue;
      }

      for (let x = x0; x <= x1; x += 1) {
        for (let y = y0; y <= y1; y += 1) {
          for (let z = z0; z <= z1; z += 1) {
            const key = `${x},${y},${z}`;
            const bucket = this.grid.get(key);
            if (bucket) bucket.push(body);
            else this.grid.set(key, [body]);
          }
        }
      }
    }
  }

  /**
   * Candidate pairs, deduplicated.
   *
   * A body spanning several cells appears in each of them, so the same pair comes up more than
   * once; the `seen` set is what stops a large object being solved three times as hard as a
   * small one, which would otherwise read as heavy objects being mysteriously stiffer.
   */
  private broadphasePairs(): [PhysicsBody, PhysicsBody][] {
    this.rebuildGrid();
    const pairs: [PhysicsBody, PhysicsBody][] = [];
    const seen = new Set<string>();

    const consider = (a: PhysicsBody, b: PhysicsBody) => {
      if (a.id === b.id) return;
      // Two immovable bodies can never resolve anything, so they are never even tested. This is
      // the single biggest saving in a scene that is mostly level geometry.
      if (a.invMass === 0 && b.invMass === 0) return;
      if (a.sleeping && b.sleeping) return;
      if (a.sleeping && b.invMass === 0) return;
      if (b.sleeping && a.invMass === 0) return;
      const key = pairKey(a.id, b.id);
      if (seen.has(key)) return;
      seen.add(key);
      if (!aabbOverlaps(a.bounds, b.bounds)) return;
      pairs.push([a, b]);
    };

    for (const bucket of this.grid.values()) {
      for (let i = 0; i < bucket.length; i += 1) {
        for (let j = i + 1; j < bucket.length; j += 1) consider(bucket[i]!, bucket[j]!);
      }
    }

    for (const wide of this.unbounded) {
      for (const body of this.bodies.values()) consider(wide, body);
    }

    return pairs;
  }

  private findContacts(): { contacts: ResolvedContact[]; pairsTested: number } {
    const pairs = this.broadphasePairs();
    const contacts: ResolvedContact[] = [];

    for (const [a, b] of pairs) {
      // Both sides must accept the other. See `layerMatches` for why this is symmetric.
      if (!accepts(a, b) || !accepts(b, a)) continue;

      const contact = collide(a.shape, b.shape);
      if (!contact) continue;

      const relative = sub(b.velocity, a.velocity);
      contacts.push({
        a,
        b,
        contact,
        // Bounciness is the *most* bouncy of the pair: a rubber ball bounces off concrete
        // because of the ball, not the floor, and averaging would make it not.
        restitution: Math.max(a.restitution, b.restitution),
        // Friction averages, because a sledge on ice is somewhere between the two.
        friction: (a.friction + b.friction) / 2,
        impactSpeed: -dot(relative, contact.normal),
      });
    }

    return { contacts, pairsTested: pairs.length };
  }

  // ------------------------------------------------------------------ solver

  /** Wakes a sleeping body when something that is moving touches it. */
  private wakeOnContact(a: PhysicsBody, b: PhysicsBody, threshold: number): void {
    const aMoving = !a.sleeping && length(a.velocity) > threshold;
    const bMoving = !b.sleeping && length(b.velocity) > threshold;
    if (a.sleeping && a.invMass > 0 && bMoving) this.wake(a);
    if (b.sleeping && b.invMass > 0 && aMoving) this.wake(b);
  }

  private solve(contacts: ResolvedContact[], settings: StepSettings): void {
    for (const resolved of contacts) {
      const { a, b, contact } = resolved;
      if (a.isTrigger || b.isTrigger) continue;

      /**
       * A *moving* body wakes a sleeping one. A resting one does not.
       *
       * The distinction is the whole of sleeping working at all. Waking both sides of every
       * contact — which is the obvious reading of "a contact wakes things up" — resets the
       * sleep timer of a body whose only contact is the floor it is resting on, so nothing
       * ever sleeps and a stack of crates jitters forever. Meanwhile a sleeper that is never
       * woken is a ghost: something lands on it and falls straight through, because nothing
       * asked it to push back. Both failures are avoided by asking whether the *other* body
       * is actually going anywhere.
       */
      this.wakeOnContact(a, b, settings.sleepVelocity);

      // Ground is recorded from the contact rather than from a separate downward ray: the
      // solver already knows what is holding each body up, and a second query would be both
      // slower and capable of disagreeing with the thing actually doing the supporting.
      if (-contact.normal[1] > GROUND_NORMAL_THRESHOLD && a.invMass > 0) {
        a.grounded = true;
        a.groundNormal = scale(contact.normal, -1);
        a.groundId = b.id;
      }
      if (contact.normal[1] > GROUND_NORMAL_THRESHOLD && b.invMass > 0) {
        b.grounded = true;
        b.groundNormal = [...contact.normal];
        b.groundId = a.id;
      }
    }

    const iterations = Math.max(1, Math.round(settings.solverIterations));
    for (let pass = 0; pass < iterations; pass += 1) {
      for (const resolved of contacts) {
        if (resolved.a.isTrigger || resolved.b.isTrigger) continue;
        // Restitution only on the first pass, from the velocity the contact actually arrived
        // with. Re-applying it every pass pumps energy in and turns a dropped ball into a
        // bouncing one that climbs.
        this.resolveContact(resolved, pass === 0);
      }
    }
  }

  private resolveContact(resolved: ResolvedContact, applyRestitution: boolean): void {
    const { a, b, contact } = resolved;
    const invMassSum = a.invMass + b.invMass;
    if (invMassSum <= 0) return;

    const relative = sub(b.velocity, a.velocity);
    const separating = dot(relative, contact.normal);
    // Already moving apart: nothing to do, and applying an impulse anyway would glue them.
    if (separating > 0) return;

    // A slow contact should settle, not bounce. Without this floor a resting body jitters at
    // the amplitude of one step's worth of gravity, forever.
    const bounce =
      applyRestitution && resolved.restitution > 0 && -separating > MIN_BOUNCE_SPEED
        ? resolved.restitution * -separating
        : 0;

    const impulse = (-(separating) + bounce) / invMassSum;
    const normalImpulse = scale(contact.normal, impulse);
    if (a.invMass > 0) a.velocity = sub(a.velocity, scale(normalImpulse, a.invMass));
    if (b.invMass > 0) b.velocity = add(b.velocity, scale(normalImpulse, b.invMass));

    if (resolved.friction <= 0) return;

    // Coulomb friction, clamped to the normal impulse: a surface can only resist sliding as
    // hard as it is being pressed. Unclamped friction can reverse a slide, which looks like
    // objects being flicked sideways off ramps.
    const [t1, t2] = tangentBasis(contact.normal);
    const limit = Math.abs(impulse) * resolved.friction;

    for (const tangent of [t1, t2]) {
      const along = dot(sub(b.velocity, a.velocity), tangent);
      if (Math.abs(along) < EPSILON) continue;
      const magnitude = clamp(-along / invMassSum, -limit, limit);
      const frictionImpulse = scale(tangent, magnitude);
      if (a.invMass > 0) a.velocity = sub(a.velocity, scale(frictionImpulse, a.invMass));
      if (b.invMass > 0) b.velocity = add(b.velocity, scale(frictionImpulse, b.invMass));
    }
  }

  /**
   * Pushes overlapping bodies apart.
   *
   * Impulses fix velocity, not position — a body that has already sunk into the floor stays
   * sunk, because zero relative velocity is a perfectly valid solution to the velocity problem.
   * This is the second half: a fraction of the remaining overlap, minus the slop, split by
   * inverse mass so the lighter body does more of the moving.
   */
  private correctPositions(contacts: ResolvedContact[], settings: StepSettings): void {
    for (const { a, b, contact } of contacts) {
      if (a.isTrigger || b.isTrigger) continue;
      const invMassSum = a.invMass + b.invMass;
      if (invMassSum <= 0) continue;

      const excess = contact.depth - settings.allowedPenetration;
      if (excess <= 0) continue;

      const correction = (excess * settings.positionCorrection) / invMassSum;
      // Masked by the locks, not just the velocity integration. A body with `lockY` whose
      // velocity is pinned to zero was still being shoved upward out of contacts, which is a
      // lock that holds for gravity and not for the floor — the least useful half of one.
      if (a.invMass > 0) {
        this.moveTo(a, sub(a.origin, unlocked(a, scale(contact.normal, correction * a.invMass))));
      }
      if (b.invMass > 0) {
        this.moveTo(b, add(b.origin, unlocked(b, scale(contact.normal, correction * b.invMass))));
      }
    }
  }

  private updateSleep(dt: number, settings: StepSettings): void {
    for (const body of this.bodies.values()) {
      if (body.bodyType !== 'Dynamic' || body.invMass === 0) continue;
      if (!body.canSleep) {
        body.sleeping = false;
        continue;
      }
      if (body.sleeping) continue;

      if (length(body.velocity) > settings.sleepVelocity) {
        body.sleepTimer = 0;
        continue;
      }
      body.sleepTimer += dt;
      if (body.sleepTimer >= settings.sleepDelay) {
        body.sleeping = true;
        // Zeroed rather than left tiny: a sleeping body that wakes with residual velocity
        // drifts a millimetre every time something brushes past it.
        body.velocity = [0, 0, 0];
      }
    }
  }

  // ------------------------------------------------------------------ events

  private diffContacts(contacts: ResolvedContact[]): Omit<PhysicsStepResult, 'contactCount' | 'pairsTested'> {
    const began: ContactEvent[] = [];
    const persisted: ContactEvent[] = [];
    const current = new Set<string>();

    for (const resolved of contacts) {
      const { a, b, contact } = resolved;
      const key = pairKey(a.id, b.id);
      current.add(key);
      const event: ContactEvent = {
        a: a.id,
        b: b.id,
        normal: [...contact.normal],
        point: [...contact.point],
        depth: contact.depth,
        impactSpeed: resolved.impactSpeed,
        trigger: a.isTrigger || b.isTrigger,
      };
      if (this.touching.has(key)) persisted.push(event);
      else began.push(event);
    }

    const ended: PhysicsStepResult['ended'] = [];
    for (const key of this.touching) {
      if (current.has(key)) continue;
      const [a, b] = key.split('|') as [EntityId, EntityId];
      const bodyA = this.bodies.get(a);
      const bodyB = this.bodies.get(b);
      // A pair whose bodies are both gone needs no exit event; one that lost a side does, so
      // the survivor's `onCollisionExit` still runs when the other entity is destroyed.
      if (!bodyA && !bodyB) continue;
      ended.push({ a, b, trigger: Boolean(bodyA?.isTrigger || bodyB?.isTrigger) });
    }

    this.touching = current;
    return { began, persisted, ended };
  }

  // ----------------------------------------------------------------- queries

  /**
   * Nearest body along a ray.
   *
   * Brute force over every body, deliberately. The grid is rebuilt for the step, a ray does not
   * fit a uniform grid without a DDA walk, and at the body counts this engine targets the walk
   * costs more than the tests it saves. When that stops being true the fix is a DDA here and
   * nothing else changes.
   */
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance = Infinity,
    options: QueryOptions = {},
  ): RayHit | null {
    const unit = normalizeOrNull(direction);
    if (!unit) return null;
    const limit = Number.isFinite(maxDistance) ? maxDistance : 1e6;

    let best: RayHit | null = null;
    for (const body of this.bodies.values()) {
      if (!passesQuery(body, options)) continue;
      const hit = raycastShape(body.shape, origin, unit, limit);
      if (!hit) continue;
      if (best && hit.distance >= best.distance) continue;
      best = { entityId: body.id, distance: hit.distance, point: hit.point, normal: hit.normal };
    }
    return best;
  }

  /** Every body along a ray, nearest first. */
  raycastAll(
    origin: Vec3,
    direction: Vec3,
    maxDistance = Infinity,
    options: QueryOptions = {},
  ): RayHit[] {
    const unit = normalizeOrNull(direction);
    if (!unit) return [];
    const limit = Number.isFinite(maxDistance) ? maxDistance : 1e6;

    const hits: RayHit[] = [];
    for (const body of this.bodies.values()) {
      if (!passesQuery(body, options)) continue;
      const hit = raycastShape(body.shape, origin, unit, limit);
      if (hit) {
        hits.push({
          entityId: body.id,
          distance: hit.distance,
          point: hit.point,
          normal: hit.normal,
        });
      }
    }
    return hits.sort((x, y) => x.distance - y.distance);
  }

  /** Bodies overlapping a sphere — an explosion's blast radius, an aggro check. */
  overlapSphere(center: Vec3, radius: number, options: QueryOptions = {}): EntityId[] {
    return this.overlapShape({ kind: 'sphere', center, radius: Math.max(EPSILON, radius) }, options);
  }

  /** Bodies overlapping any shape. Triggers are included here — overlap is the whole question. */
  overlapShape(shape: WorldShape, options: QueryOptions = {}): EntityId[] {
    return this.overlapContacts(shape, { includeTriggers: true, ...options }).map((o) => o.entityId);
  }

  /**
   * Overlaps with the contact that describes each one.
   *
   * The kinematic character controller lives on this: it places its capsule where it wants to
   * be, asks what it is inside, and pushes back out along the normals it gets. That is the same
   * depenetration the solver does for dynamic bodies, done by hand because a character must not
   * be pushed by anything except its own resolution.
   */
  overlapContacts(
    shape: WorldShape,
    options: QueryOptions = {},
  ): { entityId: EntityId; contact: Contact }[] {
    const bounds = shapeBounds(shape);
    const out: { entityId: EntityId; contact: Contact }[] = [];
    for (const body of this.bodies.values()) {
      if (!passesQuery(body, options)) continue;
      if (!aabbOverlaps(bounds, body.bounds)) continue;
      const contact = collide(shape, body.shape);
      if (contact) out.push({ entityId: body.id, contact });
    }
    return out;
  }

  // ---------------------------------------------------------------- internal

  /** Moves a body's origin and carries its shape and bounds with it. */
  private moveTo(body: PhysicsBody, origin: Vec3): void {
    if (!isFiniteVec(origin)) return;
    const delta = sub(origin, body.origin);
    body.origin = [...origin];
    body.shape = translateShape(body.shape, delta);
    body.bounds = shapeBounds(body.shape);
  }
}

/** Contacts closing slower than this never bounce, however elastic the materials. */
const MIN_BOUNCE_SPEED = 0.5;

/** A displacement with the body's locked axes removed. */
function unlocked(body: PhysicsBody, delta: Vec3): Vec3 {
  return [
    body.locks[0] ? 0 : delta[0],
    body.locks[1] ? 0 : delta[1],
    body.locks[2] ? 0 : delta[2],
  ];
}

function pairKey(a: EntityId, b: EntityId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function accepts(self: PhysicsBody, other: PhysicsBody): boolean {
  const mask = self.mask.trim();
  if (mask === '' || mask === '*') return true;
  for (const entry of mask.split(',')) if (entry.trim() === other.layer) return true;
  return false;
}

function passesQuery(body: PhysicsBody, options: QueryOptions): boolean {
  if (body.isTrigger && !options.includeTriggers) return false;
  if (options.ignore?.includes(body.id)) return false;
  if (options.layers && options.layers.length > 0 && !options.layers.includes(body.layer)) {
    return false;
  }
  return true;
}

function normalizeOrNull(direction: Vec3): Vec3 | null {
  const len = length(direction);
  if (len < EPSILON || !Number.isFinite(len)) return null;
  return scale(direction, 1 / len);
}

/** The point a shape is positioned around — what `shapeOffset` is measured to. */
export function shapeCenter(shape: WorldShape): Vec3 {
  switch (shape.kind) {
    case 'sphere':
      return [...shape.center];
    case 'box':
      return [...shape.center];
    case 'capsule':
      return scale(add(shape.a, shape.b), 0.5);
    case 'plane':
    default:
      return scale(shape.normal, shape.constant);
  }
}

/** Slides a shape by a world-space delta without rebuilding it from its collider. */
export function translateShape(shape: WorldShape, delta: Vec3): WorldShape {
  if (delta[0] === 0 && delta[1] === 0 && delta[2] === 0) return shape;
  switch (shape.kind) {
    case 'sphere':
      return { ...shape, center: add(shape.center, delta) };
    case 'box':
      return { ...shape, center: add(shape.center, delta) };
    case 'capsule':
      return { ...shape, a: add(shape.a, delta), b: add(shape.b, delta) };
    case 'plane':
    default:
      // A plane only moves along its own normal; sliding one sideways changes nothing.
      return { ...shape, constant: shape.constant + dot(shape.normal, delta) };
  }
}
