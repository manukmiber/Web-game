import { createCamera } from '../components/Camera';
import { createCharacterController } from '../components/CharacterController';
import { createCollider } from '../components/Collider';
import { createEnvironment } from '../components/Environment';
import { createPhysics } from '../components/Physics';
import { createRigidBody } from '../components/RigidBody';
import { createHardwareInput } from '../components/HardwareInput';
import { createHardwareOutput } from '../components/HardwareOutput';
import { createLight } from '../components/Light';
import type { MeshRendererComponent, PrimitiveParams } from '../components/MeshRenderer';
import { createNpcAgent, type NpcArchetype } from '../components/NpcAgent';
import { createScatterLayer } from '../components/ScatterLayer';
import { createScript } from '../components/Script';
import { createPrototype, refillLayer } from '../scatter/layer';
import { createPrimitiveEntity } from './primitives';
import { generateEntityId } from './Scene';
import { createTransform, type Entity, type Vec3 } from './types';

/**
 * Ready-made entities: the things you add from a menu rather than build from a primitive plus
 * four components.
 *
 * They live in the engine rather than the editor for the same reason primitives do — the
 * runtime needs to spawn a zombie at least as often as the editor needs to place one, and a
 * spawner that had to reach into editor code would be the first crack in the §2 boundary.
 *
 * Composite prefabs return several entities, parents first. The Player is the one that
 * matters: its camera is a *child*, so the third-person rig is the transform hierarchy doing
 * the work rather than any follow code.
 */
export type PrefabKind =
  | 'Environment'
  | 'Physics'
  | 'Directional Light'
  | 'Point Light'
  | 'Spot Light'
  | 'Hemisphere Light'
  | 'Area Light'
  | 'Camera'
  | 'Rigid Box'
  | 'Ground Plane'
  | 'Trigger Volume'
  | 'Player'
  | 'Zombie'
  | 'Villager'
  | 'Animal'
  | 'Game Logic'
  | 'Hardware Rig'
  | 'Scatter Layer';

export const PREFAB_MENU: readonly PrefabKind[] = [
  'Player',
  'Zombie',
  'Villager',
  'Animal',
  'Camera',
  'Directional Light',
  'Point Light',
  'Spot Light',
  'Hemisphere Light',
  'Area Light',
  'Environment',
  'Physics',
  'Ground Plane',
  'Rigid Box',
  'Trigger Volume',
  'Scatter Layer',
  'Game Logic',
  'Hardware Rig',
];

export interface PrefabOptions {
  position?: Vec3;
  name?: string;
}

const SPAWNER_SOURCE = `// Spawns a zombie every few seconds, up to a cap.
let timer = 0;

function update(dt) {
  timer += dt;
  if (timer < props.interval) return;
  timer = 0;

  const alive = scene.withComponent('NpcAgent').length;
  if (alive >= props.maxAlive) return;

  const angle = Math.random() * Math.PI * 2;
  const zombie = scene.spawn('Capsule', {
    name: 'Zombie',
    position: [
      entity.position.x + Math.cos(angle) * props.radius,
      0.9,
      entity.position.z + Math.sin(angle) * props.radius,
    ],
    color: '#6d8c5a',
  });
  zombie.addComponent('NpcAgent', { archetype: 'Zombie' });
  console.log('spawned a zombie, ' + (alive + 1) + ' alive');
}
`;

const TRIGGER_SOURCE = `// Reports what enters this volume. Colliders marked "Is Trigger" push nothing.
let fired = false;

function onTriggerEnter(hit) {
  if (props.once && fired) return;
  fired = true;
  const other = scene.byId(hit.otherId);
  console.log((other ? other.name : hit.otherId) + ' entered ' + entity.name);
}

function onTriggerExit(otherId) {
  const other = scene.byId(otherId);
  console.log((other ? other.name : otherId) + ' left ' + entity.name);
}
`;

