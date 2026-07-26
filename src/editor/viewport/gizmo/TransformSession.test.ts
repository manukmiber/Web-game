import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { Scene } from '@engine/scene/Scene';
import type { Entity, EntityId, Transform, Vec3 } from '@engine/scene/types';
import { TransformSession, type WorldPoseSource } from './TransformSession';

const DEG2RAD = Math.PI / 180;

/**
 * A Scene plus the Three.js tree the render bridge would have built for it, so the session
 * sees exactly the world matrices it sees in the editor without needing a renderer.
 */
class FakeWorld implements WorldPoseSource {
  readonly scene = new Scene();
  readonly root = new THREE.Group();
  private objects = new Map<EntityId, THREE.Object3D>();

  add(id: string, transform: Partial<Transform> = {}, parentId: EntityId | null = null): Entity {
    const entity: Entity = {
      id,
      name: id,
      parentId,
      transform: {
        position: transform.position ?? [0, 0, 0],
        rotation: transform.rotation ?? [0, 0, 0],
        scale: transform.scale ?? [1, 1, 1],
      },
      components: [],
    };
    this.scene.add(entity);

    const object = new THREE.Group();
    object.position.set(...entity.transform.position);
    object.rotation.set(
      entity.transform.rotation[0] * DEG2RAD,
      entity.transform.rotation[1] * DEG2RAD,
      entity.transform.rotation[2] * DEG2RAD,
    );
    object.scale.set(...entity.transform.scale);
    (parentId ? this.objects.get(parentId)! : this.root).add(object);
    this.objects.set(id, object);
    this.root.updateMatrixWorld(true);
    return entity;
  }

  objectFor(id: EntityId): THREE.Object3D | undefined {
    return this.objects.get(id);
  }

  getOriginOffset(): Vec3 {
    return [0, 0, 0];
  }
}

const closeTo = (actual: readonly number[] | undefined, expected: number[], precision = 4) => {
  expect(actual).toBeDefined();
  for (const [index, value] of expected.entries()) {
    expect(actual![index]!).toBeCloseTo(value, precision);
  }
};

