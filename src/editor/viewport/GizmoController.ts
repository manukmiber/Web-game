import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { RenderBridge } from '@engine/render/RenderBridge';
import type { Scene } from '@engine/scene/Scene';
import type { EntityId, Transform } from '@engine/scene/types';
import type { CommandHistory } from '../commands/Command';
import { SetTransformCommand } from '../commands/sceneCommands';
import { editorState, type TransformSpace, type TransformTool } from '../state/editorStore';

const RAD2DEG = 180 / Math.PI;

interface DragRecord {
  id: EntityId;
  /** World matrix at drag start, used to compute the entity's new pose from the pivot delta. */
  startWorld: THREE.Matrix4;
}

/**
 * Drives the transform gizmo.
 *
 * Everything is driven through a single **pivot** object that the gizmo attaches to, rather
 * than attaching the gizmo directly to the selected mesh. The reason is multi-select: with a
 * pivot, moving five objects is one rigid transform applied to five recorded start poses,
 * and the single-selection case falls out of the same code path with no special casing.
 *
 * The gizmo never writes to the Scene directly — it issues SetTransformCommands, which merge
 * into one undo entry per drag (see CommandHistory's merge window).
 */
export class GizmoController {
  readonly controls: TransformControls;
  private readonly pivot = new THREE.Object3D();
  private pivotStartWorldInverse = new THREE.Matrix4();
  private records: DragRecord[] = [];
  private dragging = false;
  private selection: EntityId[] = [];

  constructor(
    camera: THREE.Camera,
    domElement: HTMLElement,
    private readonly scene: Scene,
    private readonly bridge: RenderBridge,
    private readonly history: CommandHistory,
    private readonly overlay: THREE.Scene,
  ) {
    this.controls = new TransformControls(camera, domElement);
    this.pivot.name = 'GizmoPivot';
    this.overlay.add(this.pivot);
    this.overlay.add(this.controls.getHelper());
    // Visibility of the gizmo helper is controlled by attach/detach in this Three version,
    // so "no selection" and "Select tool" are both expressed as a detached pivot.
    this.controls.detach();
    this.controls.enabled = false;

    this.controls.addEventListener('dragging-changed', (event) => {
      if (event.value) this.beginDrag();
      else this.endDrag();
    });
    this.controls.addEventListener('objectChange', () => this.applyDrag());
  }

  /** True while a gizmo handle is held — the viewport uses this to suspend orbit controls. */
  get isDragging(): boolean {
    return this.dragging;
  }

  setTool(tool: TransformTool): void {
    if (tool === 'select') {
      this.controls.enabled = false;
      this.controls.detach();
      return;
    }
    this.controls.setMode(tool === 'move' ? 'translate' : tool);
    this.setActive(this.selection.length > 0);
  }

  setSpace(space: TransformSpace): void {
    this.controls.setSpace(space);
    this.syncPivot();
  }

  /**
   * Draws the handles bigger, for pointers that cannot hit small ones.
   *
   * `size` scales the picker geometry along with the visible arrows, which is the point — the
   * gizmo has to be *hittable*, not merely visible. On a phone at the default size the translate
   * arrows are thinner than the contact patch of a fingertip, so a drag meant for the X arrow
   * landed on the free-move handle in the middle and the object slid across the ground plane
   * instead of along the axis.
   */
  setHandleScale(scale: number): void {
    this.controls.size = scale;
  }

  setSnapping(enabled: boolean, move: number, rotate: number, scale: number): void {
    this.controls.setTranslationSnap(enabled ? move : null);
    this.controls.setRotationSnap(enabled ? rotate * (Math.PI / 180) : null);
    this.controls.setScaleSnap(enabled ? scale : null);
  }

  setSelection(ids: EntityId[]): void {
    // Only the top-most selected entities move; a selected child of a selected parent would
    // otherwise receive the transform twice.
    this.selection = ids.filter(
      (id) => !ids.some((other) => other !== id && this.scene.isDescendantOf(id, other)),
    );
    this.setActive(this.selection.length > 0 && editorState().tool !== 'select');
    this.syncPivot();
  }

