import { beforeEach, describe, expect, it } from 'vitest';
import { Scene } from '@engine/scene/Scene';
import { createPrimitiveEntity } from '@engine/scene/primitives';
import type { Transform } from '@engine/scene/types';
import { CommandHistory } from './Command';
import {
  AddEntityCommand,
  DeleteEntitiesCommand,
  DuplicateEntitiesCommand,
  GroupEntitiesCommand,
  RemoveComponentCommand,
  RenameEntityCommand,
  ReparentEntitiesCommand,
  SetComponentPropertyCommand,
  SetTransformCommand,
} from './sceneCommands';

let scene: Scene;
let history: CommandHistory;

beforeEach(() => {
  scene = new Scene();
  history = new CommandHistory();
});

function addPrimitive(kind: Parameters<typeof createPrimitiveEntity>[0], name?: string) {
  const command = new AddEntityCommand(scene, createPrimitiveEntity(kind, name ? { name } : {}));
  history.execute(command);
  return command.entityId;
}

describe('AddEntityCommand', () => {
  it('adds and removes on undo', () => {
    const id = addPrimitive('Box');
    expect(scene.has(id)).toBe(true);

    history.undo();
    expect(scene.has(id)).toBe(false);

    history.redo();
    expect(scene.has(id)).toBe(true);
  });

  it('disambiguates names against existing entities', () => {
    addPrimitive('Box');
    addPrimitive('Box');
    expect(scene.all().map((e) => e.name)).toEqual(['Box', 'Box (1)']);
  });
});

describe('DeleteEntitiesCommand', () => {
  it('restores a subtree with hierarchy and sibling order intact', () => {
    const a = addPrimitive('Box', 'A');
    const b = addPrimitive('Box', 'B');
    const c = addPrimitive('Box', 'C');
    scene.reparent(c, a);

    history.execute(new DeleteEntitiesCommand(scene, [a]));
    expect(scene.size).toBe(1);

    history.undo();
    expect(scene.size).toBe(3);
    expect(scene.rootIds()).toEqual([a, b]);
    expect(scene.childrenOf(a)).toEqual([c]);
  });

  it('handles a selection containing both a parent and its child', () => {
    const parent = addPrimitive('Empty');
    const child = addPrimitive('Box');
    scene.reparent(child, parent);

    history.execute(new DeleteEntitiesCommand(scene, [parent, child]));
    expect(scene.size).toBe(0);

    history.undo();
    expect(scene.size).toBe(2);
    expect(scene.childrenOf(parent)).toEqual([child]);
  });

  it('restores an entity to its original sibling index, not the end', () => {
    const a = addPrimitive('Box', 'A');
    const b = addPrimitive('Box', 'B');
    const c = addPrimitive('Box', 'C');

    history.execute(new DeleteEntitiesCommand(scene, [b]));
    history.undo();

    expect(scene.rootIds()).toEqual([a, b, c]);
  });
});

