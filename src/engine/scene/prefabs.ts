import { createCamera } from '../components/Camera';
import { createCharacterController } from '../components/CharacterController';
import { createEnvironment } from '../components/Environment';
import { createLight } from '../components/Light';
import type { MeshRendererComponent, PrimitiveParams } from '../components/MeshRenderer';
import { createNpcAgent, type NpcArchetype } from '../components/NpcAgent';
import { createScript } from '../components/Script';
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
  | 'Directional Light'
  | 'Point Light'
  | 'Spot Light'
  | 'Camera'
  | 'Player'
  | 'Zombie'
  | 'Villager'
  | 'Animal'
  | 'Game Logic';

export const PREFAB_MENU: readonly PrefabKind[] = [
  'Player',
  'Zombie',
  'Villager',
  'Animal',
  'Camera',
  'Directional Light',
  'Point Light',
  'Spot Light',
  'Environment',
  'Game Logic',
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
      body.components.push(createCharacterController());

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
  entities.push(ground);

  const crates: Vec3[] = [
    [4, 0.5, -3],
    [-5, 0.5, 2],
    [1, 0.5, 6],
  ];
  for (const [index, position] of crates.entries()) {
    entities.push(
      createPrimitiveEntity('Box', { name: `Crate ${index + 1}`, position, color: '#8a6a45' }),
    );
  }

  entities.push(...createPrefab('Player', { position: [0, 0, 0] }));
  // Parked outside their own sight range, so a play session opens with them wandering and
  // turns into a chase when you walk over — rather than a fight that starts on frame one.
  entities.push(...createPrefab('Zombie', { position: [16, 0, -16] }));
  entities.push(...createPrefab('Zombie', { name: 'Zombie 2', position: [-18, 0, -9] }));

  return entities;
}
