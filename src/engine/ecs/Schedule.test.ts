import { describe, expect, it } from 'vitest';
import { scheduleSystems, type Schedulable, type SystemStage } from './Schedule';

function system(name: string, stage?: SystemStage, extra: Partial<Schedulable> = {}): Schedulable {
  return { name, stage, ...extra };
}

const names = (systems: readonly Schedulable[]) => systems.map((s) => s.name);

describe('system schedule', () => {
  it('orders by stage regardless of the order they were added in', () => {
    const { order, conflicts } = scheduleSystems([
      system('npcs', 'resolve'),
      system('hardware', 'input'),
      system('scripts', 'script'),
      system('physics', 'simulate'),
    ]);

    expect(names(order)).toEqual(['hardware', 'physics', 'scripts', 'npcs']);
    expect(conflicts).toEqual([]);
  });

  it('keeps insertion order within a stage', () => {
    const { order } = scheduleSystems([
      system('b', 'simulate'),
      system('a', 'simulate'),
      system('c', 'simulate'),
    ]);
    // Stable, so a schedule with no constraints behaves exactly like the hand-ordered list it
    // replaced. Anything else would make this change a behavioural one.
    expect(names(order)).toEqual(['b', 'a', 'c']);
  });

  it('defaults an unstaged system to simulate', () => {
    const { order } = scheduleSystems([
      system('present', 'present'),
      system('unstaged'),
      system('input', 'input'),
    ]);
    expect(names(order)).toEqual(['input', 'unstaged', 'present']);
  });

  it('honours `after` within a stage', () => {
    const { order, conflicts } = scheduleSystems([
      system('npcs', 'resolve', { after: ['characters'] }),
      system('characters', 'resolve'),
    ]);
    expect(names(order)).toEqual(['characters', 'npcs']);
    expect(conflicts).toEqual([]);
  });

  it('honours `before`', () => {
    const { order } = scheduleSystems([
      system('late', 'simulate'),
      system('early', 'simulate', { before: ['late'] }),
    ]);
    expect(names(order)).toEqual(['early', 'late']);
  });

  it('ignores a dependency on a system that is not installed', () => {
    // A system may declare `after: ['PhysicsSystem']` and be dropped into a headless setup that
    // has no physics. Erroring there would make every optional dependency a hard one.
    const { order, conflicts } = scheduleSystems([system('a', 'simulate', { after: ['absent'] })]);
    expect(names(order)).toEqual(['a']);
    expect(conflicts).toEqual([]);
  });

  it('skips a stage with no members', () => {
    const { order } = scheduleSystems([system('present', 'present'), system('input', 'input')]);
    expect(names(order)).toEqual(['input', 'present']);
  });

  it('reports a cycle instead of throwing, and still returns every system', () => {
    const { order, conflicts } = scheduleSystems([
      system('a', 'simulate', { after: ['b'] }),
      system('b', 'simulate', { after: ['a'] }),
    ]);

    // A cycle is a programming error, but throwing mid-frame turns a mis-ordered system into a
    // blank viewport. Every system still runs; the host reports the contradiction.
    expect(names(order).sort()).toEqual(['a', 'b']);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('cycle');
  });

  it('reports an `after` that contradicts the stages', () => {
    const { order, conflicts } = scheduleSystems([
      system('early', 'input', { after: ['late'] }),
      system('late', 'present'),
    ]);
    expect(order).toHaveLength(2);
    expect(conflicts).toHaveLength(1);
  });

  it('reports duplicate names', () => {
    const { conflicts } = scheduleSystems([system('same', 'simulate'), system('same', 'simulate')]);
    expect(conflicts[0]).toContain('Two systems are named');
  });

  it('handles an empty list', () => {
    expect(scheduleSystems([])).toEqual({ order: [], conflicts: [] });
  });
});