  private setActive(active: boolean): void {
    this.controls.enabled = active;
    if (active) this.controls.attach(this.pivot);
    else this.controls.detach();
  }

  /** Repositions the pivot to the selection centre. Called on selection or transform change. */
  syncPivot(): void {
    if (this.selection.length === 0 || this.dragging) return;

    const centre = new THREE.Vector3();
    let counted = 0;
    for (const id of this.selection) {
      const object = this.bridge.objectFor(id);
      if (!object) continue;
      centre.add(object.getWorldPosition(new THREE.Vector3()));
      counted += 1;
    }
    if (counted === 0) return;
    centre.divideScalar(counted);

    this.pivot.position.copy(centre);
    // In local space the gizmo takes the first selected object's orientation, matching Unity
    // when several objects are selected.
    const first = this.bridge.objectFor(this.selection[0]!);
    if (this.controls.space === 'local' && first) {
      this.pivot.quaternion.copy(first.getWorldQuaternion(new THREE.Quaternion()));
    } else {
      this.pivot.quaternion.identity();
    }
    this.pivot.scale.set(1, 1, 1);
    this.pivot.updateMatrixWorld(true);
  }

  dispose(): void {
    this.controls.detach();
    this.controls.getHelper().removeFromParent();
    this.controls.dispose();
    this.pivot.removeFromParent();
  }

  // ------------------------------------------------------------------ drag

  private beginDrag(): void {
    this.dragging = true;
    // The drag is one user action, however long it takes and however sparse the events.
    this.history.beginInteraction();
    this.pivot.updateMatrixWorld(true);
    this.pivotStartWorldInverse = this.pivot.matrixWorld.clone().invert();
    this.records = [];
    for (const id of this.selection) {
      const object = this.bridge.objectFor(id);
      if (!object) continue;
      object.updateMatrixWorld(true);
      this.records.push({ id, startWorld: object.matrixWorld.clone() });
    }
  }

  private applyDrag(): void {
    if (!this.dragging || this.records.length === 0) return;

    this.pivot.updateMatrixWorld(true);
    // delta = how the pivot has moved since the drag started, in world space.
    const delta = this.pivot.matrixWorld.clone().multiply(this.pivotStartWorldInverse);

    const next = new Map<EntityId, Partial<Transform>>();
    for (const record of this.records) {
      const entity = this.scene.get(record.id);
      const object = this.bridge.objectFor(record.id);
      if (!entity || !object) continue;

      const nextWorld = delta.clone().multiply(record.startWorld);
      next.set(record.id, this.worldToLocalTransform(nextWorld, entity.parentId));
    }
    if (next.size > 0) this.history.execute(new SetTransformCommand(this.scene, next));
  }

  private endDrag(): void {
    this.dragging = false;
    this.history.endInteraction();
    this.records = [];
    this.syncPivot();
  }

  /**
   * Converts a world matrix into the local transform the Scene stores, undoing the parent's
   * world matrix and — for root entities — the render bridge's origin offset (§9.1).
   */
  private worldToLocalTransform(world: THREE.Matrix4, parentId: EntityId | null): Transform {
    const local = world.clone();
    if (parentId) {
      const parent = this.bridge.objectFor(parentId);
      if (parent) {
        parent.updateMatrixWorld(true);
        local.premultiply(parent.matrixWorld.clone().invert());
      }
    }

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    local.decompose(position, quaternion, scale);

    if (!parentId) {
      const offset = this.bridge.getOriginOffset();
      position.set(position.x + offset[0], position.y + offset[1], position.z + offset[2]);
    }

    // Scene stores Euler degrees in XYZ order, which is Three's default.
    const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');
    return {
      position: [round(position.x), round(position.y), round(position.z)],
      rotation: [round(euler.x * RAD2DEG), round(euler.y * RAD2DEG), round(euler.z * RAD2DEG)],
      scale: [round(scale.x), round(scale.y), round(scale.z)],
    };
  }
}

/**
 * Trims float noise from matrix decomposition so the Inspector shows "1" rather than
 * "0.9999999999999998", and snapped values land exactly on the snap increment.
 */
function round(value: number): number {
  return Math.abs(value) < 1e-9 ? 0 : Number(value.toFixed(5));
}