describe('SetTransformCommand', () => {
  const move = (id: string, transform: Partial<Transform>) =>
    new SetTransformCommand(scene, new Map([[id, transform]]));

  it('applies and reverts', () => {
    const id = addPrimitive('Box');
    history.execute(move(id, { position: [5, 0, 0] }));
    expect(scene.expect(id).transform.position).toEqual([5, 0, 0]);

    history.undo();
    expect(scene.expect(id).transform.position).toEqual([0, 0, 0]);
  });

  it('coalesces a drag into a single history entry that reverts to the pre-drag state', () => {
    const id = addPrimitive('Box');
    const before = history.undoLabels().length;

    // Simulates the frames of one gizmo drag.
    for (const x of [1, 2, 3, 4, 5]) history.execute(move(id, { position: [x, 0, 0] }));

    expect(scene.expect(id).transform.position).toEqual([5, 0, 0]);
    expect(history.undoLabels().length).toBe(before + 1);

    history.undo();
    expect(scene.expect(id).transform.position).toEqual([0, 0, 0]);
  });

  it('does not merge across different entities', () => {
    const a = addPrimitive('Box');
    const b = addPrimitive('Box');
    const before = history.undoLabels().length;

    history.execute(move(a, { position: [1, 0, 0] }));
    history.execute(move(b, { position: [2, 0, 0] }));

    expect(history.undoLabels().length).toBe(before + 2);
  });

  it('coalesces a slow drag when it is wrapped in an interaction', async () => {
    const id = addPrimitive('Box');
    const before = history.undoLabels().length;

    // Longer than the 600ms merge window between steps — a careful placement drag, or any
    // snapped drag where the gizmo only reports on crossing an increment.
    history.beginInteraction();
    history.execute(move(id, { position: [1, 0, 0] }));
    await new Promise((resolve) => setTimeout(resolve, 700));
    history.execute(move(id, { position: [2, 0, 0] }));
    history.endInteraction();

    expect(history.undoLabels().length).toBe(before + 1);

    history.undo();
    expect(scene.expect(id).transform.position).toEqual([0, 0, 0]);
  });

  it('starts a new entry for each interaction even when they target the same object', () => {
    const id = addPrimitive('Box');
    const before = history.undoLabels().length;

    history.beginInteraction();
    history.execute(move(id, { position: [1, 0, 0] }));
    history.endInteraction();

    history.beginInteraction();
    history.execute(move(id, { position: [2, 0, 0] }));
    history.endInteraction();

    expect(history.undoLabels().length).toBe(before + 2);

    history.undo();
    expect(scene.expect(id).transform.position).toEqual([1, 0, 0]);
  });

  it('does not merge across an undo boundary', () => {
    const id = addPrimitive('Box');
    history.execute(move(id, { position: [1, 0, 0] }));
    history.undo();
    history.execute(move(id, { position: [2, 0, 0] }));

    history.undo();
    expect(scene.expect(id).transform.position).toEqual([0, 0, 0]);
  });
});

describe('RenameEntityCommand', () => {
  it('merges consecutive keystrokes into one undo step', () => {
    const id = addPrimitive('Box', 'Original');
    const before = history.undoLabels().length;

    for (const name of ['O', 'On', 'One']) history.execute(new RenameEntityCommand(scene, id, name));

    expect(scene.expect(id).name).toBe('One');
    expect(history.undoLabels().length).toBe(before + 1);

    history.undo();
    expect(scene.expect(id).name).toBe('Original');
  });
});

describe('ReparentEntitiesCommand', () => {
  it('keeps the entity in place in world space', () => {
    const parent = addPrimitive('Empty');
    const child = addPrimitive('Box');
    scene.setTransform(parent, { position: [10, 0, 0] });
    scene.setTransform(child, { position: [3, 0, 0] });

    history.execute(new ReparentEntitiesCommand(scene, [child], parent));

    // Local position rebased so world position is still x=3.
    expect(scene.expect(child).transform.position).toEqual([-7, 0, 0]);
    expect(scene.childrenOf(parent)).toEqual([child]);
  });

  it('restores parent and transform on undo', () => {
    const parent = addPrimitive('Empty');
    const child = addPrimitive('Box');
    scene.setTransform(parent, { position: [10, 0, 0] });

    history.execute(new ReparentEntitiesCommand(scene, [child], parent));
    history.undo();

    expect(scene.expect(child).parentId).toBeNull();
    expect(scene.expect(child).transform.position).toEqual([0, 0, 0]);
  });

  it('skips an illegal drop onto its own descendant instead of throwing', () => {
    const parent = addPrimitive('Empty');
    const child = addPrimitive('Box');
    scene.reparent(child, parent);

    expect(() => history.execute(new ReparentEntitiesCommand(scene, [parent], child))).not.toThrow();
    expect(scene.expect(parent).parentId).toBeNull();
  });
});

describe('DuplicateEntitiesCommand', () => {
  it('deep-copies a subtree with fresh ids', () => {
    const parent = addPrimitive('Empty', 'Rig');
    const child = addPrimitive('Box', 'Wheel');
    scene.reparent(child, parent);

    const command = new DuplicateEntitiesCommand(scene, [parent]);
    history.execute(command);

    expect(scene.size).toBe(4);
    const copyId = command.createdRootIds[0]!;
    expect(copyId).not.toBe(parent);
    expect(scene.expect(copyId).name).toBe('Rig (1)');
    // Children keep their names; only the duplicated root is disambiguated.
    expect(scene.expect(scene.childrenOf(copyId)[0]!).name).toBe('Wheel');
  });

  it('leaves the original untouched when the copy is edited', () => {
    const id = addPrimitive('Box');
    const command = new DuplicateEntitiesCommand(scene, [id]);
    history.execute(command);

    const copyId = command.createdRootIds[0]!;
    scene.updateComponent(copyId, 'Material', { color: '#ff0000' });

    expect(scene.getComponent(id, 'Material')?.color).toBe('#cccccc');
  });

  it('removes the copy on undo', () => {
    const id = addPrimitive('Box');
    history.execute(new DuplicateEntitiesCommand(scene, [id]));
    history.undo();

    expect(scene.size).toBe(1);
    expect(scene.has(id)).toBe(true);
  });
});