describe('TransformSession', () => {
  let world: FakeWorld;
  let session: TransformSession;

  beforeEach(() => {
    world = new FakeWorld();
    session = new TransformSession(world.scene, world);
  });

  describe('translate', () => {
    it('moves an entity by the world delta', () => {
      world.add('a', { position: [1, 2, 3] });
      session.begin(['a'], 'world');
      closeTo(session.translate(new THREE.Vector3(2, 0, -1)).get('a')!.position, [3, 2, 2]);
    });

    it('leaves rotation and scale alone', () => {
      world.add('a', { rotation: [10, 20, 30], scale: [2, 3, 4] });
      session.begin(['a'], 'world');
      const patch = session.translate(new THREE.Vector3(1, 0, 0)).get('a')!;
      expect(patch.rotation).toBeUndefined();
      expect(patch.scale).toBeUndefined();
    });

    it('expresses the delta in the parent space of a child', () => {
      world.add('parent', { rotation: [0, 90, 0] });
      world.add('child', { position: [0, 0, 0] }, 'parent');
      session.begin(['child'], 'world');
      // The parent is turned 90° about Y, which maps its local +Z onto world +X — so a world
      // +X drag has to be stored on the child as +1 along Z.
      closeTo(session.translate(new THREE.Vector3(1, 0, 0)).get('child')!.position, [0, 0, 1]);
    });

    it('moves a multi-selection rigidly', () => {
      world.add('a', { position: [0, 0, 0] });
      world.add('b', { position: [4, 0, 0] });
      session.begin(['a', 'b'], 'world');
      const patches = session.translate(new THREE.Vector3(0, 1, 0));
      closeTo(patches.get('a')!.position, [0, 1, 0]);
      closeTo(patches.get('b')!.position, [4, 1, 0]);
    });
  });

  describe('snapTranslation', () => {
    it('lands the pivot on the grid rather than rounding the delta', () => {
      world.add('a', { position: [0.3, 0, 0] });
      session.begin(['a'], 'world');
      const snapped = session.snapTranslation(new THREE.Vector3(1.4, 0, 0), [true, false, false], 1);
      // 0.3 + 1.4 = 1.7 → the pivot snaps to 2, so the delta applied is 1.7.
      expect(snapped.x).toBeCloseTo(1.7, 5);
      closeTo(session.translate(snapped).get('a')!.position, [2, 0, 0]);
    });

    it('only snaps the axes the handle allows', () => {
      world.add('a', { position: [0.3, 0.3, 0.3] });
      session.begin(['a'], 'world');
      const snapped = session.snapTranslation(
        new THREE.Vector3(1.4, 1.4, 1.4),
        [true, false, false],
        1,
      );
      expect(snapped.x).toBeCloseTo(1.7, 5);
      expect(snapped.y).toBeCloseTo(1.4, 5);
      expect(snapped.z).toBeCloseTo(1.4, 5);
    });

    it('passes the delta through when snapping is off', () => {
      world.add('a');
      session.begin(['a'], 'world');
      const delta = new THREE.Vector3(1.234, 0, 0);
      expect(session.snapTranslation(delta, [true, true, true], 0).x).toBeCloseTo(1.234, 6);
    });
  });

  describe('rotate', () => {
    it('writes a readable Euler past 90° instead of the (-180, 86, -180) branch', () => {
      world.add('a', { position: [0, 0, 0] });
      session.begin(['a'], 'world');
      const patch = session.rotate(new THREE.Vector3(0, 1, 0), 94 * DEG2RAD).get('a')!;
      closeTo(patch.rotation, [0, 94, 0], 3);
    });

    it('leaves scale alone', () => {
      world.add('a', { scale: [2, 3, 4] });
      session.begin(['a'], 'world');
      expect(session.rotate(new THREE.Vector3(0, 1, 0), 1).get('a')!.scale).toBeUndefined();
    });

    it('leaves a single object where it is', () => {
      world.add('a', { position: [5, 0, 0] });
      session.begin(['a'], 'world');
      closeTo(session.rotate(new THREE.Vector3(0, 1, 0), Math.PI / 2).get('a')!.position, [5, 0, 0]);
    });

    it('swings a multi-selection around the shared pivot', () => {
      world.add('a', { position: [-1, 0, 0] });
      world.add('b', { position: [1, 0, 0] });
      session.begin(['a', 'b'], 'world');
      // Pivot is the origin; a quarter turn about Y sends +X to -Z.
      const patches = session.rotate(new THREE.Vector3(0, 1, 0), Math.PI / 2);
      closeTo(patches.get('a')!.position, [0, 0, 1]);
      closeTo(patches.get('b')!.position, [0, 0, -1]);
    });

    it('accumulates onto the rotation the drag started from', () => {
      world.add('a', { rotation: [0, 30, 0] });
      session.begin(['a'], 'world');
      closeTo(session.rotate(new THREE.Vector3(0, 1, 0), 45 * DEG2RAD).get('a')!.rotation, [0, 75, 0], 3);
    });
  });

  describe('scale', () => {
    it('multiplies the local scale', () => {
      world.add('a', { scale: [2, 2, 2] });
      session.begin(['a'], 'local');
      closeTo(session.scale([3, 1, 1]).get('a')!.scale, [6, 2, 2]);
    });

    it('never touches rotation, even on a rotated object', () => {
      // The regression: the old gizmo built a sheared world matrix for this and let
      // decompose() absorb the shear, walking a 45° box to 42.7° just for a scale drag.
      world.add('a', { rotation: [0, 45, 0] });
      session.begin(['a'], 'local');
      const patch = session.scale([2, 1, 1]).get('a')!;
      expect(patch.rotation).toBeUndefined();
      closeTo(patch.scale, [2, 1, 1]);
      expect(world.scene.expect('a').transform.rotation).toEqual([0, 45, 0]);
    });

    it('leaves a single object in place', () => {
      world.add('a', { position: [3, 0, 0] });
      session.begin(['a'], 'local');
      expect(session.scale([2, 2, 2]).get('a')!.position).toBeUndefined();
    });

    it('spreads a multi-selection about the pivot', () => {
      world.add('a', { position: [-2, 0, 0] });
      world.add('b', { position: [2, 0, 0] });
      session.begin(['a', 'b'], 'world');
      const patches = session.scale([2, 1, 1]);
      closeTo(patches.get('a')!.position, [-4, 0, 0]);
      closeTo(patches.get('b')!.position, [4, 0, 0]);
    });
  });

  it('recomputes from the starting pose every time, so repeated calls do not drift', () => {
    world.add('a', { position: [0, 0, 0] });
    session.begin(['a'], 'world');
    for (let i = 0; i < 50; i += 1) session.translate(new THREE.Vector3(1, 0, 0));
    closeTo(session.translate(new THREE.Vector3(1, 0, 0)).get('a')!.position, [1, 0, 0]);
  });
});
