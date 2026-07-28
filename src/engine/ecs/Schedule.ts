/**
 * System ordering, declared rather than implied.
 *
 * Before this, the order systems ran in was the order `installGameplaySystems` happened to push
 * them, documented by a numbered comment above the pushes. That comment was correct and it was
 * also the only thing holding the frame together: hardware has to be pumped before scripts read
 * it, physics has to step before scripts are told what collided, NPCs have to run after the
 * player moved. Insert one system in the wrong place and every one of those breaks silently, in
 * ways that look like a one-frame input lag rather than like a scheduling bug.
 *
 * So the constraints move onto the systems themselves — a `stage`, and optional `after`/`before`
 * — and the order is computed. Two things fall out that a hand-ordered list cannot give: a
 * system added by a plugin or a test lands in the right place without knowing the list, and a
 * contradiction ("A after B" and "B after A") is *reported* rather than resolved arbitrarily.
 */

/**
 * The five points in a frame where a system can want to run.
 *
 * Fewer than most engines expose, and each one earns its place by being a boundary something
 * actually depends on rather than a convenient label:
 *
 * - `input`   — devices become this frame's snapshot. Nothing may read input before this.
 * - `simulate`— the authoritative world step: the solver, and anything that moves bodies.
 * - `script`  — user code, which must see a stepped world and this frame's contacts.
 * - `resolve` — things that react to decisions made in `script`: the character, the agents.
 * - `present` — anything that only reads: cameras, HUD state, telemetry.
 */
export const SYSTEM_STAGES = ['input', 'simulate', 'script', 'resolve', 'present'] as const;
export type SystemStage = (typeof SYSTEM_STAGES)[number];

export const DEFAULT_SYSTEM_STAGE: SystemStage = 'simulate';

export interface Schedulable {
  readonly name: string;
  /** Which point in the frame this runs at. Defaults to `simulate`. */
  readonly stage?: SystemStage;
  /** Names that must run before this one. Unknown names are ignored, not an error. */
  readonly after?: readonly string[];
  /** Names that must run after this one. */
  readonly before?: readonly string[];
}

export interface ScheduleResult<T extends Schedulable> {
  order: T[];
  /**
   * Constraints that could not be satisfied, as human-readable sentences.
   *
   * Returned rather than thrown. A cycle in the schedule is a programming error, but throwing
   * from the middle of a frame turns a mis-ordered system into a blank viewport — the frame runs
   * in a defensible order and the host reports the problem.
   */
  conflicts: string[];
}

/**
 * Topological sort by stage, then by explicit dependencies, stable within ties.
 *
 * Stage membership is expressed as edges like any other constraint, which is what lets an
 * explicit `after` be *checked* against it instead of quietly fighting it: a `present` system
 * asking to run after an `input` one is consistent and costs nothing, while an `input` system
 * asking to run after a `present` one is a contradiction and is reported as one.
 */
export function scheduleSystems<T extends Schedulable>(systems: readonly T[]): ScheduleResult<T> {
  const conflicts: string[] = [];
  const byName = new Map<string, number>();
  systems.forEach((system, index) => {
    if (byName.has(system.name)) {
      conflicts.push(`Two systems are named "${system.name}"; ordering between them is arbitrary.`);
      return;
    }
    byName.set(system.name, index);
  });

  const stageOf = (system: T): number => SYSTEM_STAGES.indexOf(system.stage ?? DEFAULT_SYSTEM_STAGE);

  /** edges[i] holds indices that must run *after* i. */
  const edges: Set<number>[] = systems.map(() => new Set<number>());
  const indegree = systems.map(() => 0);

  const addEdge = (from: number, to: number): void => {
    if (from === to || edges[from]!.has(to)) return;
    edges[from]!.add(to);
    indegree[to]! += 1;
  };

  // Stage edges: every member of an earlier stage before every member of a later one. Written
  // as all pairs rather than stage-to-next-stage because an empty stage in the middle would
  // break a chain of consecutive links, and a frame has ten systems in it — the quadratic pass
  // is a few dozen comparisons, once, whenever the system list changes.
  for (let i = 0; i < systems.length; i += 1) {
    for (let j = 0; j < systems.length; j += 1) {
      if (stageOf(systems[i]!) < stageOf(systems[j]!)) addEdge(i, j);
    }
  }

  for (let i = 0; i < systems.length; i += 1) {
    const system = systems[i]!;
    for (const name of system.after ?? []) {
      const other = byName.get(name);
      if (other === undefined) continue;
      addEdge(other, i);
    }
    for (const name of system.before ?? []) {
      const other = byName.get(name);
      if (other === undefined) continue;
      addEdge(i, other);
    }
  }

  // Kahn's algorithm, taking ready nodes in insertion order so the result is stable and, for a
  // list with no constraints at all, identical to the order the systems were added in.
  const order: T[] = [];
  const remaining = new Set(systems.map((_, i) => i));
  const degree = [...indegree];

  while (remaining.size > 0) {
    let next = -1;
    for (const index of remaining) {
      if (degree[index] === 0) {
        next = index;
        break;
      }
    }

    if (next === -1) {
      // Everything left is in a cycle. Break it at the earliest-added member, which keeps the
      // sort total and makes the reported conflict deterministic.
      next = [...remaining][0]!;
      conflicts.push(
        `Ordering cycle involving "${systems[next]!.name}"; it ran in the order it was added.`,
      );
      degree[next] = 0;
    }

    remaining.delete(next);
    order.push(systems[next]!);
    for (const target of edges[next]!) degree[target]! -= 1;
  }

  return { order, conflicts };
}
