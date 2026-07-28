import type { CharacterControllerComponent } from '../components/CharacterController';
import { hostileFactions, type NpcAgentComponent } from '../components/NpcAgent';
import type { QueryDescriptor } from '../ecs/Query';
import type { Engine, EngineMode, System, SystemStage } from '../loop/Engine';
import type { Entity, EntityId, Vec3 } from '../scene/types';
import {
  distanceXZ,
  hashSeed,
  mulberry32,
  randomPointInDisc,
  stepAngle,
  stepAway,
  stepTowards,
  yawTowards,
} from './steering';

export const NPC_STATES = ['idle', 'wander', 'chase', 'flee', 'attack', 'dead'] as const;
export type NpcState = (typeof NPC_STATES)[number];

interface AgentRuntime {
  state: NpcState;
  /** Spawn position, captured on entering Play mode. Wandering happens around this. */
  home: Vec3;
  targetId: EntityId | null;
  wanderX: number;
  wanderZ: number;
  /** Seconds left standing still at a wander destination. */
  pause: number;
  /** Seconds until the next attack lands. */
  cooldown: number;
  rng: () => number;
}

/** One frame's snapshot of everything an agent might react to. */
interface Actor {
  id: EntityId;
  faction: string;
  position: Vec3;
}

/** Agents, and the characters they treat as targets. Module constants so nothing rebuilds them. */
const AGENTS: QueryDescriptor = { all: ['NpcAgent'] };
const PLAIN_CHARACTERS: QueryDescriptor = { all: ['CharacterController'], none: ['NpcAgent'] };

/**
 * Drives NpcAgent entities: a small state machine per agent over the pure steering helpers.
 *
 * Runs in Play mode only, and keeps every scrap of its state in this map rather than in the
 * components it reads — see the note on NpcAgentComponent for why that matters.
 *
 * What it deliberately is not: a navigation system. Agents walk in straight lines and pass
 * through walls, because there is no collision, no navmesh and no physics yet. Sight is
 * distance, not line of sight. Those are the next things to add here, and the state machine is
 * shaped so they slot into `findTarget` and `moveTo` rather than needing a rewrite.
 */
export class NpcSystem implements System {
  readonly name = 'NpcSystem';
  readonly runsIn: readonly EngineMode[] = ['play'];
  /** Last, reacting to a world that has finished moving. */
  readonly stage: SystemStage = 'resolve';
  readonly after = ['CharacterSystem'];

  private runtimes = new Map<EntityId, AgentRuntime>();

  /** Current behaviour state, for the editor's debug readout. */
  stateOf(id: EntityId): NpcState | null {
    return this.runtimes.get(id)?.state ?? null;
  }

  targetOf(id: EntityId): EntityId | null {
    return this.runtimes.get(id)?.targetId ?? null;
  }

  reset(): void {
    this.runtimes.clear();
  }

  dispose(): void {
    this.runtimes.clear();
  }

  update(dt: number, engine: Engine): void {
    const { game, ecs } = engine;

    const agents: { entity: Entity; agent: NpcAgentComponent }[] = [];
    const actors: Actor[] = [];

    // Two queries instead of one walk of the scene. An agent is also an actor; a character that
    // is not an agent is an actor too, which is what `none` expresses — the player is a target
    // for the agents but is not steered by them.
    for (const entity of ecs.entities(AGENTS)) {
      const agent = entity.components.find((c): c is NpcAgentComponent => c.type === 'NpcAgent')!;
      agents.push({ entity, agent });
      actors.push({ id: entity.id, faction: agent.faction, position: entity.transform.position });
    }
    for (const entity of ecs.entities(PLAIN_CHARACTERS)) {
      const character = entity.components.find(
        (c): c is CharacterControllerComponent => c.type === 'CharacterController',
      )!;
      actors.push({
        id: entity.id,
        faction: character.faction,
        position: entity.transform.position,
      });
    }

    // Agents deleted (by a script, or by an undo landing mid-play) leave their runtime behind.
    if (this.runtimes.size > agents.length) {
      const live = new Set(agents.map(({ entity }) => entity.id));
      for (const id of [...this.runtimes.keys()]) if (!live.has(id)) this.runtimes.delete(id);
    }

    for (const { entity, agent } of agents) {
      const runtime = this.runtimeFor(entity, agent, engine);
      if (!game.isAlive(entity.id)) {
        runtime.state = 'dead';
        continue;
      }
      this.updateAgent(dt, engine, entity, agent, runtime, actors);
    }
  }

  // ---------------------------------------------------------------- internal

  private runtimeFor(entity: Entity, agent: NpcAgentComponent, engine: Engine): AgentRuntime {
    let runtime = this.runtimes.get(entity.id);
    if (!runtime) {
      const rng = mulberry32(hashSeed(entity.id));
      const home: Vec3 = [...entity.transform.position];
      runtime = {
        state: 'idle',
        home,
        targetId: null,
        wanderX: home[0],
        wanderZ: home[2],
        // Stagger the first move so a row of identical zombies doesn't step in lockstep.
        pause: rng() * agent.wanderPause,
        cooldown: 0,
        rng,
      };
      this.runtimes.set(entity.id, runtime);
    }
    // Registering every frame keeps health tracking in step with Inspector edits made while
    // playing; `register` is idempotent and preserves current health.
    engine.game.register(entity.id, agent.faction, agent.maxHealth);
    return runtime;
  }