describe('GroupEntitiesCommand', () => {
  it('parents the selection under a new Empty at their centre', () => {
    const a = addPrimitive('Box');
    const b = addPrimitive('Box');
    scene.setTransform(a, { position: [0, 0, 0] });
    scene.setTransform(b, { position: [10, 0, 0] });

    const command = new GroupEntitiesCommand(scene, [a, b]);
    history.execute(command);

    const groupId = command.createdGroupId!;
    expect(scene.expect(groupId).transform.position).toEqual([5, 0, 0]);
    expect(scene.childrenOf(groupId)).toEqual([a, b]);
    // Rebased so both objects stay where they were in world space.
    expect(scene.expect(a).transform.position).toEqual([-5, 0, 0]);
    expect(scene.expect(b).transform.position).toEqual([5, 0, 0]);
  });

  it('fully reverses on undo', () => {
    const a = addPrimitive('Box');
    const b = addPrimitive('Box');
    scene.setTransform(b, { position: [10, 0, 0] });

    history.execute(new GroupEntitiesCommand(scene, [a, b]));
    history.undo();

    expect(scene.size).toBe(2);
    expect(scene.rootIds()).toEqual([a, b]);
    expect(scene.expect(b).transform.position).toEqual([10, 0, 0]);
  });
});

describe('component commands', () => {
  it('sets a nested property path and reverts it', () => {
    const id = addPrimitive('Box');
    history.execute(new SetComponentPropertyCommand(scene, [id], 'MeshRenderer', 'params.width', 4));

    expect(scene.getComponent(id, 'MeshRenderer')?.params).toMatchObject({ width: 4 });

    history.undo();
    expect(scene.getComponent(id, 'MeshRenderer')?.params).toMatchObject({ width: 1 });
  });

  it('applies one edit across a multi-selection', () => {
    const a = addPrimitive('Box');
    const b = addPrimitive('Sphere');
    history.execute(new SetComponentPropertyCommand(scene, [a, b], 'Material', 'color', '#00ff00'));

    expect(scene.getComponent(a, 'Material')?.color).toBe('#00ff00');
    expect(scene.getComponent(b, 'Material')?.color).toBe('#00ff00');

    history.undo();
    expect(scene.getComponent(a, 'Material')?.color).toBe('#cccccc');
  });

  it('restores a removed component at its original index', () => {
    const id = addPrimitive('Box');
    history.execute(new RemoveComponentCommand(scene, id, 'MeshRenderer'));
    expect(scene.expect(id).components.map((c) => c.type)).toEqual(['Material']);

    history.undo();
    expect(scene.expect(id).components.map((c) => c.type)).toEqual(['MeshRenderer', 'Material']);
  });
});

describe('CommandHistory', () => {
  it('drops the redo stack once a new command is executed', () => {
    const id = addPrimitive('Box');
    history.undo();
    expect(history.canRedo()).toBe(true);

    addPrimitive('Sphere');
    expect(history.canRedo()).toBe(false);
    expect(scene.has(id)).toBe(false);
  });

  it('replays a long mixed sequence back to an empty scene', () => {
    const a = addPrimitive('Box');
    const b = addPrimitive('Sphere');
    history.execute(new ReparentEntitiesCommand(scene, [b], a));
    history.execute(new SetTransformCommand(scene, new Map([[a, { position: [1, 2, 3] }]])));
    history.execute(new SetComponentPropertyCommand(scene, [a], 'Material', 'color', '#123456'));
    history.execute(new DuplicateEntitiesCommand(scene, [a]));
    history.execute(new DeleteEntitiesCommand(scene, [a]));

    while (history.canUndo()) history.undo();
    expect(scene.size).toBe(0);

    while (history.canRedo()) history.redo();
    expect(scene.size).toBe(2);
    expect(scene.getComponent(scene.rootIds()[0]!, 'Material')?.color).toBe('#123456');
  });
});