/** A crate that falls, reports its landing, and settles. Shipped with the physics prefabs. */
const IMPACT_SOURCE = `// Physics contacts arrive here. Impact speed is the closing speed at the contact.
function onCollisionEnter(hit) {
  if (hit.impactSpeed < props.minSpeed) return;
  console.log(entity.name + ' landed at ' + hit.impactSpeed.toFixed(1) + ' m/s');
}
`;

function empty(name: string, position: Vec3 = [0, 0, 0]): Entity {
  return {
    id: generateEntityId(),
    name,
    parentId: null,
    transform: createTransform(position),
    components: [],
  };
}

/** Primitive defaults are sized for the grid, not for characters. */
function withParams(entity: Entity, params: Partial<PrimitiveParams>): Entity {
  const renderer = entity.components.find(
    (c): c is MeshRendererComponent => c.type === 'MeshRenderer',
  );
  if (renderer) Object.assign(renderer.params, params);
  return entity;
}

function character(name: string, position: Vec3, color: string, archetype: NpcArchetype): Entity[] {
  const body = withParams(createPrimitiveEntity('Capsule', { name, position, color }), {
    radius: 0.32,
    height: 1.1,
    radialSegments: 12,
  });
  body.components.push(createNpcAgent({ archetype }));
  return [body];
}

