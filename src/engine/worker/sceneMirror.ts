/**
 * Mirrors structural scene changes across the worker boundary.
 *
 * Transforms get their own dedicated, dense channel (`TransformUpdate[]`, built straight from
 * `Scene.flushTransforms`'s dirty set) because they change for a large fraction of entities
 * every single tick. Everything else — an entity spawned, removed, renamed, reparented, or one
 * of its components edited — is comparatively rare, so it is carried as a small ordered log of
 * `SceneOp`s instead of a bespoke channel each. `SceneOpCollector` builds that log on the
 * worker's Scene; `applySceneOps` replays it on the host's.
 *
 * Play-mode scene mutations were never on the undo stack even when everything ran on the main
 * thread — `ScriptWorld.spawn`/`EntityHandle.destroy` already write straight through `Scene`,
 * not through a command (see ARCHITECTURE.md §6, "the scene is only half of it"). Replaying
 * worker-originated ops the same way is not a new kind of mutation, only a new thread for one
 * that already existed.
 */

import type { Scene } from '../scene/Scene';
import type { EntityId } from '../scene/types';
import type { SceneOp } from './protocol';

/**
 * Worker-side: listens to a `Scene`'s events and batches them into `SceneOp`s, one drain per
 * tick.
 *
 * `componentsChanged` is deduplicated to one op per entity per drain — a script that edits three
 * fields on the same component in one `update()` should not cost three messages, and since the
 * op carries `entity.components` *by reference* (Scene never reassigns that array, only
 * splices/pushes into it — see `Scene.addComponent`/`removeComponentAt`), the single op still
 * reflects every edit made before `drain()` is called. The clone that actually leaves the
 * thread happens once, for free, when the frame is `postMessage`d.
 */
export class SceneOpCollector {
  private pending: SceneOp[] = [];
  private componentsQueued = new Set<EntityId>();
  private unsubscribes: (() => void)[] = [];

  constructor(private readonly scene: Scene) {
    this.unsubscribes.push(
      scene.events.on('entityAdded', ({ entity }) => this.pending.push({ op: 'add', entity })),
      scene.events.on('entityRemoved', ({ id, removedIds }) =>
        this.pending.push({ op: 'remove', id, removedIds }),
      ),
      scene.events.on('entityRenamed', ({ id, name }) =>
        this.pending.push({ op: 'rename', id, name }),
      ),
      scene.events.on('entityReparented', ({ id, parentId }) =>
        this.pending.push({ op: 'reparent', id, parentId }),
      ),
      scene.events.on('componentsChanged', ({ id }) => {
        if (this.componentsQueued.has(id)) return;
        const entity = this.scene.get(id);
        if (!entity) return;
        this.componentsQueued.add(id);
        this.pending.push({ op: 'components', id, components: entity.components });
      }),
      scene.events.on('assetsChanged', () => {
        for (const asset of this.scene.listAssets()) this.pending.push({ op: 'asset', asset });
      }),
    );
  }

  /** Everything queued since the last call, in emission order. Clears the queue. */
  drain(): SceneOp[] {
    if (this.pending.length === 0) return [];
    const ops = this.pending;
    this.pending = [];
    this.componentsQueued.clear();
    return ops;
  }

  dispose(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
    this.pending = [];
    this.componentsQueued.clear();
  }
}

/**
 * Host-side: replays a worker's `SceneOp` log directly against its `Scene` — the same "write
 * straight through" path Play mode already uses on the main thread.
 *
 * Each op is applied inside its own `try`/`catch`. Ops already arrived through
 * `protocol.parseWorkerMessage`, which checks their *shape*; it cannot check that a `reparent`
 * doesn't create a cycle or that an `add`'s parent still exists on this particular host (a
 * worker restarted mid-session, or a message applied out of order, can produce exactly that
 * mismatch). One bad op must not stop the rest of the batch from applying, and it certainly must
 * not throw out of a `System.update` and take the whole frame down with it.
 */
export function applySceneOps(scene: Scene, ops: readonly SceneOp[]): void {
  for (const op of ops) {
    try {
      applyOne(scene, op);
    } catch (error) {
      console.warn('[SimulationWorker] dropped a scene op it could not apply:', op.op, error);
    }
  }
}

function applyOne(scene: Scene, op: SceneOp): void {
  switch (op.op) {
    case 'add': {
      if (scene.has(op.entity.id)) return;
      const parentId = op.entity.parentId;
      // A parent the host does not have (should not happen — see the doc comment above) would
      // otherwise throw inside `Scene.add` and lose the whole batch; promoting to root keeps the
      // entity rather than dropping data, the same call `Scene.load` makes for an orphan.
      const safe = parentId !== null && !scene.has(parentId) ? { ...op.entity, parentId: null } : op.entity;
      scene.add(safe);
      return;
    }
    case 'remove':
      if (scene.has(op.id)) scene.remove(op.id);
      return;
    case 'rename':
      if (scene.has(op.id)) scene.rename(op.id, op.name);
      return;
    case 'reparent':
      if (scene.has(op.id) && (op.parentId === null || scene.has(op.parentId))) {
        scene.reparent(op.id, op.parentId);
      }
      return;
    case 'components': {
      const entity = scene.get(op.id);
      if (!entity) return;
      entity.components = op.components;
      scene.touchComponents(op.id);
      return;
    }
    case 'asset':
      scene.addAsset(op.asset);
      return;
  }
}
