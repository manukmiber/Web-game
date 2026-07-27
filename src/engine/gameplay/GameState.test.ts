import { describe, expect, it } from 'vitest';
import { GameState } from './GameState';

describe('GameState', () => {
  it('registers an actor at full health', () => {
    const game = new GameState();
    const actor = game.register('e1', 'survivor', 80);
    expect(actor).toMatchObject({ health: 80, maxHealth: 80, alive: true });
  });

  it('keeps current health when re-registered, so a live edit does not heal anyone', () => {
    const game = new GameState();
    game.register('e1', 'survivor', 100);
    game.damage('e1', 40);
    game.register('e1', 'survivor', 120);

    expect(game.get('e1')?.health).toBe(60);
    expect(game.get('e1')?.maxHealth).toBe(120);
  });

  it('clamps health when maxHealth is edited downward mid-play', () => {
    const game = new GameState();
    game.register('e1', 'survivor', 100);
    // Lowering the ceiling in the Inspector must bring the actor under it, or `health01`
    // reads above 1 and drives an output binding past its own max.
    game.register('e1', 'survivor', 30);

    expect(game.get('e1')?.health).toBe(30);
    expect(game.get('e1')?.maxHealth).toBe(30);
  });

  it('reports damage and death exactly once', () => {
    const game = new GameState();
    game.register('e1', 'undead', 20);

    const damaged: number[] = [];
    let deaths = 0;
    game.events.on('damaged', ({ health }) => damaged.push(health));
    game.events.on('died', () => (deaths += 1));

    game.damage('e1', 8, 'attacker');
    game.damage('e1', 30, 'attacker');
    // Already dead: no further events, and no negative health.
    game.damage('e1', 10, 'attacker');

    expect(damaged).toEqual([12, 0]);
    expect(deaths).toBe(1);
    expect(game.get('e1')?.health).toBe(0);
    expect(game.isAlive('e1')).toBe(false);
  });

  it('heals up to the maximum and never revives the dead', () => {
    const game = new GameState();
    game.register('e1', 'survivor', 50);
    game.damage('e1', 20);
    expect(game.heal('e1', 100)).toBe(50);

    game.damage('e1', 50);
    expect(game.heal('e1', 10)).toBe(0);
    expect(game.isAlive('e1')).toBe(false);
  });

  it('does nothing for an entity it has never seen', () => {
    const game = new GameState();
    expect(game.damage('ghost', 10)).toBe(-1);
    expect(game.isAlive('ghost')).toBe(false);
  });

  it('carries script variables with a fallback', () => {
    const game = new GameState();
    expect(game.getVar('score', 0)).toBe(0);
    game.setVar('score', 12);
    expect(game.getVar('score')).toBe(12);
  });

  it('drops everything on reset — that is what stopping Play mode means', () => {
    const game = new GameState();
    game.register('e1', 'survivor', 10);
    game.setVar('wave', 3);

    let resets = 0;
    game.events.on('reset', () => (resets += 1));
    game.reset();

    expect(game.list()).toEqual([]);
    expect(game.getVar('wave', 0)).toBe(0);
    expect(resets).toBe(1);
  });
});
