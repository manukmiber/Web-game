import { beforeEach, describe, expect, it } from 'vitest';
import '@engine/components';
import '@engine/assistant/tools';
import { executeTool, type ToolContext } from '@engine/assistant/ToolRegistry';
import { Scene } from '@engine/scene/Scene';
import { CommandHistory } from '../commands/Command';
import { CommandSceneEditor } from './CommandSceneEditor';

let scene: Scene;
let history: CommandHistory;
let context: ToolContext;

function call(name: string, input: Record<string, unknown> = {}) {
  return executeTool(name, input, context);
}

beforeEach(() => {
  scene = new Scene();
  history = new CommandHistory();
  context = { editor: new CommandSceneEditor(scene, history), spawnPoint: () => [0, 0, 0] };
});

/**
 * The load-bearing promise of the whole assistant: nothing it does escapes Ctrl+Z.
 *
 * An assistant whose edits cannot be taken back is one nobody will try anything ambitious
 * with, so these are less about the command layer than about whether the feature is usable at
 * all.
 */
describe('assistant edits on the undo stack', () => {
  it('records one entry per tool call, however many steps it took', () => {
    call('create_prefab', { kind: 'Player' });
    // A Player is a body plus a camera, added through one command.
    expect(scene.size).toBe(2);
    expect(history.undoLabels()).toHaveLength(1);
  });

  it('undoes a multi-step tool call in a single step', () => {
    call('duplicate_entity', {
      entity: (() => {
        call('create_primitive', { kind: 'Box', name: 'Post' });
        return 'Post';
      })(),
      count: 5,
      offset: [2, 0, 0],
    });
    expect(scene.size).toBe(6);
    expect(history.undoLabels()).toHaveLength(2);

    history.undo();
    expect(scene.size).toBe(1);
    history.undo();
    expect(scene.size).toBe(0);
  });

  it('redoes what it undid', () => {
    call('create_primitive', { kind: 'Box', name: 'Crate', position: [3, 0, 0] });
    const id = scene.all()[0]!.id;

    history.undo();
    expect(scene.has(id)).toBe(false);
    history.redo();
    expect(scene.expect(id).transform.position).toEqual([3, 0, 0]);
  });

  it('groups the several writes of one script edit into one entry', () => {
    call('create_primitive', { kind: 'Box', name: 'Spinner' });
    call('set_script', { entity: 'Spinner', source: 'function update(dt) {}', name: 'Spin', props: { speed: 2 } });
    expect(history.undoLabels()).toHaveLength(2);

    history.undo();
    expect(scene.getComponent(scene.all()[0]!.id, 'Script')).toBeUndefined();
  });

  it('leaves the scene untouched when a tool rejects its arguments', () => {
    const result = call('create_primitive', { kind: 'Box', params: { size: 3 } });
    expect(result.isError).toBe(true);
    expect(scene.size).toBe(0);
    expect(history.undoLabels()).toHaveLength(0);
  });

  it('names the entry after the tool, so history reads as a list of intentions', () => {
    call('create_prefab', { kind: 'Zombie' });
    expect(history.undoLabels()[0]).toContain('Zombie');
  });
});