export function createPrefab(kind: PrefabKind, options: PrefabOptions = {}): Entity[] {
  const at = options.position ?? [0, 0, 0];
  const ground: Vec3 = [at[0], 0, at[2]];

  switch (kind) {
    case 'Environment': {
      const entity = empty(options.name ?? 'Environment');
      entity.components.push(createEnvironment());
      return [entity];
    }

    /**
     * Scene-wide gravity and solver settings.
     *
     * Worth a menu entry even though physics works without it: the defaults are Earth, and the
     * first thing anyone wants from a physics engine is to change that. Finding the dial should
     * not require knowing that it lives on a component.
     */
    case 'Physics': {
      const entity = empty(options.name ?? 'Physics');
      entity.components.push(createPhysics());
      return [entity];
    }

    case 'Directional Light': {
      // High, angled, and pointing down: a sun anywhere else needs three edits before it
      // looks like anything.
      const entity = empty(options.name ?? 'Directional Light', [at[0], at[1] + 8, at[2]]);
      entity.transform.rotation = [-50, -30, 0];
      entity.components.push(createLight({ lightType: 'Directional', intensity: 2.2 }));
      return [entity];
    }

    case 'Point Light': {
      const entity = empty(options.name ?? 'Point Light', [at[0], at[1] + 3, at[2]]);
      entity.components.push(
        createLight({ lightType: 'Point', intensity: 2, range: 15, color: '#ffd9a8' }),
      );
      return [entity];
    }

    case 'Spot Light': {
      const entity = empty(options.name ?? 'Spot Light', [at[0], at[1] + 6, at[2]]);
      entity.transform.rotation = [-70, 0, 0];
      entity.components.push(
        createLight({ lightType: 'Spot', intensity: 3, range: 30, angle: 30, penumbra: 0.4 }),
      );
      return [entity];
    }

    case 'Hemisphere Light': {
      // Sky and bounce, no shadow pass. The cheapest outdoor fill in the engine, and the thing
      // that stops shaded sides reading as black.
      const entity = empty(options.name ?? 'Hemisphere Light', [at[0], at[1] + 10, at[2]]);
      entity.components.push(
        createLight({
          lightType: 'Hemisphere',
          intensity: 0.8,
          color: '#a8c8ff',
          groundColor: '#4a4034',
        }),
      );
      return [entity];
    }

    case 'Area Light': {
      // Facing down, because a softbox in a ceiling is what this is for. Local -Z is forward
      // for every light in the engine, so -90 on X points it at the floor.
      const entity = empty(options.name ?? 'Area Light', [at[0], at[1] + 4, at[2]]);
      entity.transform.rotation = [-90, 0, 0];
      entity.components.push(
        createLight({ lightType: 'Area', intensity: 4, width: 3, height: 2 }),
      );
      return [entity];
    }

    /**
     * A box that falls.
     *
     * The two-component pair — Collider plus RigidBody — is the whole physics API, and this is
     * the fastest way to see it work: add one above the ground, press Play, watch it land.
     */
    case 'Rigid Box': {
      const entity = createPrimitiveEntity('Box', {
        name: options.name ?? 'Rigid Box',
        position: [at[0], at[1] > 0 ? at[1] : 4, at[2]],
        color: '#b5793f',
      });
      entity.components.push(
        createCollider({ shape: 'Box', size: [1, 1, 1], restitution: 0.2, friction: 0.6 }),
        createRigidBody({ mass: 1 }),
        createScript({ name: 'Impact', source: IMPACT_SOURCE, props: { minSpeed: 1.5 } }),
      );
      return [entity];
    }

    /**
     * The floor. A wide visible plane plus an *infinite* Plane collider.
     *
     * The collider is deliberately not the same size as the mesh: a fast-moving body that leaves
     * the mesh's edge would otherwise fall out of the world, and an infinite half-space costs
     * the solver nothing — it is four numbers and no broadphase cell.
     */
    case 'Ground Plane': {
      const entity = withParams(
        createPrimitiveEntity('Plane', {
          name: options.name ?? 'Ground',
          position: ground,
          color: '#5c6b52',
        }),
        { width: 60, depth: 60 },
      );
      entity.components.push(createCollider({ shape: 'Plane', friction: 0.8 }));
      return [entity];
    }

    /**
     * A volume that reports what walks into it and pushes nothing.
     *
     * Ships with the script that reads it, because a trigger with no `onTriggerEnter` anywhere
     * is indistinguishable from a broken one.
     */
    case 'Trigger Volume': {
      const entity = empty(options.name ?? 'Trigger Volume', [ground[0], 1, ground[2]]);
      entity.components.push(
        createCollider({ shape: 'Box', size: [4, 2, 4], isTrigger: true }),
        createScript({ name: 'Trigger', source: TRIGGER_SOURCE, props: { once: false } }),
      );
      return [entity];
    }

    case 'Camera': {
      const entity = empty(options.name ?? 'Main Camera', [at[0], at[1] + 3, at[2] + 8]);
      entity.transform.rotation = [-12, 0, 0];
      entity.components.push(createCamera());
      return [entity];
    }

    case 'Player': {
      const body = withParams(
        createPrimitiveEntity('Capsule', {
          name: options.name ?? 'Player',
          position: [ground[0], 0, ground[2]],
          color: '#4c8fd6',
        }),
        { radius: 0.35, height: 1.2, radialSegments: 12 },
      );
      body.components.push(createCharacterController({ radius: 0.35, height: 1.2 }));

      // Behind and above, looking the way the character faces. No rotation of its own: -Z is
      // forward for both, so a camera sitting at +Z already looks down the character's front.
      const camera = empty('Player Camera', [0, 2.2, 5.5]);
      camera.parentId = body.id;
      camera.transform.rotation = [-12, 0, 0];
      camera.components.push(createCamera({ primary: true }));
      return [body, camera];
    }

    case 'Zombie':
      return character(options.name ?? 'Zombie', [ground[0], 0.9, ground[2]], '#6d8c5a', 'Zombie');

    case 'Villager':
      return character(
        options.name ?? 'Villager',
        [ground[0], 0.9, ground[2]],
        '#c8b48a',
        'Villager',
      );

    case 'Animal':
      return character(options.name ?? 'Animal', [ground[0], 0.9, ground[2]], '#9a6b45', 'Animal');

    /**
     * An empty carrying the default bindings, because the hardware layer is otherwise
     * invisible until someone has read the docs: this is a scene object you can add, plug a
     * board into and press Play.
     */
    case 'Hardware Rig': {
      const entity = empty(options.name ?? 'Hardware Rig', ground);
      entity.components.push(createHardwareInput(), createHardwareOutput());
      return [entity];
    }

    /**
     * A layer *and* the thing it scatters, filled in and already drawing.
     *
     * An empty ScatterLayer renders nothing and reads as broken — the feature is only legible
     * once there is a shrub in the viewport and two hundred copies of it around. The source is
     * a plain entity, deliberately: select it, change its colour or push a Bevel onto its
     * stack, and every instance follows.
     *
     * The source is parented *under* the layer so the pair is one top-level row that travels
     * together — and so adding one selects the layer alone. Two roots would select both, and a
     * multi-selection hides the scatter panel, which is the one thing you came for.
     */
    case 'Scatter Layer': {
      const entity = empty(options.name ?? 'Scatter Layer', ground);

      const source = withParams(
        createPrimitiveEntity('Cone', { name: 'Scatter Source', color: '#5f7f4a' }),
        { radius: 0.45, height: 1.4, radialSegments: 7 },
      );
      source.parentId = entity.id;

      const layer = createScatterLayer({ prototypes: [createPrototype(source.id)] });
      Object.assign(layer, refillLayer(layer));
      entity.components.push(layer);

      // Parent first, as every composite prefab must be. The layer references a source that
      // does not exist yet, which is fine: prototypes resolve at render time, and the bridge
      // rebuilds a layer when an entity it borrows from arrives.
      return [entity, source];
    }

    case 'Game Logic':
    default: {
      const entity = empty(options.name ?? 'Game Logic', ground);
      entity.components.push(
        createScript({
          name: 'Zombie Spawner',
          source: SPAWNER_SOURCE,
          props: { interval: 4, maxAlive: 12, radius: 14 },
        }),
      );
      return [entity];
    }
  }
}

