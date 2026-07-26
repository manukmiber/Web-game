import * as THREE from 'three';
import type { EntityId, Transform, Vec3 } from '@engine/scene/types';
import type { Scene } from '@engine/scene/Scene';
import {
  eulerDegreesNear,
  scaleFactorsForFrame,
  snap,
  tidy,
  tidyVec,
} from './transformMath';

/**
 * What the session needs from the render bridge. Narrowed to an interface so the drag rules
 * can be tested against a handful of plain objects instead of a live WebGL scene.
 */
export interface WorldPoseSource {
  objectFor(id: EntityId): THREE.Object3D | undefined;
  getOriginOffset(): Vec3;
}

export type TransformSpace = 'local' | 'world';

interface PoseRecord {
  id: EntityId;
  /** Local transform as the Scene stored it when the drag began. */
  start: Transform;
  worldPosition: THREE.Vector3;
  worldQuaternion: THREE.Quaternion;
  /** World → parent space, for writing a world result back as a local transform. */
  parentWorldInverse: THREE.Matrix4;
  parentQuaternionInverse: THREE.Quaternion;
  isRoot: boolean;
}

/**
 * Applies one gizmo drag to every selected entity.
 *
 * The poses are captured once when the drag starts and every subsequent pointer move is
 * computed from *those*, never from the entity's current state. Accumulating instead —
 * applying each frame's delta on top of the last frame's result — is how a drag picks up
 * rounding drift and how a rotation slowly walks its scale away from 1.
 *
 * Each mode writes only the channel it owns. Moving never touches rotation, scaling never
 * touches rotation or position for a single object, and rotating never touches scale. The
 * gizmo this replaced expressed all three as one world matrix per entity and decomposed it
 * back, which meant every drag rewrote all nine numbers and any operation the format could
 * not represent — a shear, most commonly — silently leaked into the other channels.
 */
export class TransformSession {
  private records: PoseRecord[] = [];
  /** Pivot pose at drag start: the point rotations and scales are applied about. */
  readonly pivotPosition = new THREE.Vector3();
  readonly pivotQuaternion = new THREE.Quaternion();

  constructor(
    private readonly scene: Scene,
    private readonly world: WorldPoseSource,
  ) {}

  get isEmpty(): boolean {
    return this.records.length === 0;
  }

  get entityIds(): EntityId[] {
    return this.records.map((record) => record.id);
  }

  /**
   * Captures the starting pose of each entity and the pivot they share.
   *
   * `ids` must already be filtered to top-most entities — a selected child of a selected
   * parent would otherwise receive the transform twice, once directly and once through its
   * parent's matrix.
   */
  begin(ids: readonly EntityId[], space: TransformSpace): void {
    this.records = [];
    const centre = new THREE.Vector3();

    for (const id of ids) {
      const entity = this.scene.get(id);
      const object = this.world.objectFor(id);
      if (!entity || !object) continue;
      object.updateMatrixWorld(true);

      const parentWorldInverse = new THREE.Matrix4();
      const parentQuaternionInverse = new THREE.Quaternion();
      if (object.parent) {
        object.parent.updateMatrixWorld(true);
        parentWorldInverse.copy(object.parent.matrixWorld).invert();
        object.parent.getWorldQuaternion(parentQuaternionInverse);
        parentQuaternionInverse.invert();
      }

      const record: PoseRecord = {
        id,
        start: {
          position: [...entity.transform.position],
          rotation: [...entity.transform.rotation],
          scale: [...entity.transform.scale],
        },
        worldPosition: object.getWorldPosition(new THREE.Vector3()),
        worldQuaternion: object.getWorldQuaternion(new THREE.Quaternion()),
        parentWorldInverse,
        parentQuaternionInverse,
        isRoot: entity.parentId === null,
      };
      this.records.push(record);
      centre.add(record.worldPosition);
    }

    if (this.records.length > 0) centre.divideScalar(this.records.length);
    this.pivotPosition.copy(centre);
    // In local space the gizmo takes the first selected entity's orientation, which is what
    // Unity and Blender both do with several objects selected.
    this.pivotQuaternion.identity();
    if (space === 'local' && this.records[0]) {
      this.pivotQuaternion.copy(this.records[0].worldQuaternion);
    }
  }

  end(): void {
    this.records = [];
  }

  // -------------------------------------------------------------- operations

