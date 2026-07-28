import { describe, expect, it } from 'vitest';
import { createCharacterController } from '../components/CharacterController';
import { Engine } from '../loop/Engine';
import { createTransform, type Entity } from '../scene/types';
import { captureSaveGame, restoreSaveGame, SAVE_GAME_VERSION } from './SaveGame';

function player(position: [number, number, number] = [0, 0, 0]): Entity {
  return {
    id: 'player',
    name: 'Player',
    parentId: null,
    transform: createTransform(position),
    components: [createCharacterController()],
  };
}

describe('SaveGame', () => {
  it('captures the scene and the game state together', () => {
    const engine = new Engine();
    engine.scene.add(player());
    engine.setMode('play');
    engine.game.register('player', 'survivor', 100);
    engine.game.damage('player', 30);
    engine.game.setVar('wave', 2);

    const save = captureSaveGame(engine);

    expect(save.version).toBe(SAVE_GAME_VERSION);
    expect(save.scene.entities.map((e) => e.id)).toContain('player');
    expect(save.game.actors).toEqual([
      { id: 'player', faction: 'survivor', health: 70, maxHealth: 100, alive: true },
    ]);
    expect(save.game.vars).toEqual([['wave', 2]]);
  });

  it('restores exactly the captured moment, discarding anything after it', () => {
    const engine = new Engine();
    const entity = player([0, 0, 0]);
    engine.scene.add(entity);
    engine.setMode('play');
    engine.game.register('player', 'survivor', 100);
    engine.game.damage('player', 20);
    engine.game.setVar('wave', 1);

    const save = captureSaveGame(engine);

    // Keep playing past the save point.
    entity.transform.position = [50, 0, 0];
    engine.game.damage('player', 50);
    engine.game.setVar('wave', 2);
    engine.scene.remove('player');

    restoreSaveGame(engine, save);

    const restored = engine.scene.get('player');
    expect(restored?.transform.position).toEqual([0, 0, 0]);
    expect(engine.game.get('player')?.health).toBe(80);
    expect(engine.game.getVar('wave')).toBe(1);
  });

  it('does not change the engine mode', () => {
    const engine = new Engine();
    engine.scene.add(player());
    engine.setMode('play');
    const save = captureSaveGame(engine);

    restoreSaveGame(engine, save);
    expect(engine.getMode()).toBe('play');

    engine.setMode('edit');
    restoreSaveGame(engine, save);
    expect(engine.getMode()).toBe('edit');
  });

  it('fires restored rather than reset, so a listener keyed on reset does not fire', () => {
    const engine = new Engine();
    engine.scene.add(player());
    engine.setMode('play');
    const save = captureSaveGame(engine);

    let resets = 0;
    let restores = 0;
    engine.game.events.on('reset', () => (resets += 1));
    engine.game.events.on('restored', () => (restores += 1));

    restoreSaveGame(engine, save);

    expect(resets).toBe(0);
    expect(restores).toBe(1);
  });

  it('capturing outside Play mode still produces a loadable save with empty game state', () => {
    const engine = new Engine();
    engine.scene.add(player());
    const save = captureSaveGame(engine);

    expect(save.game.actors).toEqual([]);
    restoreSaveGame(engine, save);
    expect(engine.scene.get('player')).toBeDefined();
  });

  it('round-trips through JSON, the form a save file is actually stored in', () => {
    const engine = new Engine();
    engine.scene.add(player([1, 2, 3]));
    engine.setMode('play');
    engine.game.register('player', 'survivor', 60);
    engine.game.setVar('checkpoint', 'forest-gate');

    const save = captureSaveGame(engine);
    const roundTripped = JSON.parse(JSON.stringify(save));

    const fresh = new Engine();
    fresh.setMode('play');
    restoreSaveGame(fresh, roundTripped);

    expect(fresh.scene.get('player')?.transform.position).toEqual([1, 2, 3]);
    expect(fresh.game.get('player')?.maxHealth).toBe(60);
    expect(fresh.game.getVar('checkpoint')).toBe('forest-gate');
  });
});