/**
 * The scene a fresh editor opens with.
 *
 * It is a playable scene rather than two grey primitives on purpose: everything this version
 * added — a lit environment, a camera that follows a character, agents that react to it — is
 * invisible until something in the scene uses it, and "press Play and see" beats a paragraph
 * in a README.
 */
export function createStarterScene(): Entity[] {
  const entities: Entity[] = [];

  entities.push(...createPrefab('Environment'));
  entities.push(...createPrefab('Directional Light'));

  const ground = withParams(
    createPrimitiveEntity('Plane', { name: 'Ground', color: '#5c6b52' }),
    { width: 40, depth: 40 },
  );
  // An infinite half-space rather than a 40 m box: nothing can fall off the edge of the world,
  // and it costs the solver four numbers.
  ground.components.push(createCollider({ shape: 'Plane', friction: 0.8 }));
  entities.push(ground);

  /**
   * Crates that actually fall.
   *
   * Dropped from just above the ground rather than placed on it, which is the point: the first
   * second of Play mode now shows three boxes landing, settling and going to sleep. Physics that
   * is on but never visibly does anything is indistinguishable from physics that is off.
   */
  const crates: Vec3[] = [
    [4, 2.5, -3],
    [-5, 3.5, 2],
    [1, 1.2, 6],
  ];
  for (const [index, position] of crates.entries()) {
    const crate = createPrimitiveEntity('Box', {
      name: `Crate ${index + 1}`,
      position,
      color: '#8a6a45',
    });
    crate.components.push(
      createCollider({ shape: 'Box', size: [1, 1, 1], restitution: 0.15, friction: 0.6 }),
      createRigidBody({ mass: 1 }),
    );
    entities.push(crate);
  }

  entities.push(...createPrefab('Player', { position: [0, 0, 0] }));
  // Parked outside their own sight range, so a play session opens with them wandering and
  // turns into a chase when you walk over — rather than a fight that starts on frame one.
  entities.push(...createPrefab('Zombie', { position: [16, 0, -16] }));
  entities.push(...createPrefab('Zombie', { name: 'Zombie 2', position: [-18, 0, -9] }));

  return entities;
}
