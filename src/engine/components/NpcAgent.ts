import type { Component } from '../scene/types';
import { registerComponent, type FieldSchema } from './registry';

export const NPC_ARCHETYPES = ['Zombie', 'Villager', 'Animal'] as const;
export type NpcArchetype = (typeof NPC_ARCHETYPES)[number];

export const NPC_BEHAVIOURS = ['Hunt', 'Flee', 'Passive'] as const;
export type NpcBehaviour = (typeof NPC_BEHAVIOURS)[number];

/**
 * An autonomous character: where it stands in the world's factions, how fast it moves, and
 * what it does when it sees something it cares about.
 *
 * Deliberately configuration only — no `state`, no `currentTarget`, no `health` that ticks
 * down. Runtime state lives in the NpcSystem and the GameState registry, never in the
 * component, because ARCHITECTURE.md §6 promises Play mode restores the scene exactly as it
 * was on exit. A zombie that chased you across the map and then persisted its half-empty health
 * bar into the saved scene would break that promise quietly, one field at a time.
 */
export interface NpcAgentComponent extends Component {
  type: 'NpcAgent';
  archetype: NpcArchetype;
  behaviour: NpcBehaviour;
  /** Free-form group name. Anything not in `hostileTo` is ignored. */
  faction: string;
  /** Comma-separated faction names this agent reacts to. */
  hostileTo: string;
  /** Metres per second when wandering. */
  moveSpeed: number;
  /** Metres per second when chasing or fleeing. */
  chaseSpeed: number;
  /** Degrees per second. Low values make a zombie lumber; high ones make it snap around. */
  turnSpeed: number;
  sightRange: number;
  attackRange: number;
  attackDamage: number;
  /** Seconds between attacks. */
  attackInterval: number;
  /** Radius around its spawn point an idle agent wanders within. */
  wanderRadius: number;
  /** Seconds it pauses at each wander destination. */
  wanderPause: number;
  maxHealth: number;
}

/** Archetypes are presets, not behaviour — every field stays editable afterwards. */
const ARCHETYPE_PRESETS: Record<NpcArchetype, Partial<NpcAgentComponent>> = {
  Zombie: {
    behaviour: 'Hunt',
    faction: 'undead',
    hostileTo: 'survivor',
    moveSpeed: 0.9,
    chaseSpeed: 2.6,
    turnSpeed: 160,
    sightRange: 18,
    attackRange: 1.4,
    attackDamage: 9,
    attackInterval: 1.2,
    wanderRadius: 6,
    maxHealth: 60,
  },
  Villager: {
    behaviour: 'Flee',
    faction: 'survivor',
    hostileTo: 'undead',
    moveSpeed: 1.4,
    chaseSpeed: 4,
    turnSpeed: 320,
    sightRange: 14,
    attackRange: 1.2,
    attackDamage: 4,
    attackInterval: 1,
    wanderRadius: 10,
    maxHealth: 80,
  },
  Animal: {
    behaviour: 'Flee',
    faction: 'wildlife',
    hostileTo: 'undead,survivor',
    moveSpeed: 1.1,
    chaseSpeed: 6,
    turnSpeed: 420,
    sightRange: 12,
    attackRange: 1,
    attackDamage: 2,
    attackInterval: 1.5,
    wanderRadius: 14,
    maxHealth: 30,
  },
};

export function createNpcAgent(overrides: Partial<NpcAgentComponent> = {}): NpcAgentComponent {
  const archetype = overrides.archetype ?? 'Zombie';
  return {
    type: 'NpcAgent',
    archetype,
    behaviour: 'Hunt',
    faction: 'undead',
    hostileTo: 'survivor',
    moveSpeed: 1,
    chaseSpeed: 2.5,
    turnSpeed: 180,
    sightRange: 16,
    attackRange: 1.4,
    attackDamage: 8,
    attackInterval: 1.2,
    wanderRadius: 8,
    wanderPause: 1.5,
    maxHealth: 50,
    ...ARCHETYPE_PRESETS[archetype],
    ...overrides,
  };
}

/** Splits `hostileTo` into a set, tolerating spaces and empty entries. */
export function hostileFactions(agent: NpcAgentComponent): Set<string> {
  return new Set(
    (agent.hostileTo ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
}

registerComponent<NpcAgentComponent>({
  type: 'NpcAgent',
  label: 'NPC Agent',
  create: createNpcAgent,
  fields(component) {
    const fields: FieldSchema[] = [
      { kind: 'enum', key: 'archetype', label: 'Archetype', options: NPC_ARCHETYPES },
      { kind: 'enum', key: 'behaviour', label: 'Behaviour', options: NPC_BEHAVIOURS },
      { kind: 'string', key: 'faction', label: 'Faction' },
      { kind: 'string', key: 'hostileTo', label: 'Reacts To' },
      { kind: 'number', key: 'moveSpeed', label: 'Walk Speed', min: 0, step: 0.1 },
      { kind: 'number', key: 'chaseSpeed', label: 'Run Speed', min: 0, step: 0.1 },
      { kind: 'number', key: 'turnSpeed', label: 'Turn Speed', min: 1, step: 10 },
      { kind: 'number', key: 'sightRange', label: 'Sight Range', min: 0, step: 0.5 },
      { kind: 'number', key: 'wanderRadius', label: 'Wander Radius', min: 0, step: 0.5 },
      { kind: 'number', key: 'wanderPause', label: 'Wander Pause', min: 0, step: 0.1 },
      { kind: 'number', key: 'maxHealth', label: 'Max Health', min: 1, step: 1 },
    ];
    // Attack settings only mean anything to something that closes in.
    if (component.behaviour === 'Hunt') {
      fields.push(
        { kind: 'number', key: 'attackRange', label: 'Attack Range', min: 0, step: 0.1 },
        { kind: 'number', key: 'attackDamage', label: 'Attack Damage', min: 0, step: 1 },
        { kind: 'number', key: 'attackInterval', label: 'Attack Every', min: 0.05, step: 0.1 },
      );
    }
    return fields;
  },
});