  /**
   * Quantises a translation onto the grid, in the gizmo's own frame.
   *
   * `activeAxes` marks which of the gizmo's axes the handle allows. Snapping lands the *pivot*
   * on the grid rather than rounding the delta: dragging the world X arrow with a 1 m grid
   * puts the object on whole metres, whereas rounding the delta would leave it wherever it
   * already was plus a whole number, which is not what a grid is for. In local space the same
   * rule snaps along the object's own axes from its own origin.
   *
   * Separate from `translate` so the caller can show the user the distance that will actually
   * be applied, not the raw one the pointer asked for.
   */
  snapTranslation(
    worldDelta: THREE.Vector3,
    activeAxes: readonly [boolean, boolean, boolean],
    increment: number,
    target = new THREE.Vector3(),
  ): THREE.Vector3 {
    target.copy(worldDelta);
    if (!(increment > 0)) return target;

    const inverse = _q1.copy(this.pivotQuaternion).invert();
    const localStart = _v2.copy(this.pivotPosition).applyQuaternion(inverse);
    const localDelta = _v3.copy(target).applyQuaternion(inverse);
    for (let axis = 0; axis < 3; axis += 1) {
      if (!activeAxes[axis]) continue;
      const start = localStart.getComponent(axis);
      localDelta.setComponent(axis, snap(start + localDelta.getComponent(axis), increment) - start);
    }
    return target.copy(localDelta).applyQuaternion(this.pivotQuaternion);
  }

  /** Rigid translation of the whole selection by a world-space delta. */
  translate(worldDelta: THREE.Vector3): Map<EntityId, Partial<Transform>> {
    const out = new Map<EntityId, Partial<Transform>>();
    for (const record of this.records) {
      const world = _v4.copy(record.worldPosition).add(worldDelta);
      out.set(record.id, { position: this.toLocalPosition(world, record) });
    }
    return out;
  }

  /**
   * Rotation of `angle` radians about a world axis through the pivot.
   *
   * Position moves too, because rotating a multi-selection has to swing the objects around the
   * shared pivot; for a single object the pivot *is* its origin, so the position comes back
   * unchanged.
   */
  rotate(
    worldAxis: THREE.Vector3,
    angle: number,
  ): Map<EntityId, Partial<Transform>> {
    const rotation = _q1.setFromAxisAngle(worldAxis, angle);
    const out = new Map<EntityId, Partial<Transform>>();

    for (const record of this.records) {
      const world = _v1
        .copy(record.worldPosition)
        .sub(this.pivotPosition)
        .applyQuaternion(rotation)
        .add(this.pivotPosition);

      const worldQuaternion = _q2.copy(rotation).multiply(record.worldQuaternion);
      const localQuaternion = _q3
        .copy(record.parentQuaternionInverse)
        .multiply(worldQuaternion);

      out.set(record.id, {
        position: this.toLocalPosition(world, record),
        // Continuity against the pose the drag started from, so the numbers stay readable and
        // the next frame of the same drag carries on from the same Euler branch.
        rotation: tidyVec(eulerDegreesNear(localQuaternion, record.start.rotation)),
      });
    }
    return out;
  }

  /**
   * Scale by a per-axis factor expressed in the gizmo's frame.
   *
   * Local scale is multiplied rather than a world matrix being rebuilt, so rotation is
   * mathematically untouchable here — the channel is simply never written.
   */
  scale(factors: Vec3): Map<EntityId, Partial<Transform>> {
    const out = new Map<EntityId, Partial<Transform>>();

    for (const record of this.records) {
      const local = scaleFactorsForFrame(factors, this.pivotQuaternion, record.worldQuaternion);
      const patch: Partial<Transform> = {
        scale: [
          tidy(record.start.scale[0] * local[0]),
          tidy(record.start.scale[1] * local[1]),
          tidy(record.start.scale[2] * local[2]),
        ],
      };

      // A selection of several objects also spreads apart, in the gizmo's frame, so scaling a
      // group behaves like scaling one object made of them.
      if (this.records.length > 1) {
        const offset = _v1.copy(record.worldPosition).sub(this.pivotPosition);
        const inverse = _q1.copy(this.pivotQuaternion).invert();
        offset.applyQuaternion(inverse);
        offset.set(offset.x * factors[0], offset.y * factors[1], offset.z * factors[2]);
        offset.applyQuaternion(this.pivotQuaternion).add(this.pivotPosition);
        patch.position = this.toLocalPosition(offset, record);
      }

      out.set(record.id, patch);
    }
    return out;
  }

  // ----------------------------------------------------------------- helpers

  /**
   * World point → the local position the Scene stores, undoing the parent's world matrix and,
   * for root entities, the render bridge's origin offset (ARCHITECTURE.md §9.1).
   */
  private toLocalPosition(world: THREE.Vector3, record: PoseRecord): Vec3 {
    const local = _v5.copy(world).applyMatrix4(record.parentWorldInverse);
    if (record.isRoot) {
      const offset = this.world.getOriginOffset();
      local.set(local.x + offset[0], local.y + offset[1], local.z + offset[2]);
    }
    return tidyVec(local);
  }
}

// Scratch, reused across every entity of every pointer move — see transformMath.ts.
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