  private updateAgent(
    dt: number,
    engine: Engine,
    entity: Entity,
    agent: NpcAgentComponent,
    runtime: AgentRuntime,
    actors: Actor[],
  ): void {
    runtime.cooldown = Math.max(0, runtime.cooldown - dt);

    const target =
      agent.behaviour === 'Passive' ? null : this.findTarget(engine, entity, agent, actors);
    runtime.targetId = target?.id ?? null;

    if (!target) {
      this.wander(dt, engine, entity, agent, runtime);
      return;
    }

    const distance = distanceXZ(entity.transform.position, target.position);

    if (agent.behaviour === 'Flee') {
      runtime.state = 'flee';
      const step = stepAway(
        entity.transform.position[0],
        entity.transform.position[2],
        target.position[0],
        target.position[2],
        agent.chaseSpeed,
        dt,
      );
      this.applyMove(engine, entity, agent, step.x, step.z, dt);
      // A fleeing agent that escapes wanders from wherever it ended up, not from its spawn.
      runtime.home = [...entity.transform.position];
      runtime.wanderX = step.x;
      runtime.wanderZ = step.z;
      return;
    }

    if (distance <= agent.attackRange) {
      runtime.state = 'attack';
      this.faceTowards(engine, entity, agent, target.position, dt);
      if (runtime.cooldown === 0) {
        runtime.cooldown = Math.max(0.05, agent.attackInterval);
        engine.game.damage(target.id, agent.attackDamage, entity.id);
      }
      return;
    }

    runtime.state = 'chase';
    const step = stepTowards(
      entity.transform.position[0],
      entity.transform.position[2],
      target.position[0],
      target.position[2],
      agent.chaseSpeed,
      dt,
      // Stop at the edge of attack range rather than walking into the target.
      agent.attackRange * 0.9,
    );
    this.applyMove(engine, entity, agent, step.x, step.z, dt);
  }

  private wander(
    dt: number,
    engine: Engine,
    entity: Entity,
    agent: NpcAgentComponent,
    runtime: AgentRuntime,
  ): void {
    if (agent.wanderRadius <= 0) {
      runtime.state = 'idle';
      return;
    }
    if (runtime.pause > 0) {
      runtime.pause -= dt;
      runtime.state = 'idle';
      return;
    }

    runtime.state = 'wander';
    const step = stepTowards(
      entity.transform.position[0],
      entity.transform.position[2],
      runtime.wanderX,
      runtime.wanderZ,
      agent.moveSpeed,
      dt,
      0.15,
    );
    this.applyMove(engine, entity, agent, step.x, step.z, dt);

    if (step.arrived) {
      const [x, z] = randomPointInDisc(
        runtime.rng,
        runtime.home[0],
        runtime.home[2],
        agent.wanderRadius,
      );
      runtime.wanderX = x;
      runtime.wanderZ = z;
      // Vary the pause so a group of agents drifts out of phase instead of pulsing together.
      runtime.pause = agent.wanderPause * (0.5 + runtime.rng());
    }
  }

  private findTarget(
    engine: Engine,
    entity: Entity,
    agent: NpcAgentComponent,
    actors: Actor[],
  ): Actor | null {
    const hostile = hostileFactions(agent);
    if (hostile.size === 0) return null;

    let best: Actor | null = null;
    let bestDistance = agent.sightRange;
    for (const actor of actors) {
      if (actor.id === entity.id) continue;
      if (!hostile.has((actor.faction ?? '').toLowerCase())) continue;
      // Unregistered means "not yet ticked by its own system", not "dead" — treating it as
      // dead would make agents ignore a player on the first frame of a play session.
      if (engine.game.get(actor.id)?.alive === false) continue;
      const distance = distanceXZ(entity.transform.position, actor.position);
      if (distance <= bestDistance) {
        best = actor;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** Writes a new XZ position and turns the agent to face the way it moved. */
  private applyMove(
    engine: Engine,
    entity: Entity,
    agent: NpcAgentComponent,
    x: number,
    z: number,
    dt: number,
  ): void {
    const { position, rotation } = entity.transform;
    const dx = x - position[0];
    const dz = z - position[2];
    position[0] = x;
    position[2] = z;
    // Below this the direction is numerical noise and the agent would spin on the spot.
    if (Math.hypot(dx, dz) > 1e-5) {
      rotation[1] = stepAngle(rotation[1], yawTowards(dx, dz), agent.turnSpeed * dt);
    }
    engine.scene.markTransformDirty(entity.id);
  }

  private faceTowards(
    engine: Engine,
    entity: Entity,
    agent: NpcAgentComponent,
    target: Vec3,
    dt: number,
  ): void {
    const { position, rotation } = entity.transform;
    const yaw = yawTowards(target[0] - position[0], target[2] - position[2]);
    const next = stepAngle(rotation[1], yaw, agent.turnSpeed * dt);
    if (next === rotation[1]) return;
    rotation[1] = next;
    engine.scene.markTransformDirty(entity.id);
  }
}
