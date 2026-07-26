import * as THREE from 'three';
import type { RenderBridge } from '@engine/render/RenderBridge';
import type { Scene } from '@engine/scene/Scene';
import type { EntityId, Transform } from '@engine/scene/types';
import type { CommandHistory } from '../commands/Command';
import { SetTransformCommand } from '../commands/sceneCommands';
import { editorState, type TransformSpace, type TransformTool } from '../state/editorStore';
import { GizmoHandles, HANDLE_AXES, type GizmoMode, type HandleId } from './gizmo/GizmoHandles';
import { TransformSession } from './gizmo/TransformSession';
import {
  closestPointOnLine,
  DEG2RAD,
  intersectPlane,
  RAD2DEG,
  signedAngle,
  snap,
  unwrapAngle,
} from './gizmo/transformMath';

/** Below this the scale handle's reference length is too short to divide by safely. */
const MIN_SCALE_REFERENCE = 1e-4;
/** Scale never crosses zero: a negative scale renders the mesh inside out. */
const MIN_SCALE_FACTOR = 1e-3;

interface Drag {
  pointerId: number;
  handle: HandleId;
  mode: GizmoMode;
  /** World-space axis for single-axis translate/scale and for rotate. */
  axis: THREE.Vector3;
  /** World-space plane the pointer is tracked on. */
  planeNormal: THREE.Vector3;
  grabPoint: THREE.Vector3;
  /** Rotate: running unwrapped angle, so a ring can be spun past 180° and round again. */
  angle: number;
  /** Scale: distance from the pivot at grab time, the denominator of the factor. */
  reference: number;
  changed: boolean;
}

/**
 * Drives the transform gizmo.
 *
 * The two jobs that were previously delegated to `TransformControls` and went wrong are done
 * here explicitly:
 *
 * 1. **Claiming the pointer.** The grab is detected in a capture-phase listener on `window`,
 *    so it runs before the canvas's own listeners and can stop the event reaching the orbit
 *    controls. Previously the camera was suspended a frame later from inside the render loop,
 *    which left the first pointer moves of every drag orbiting the camera *and* dragging the
 *    handle at once — the object went somewhere neither the pointer nor the user intended.
 *
 * 2. **Deciding what a drag means.** Each mode writes only its own channel through
 *    `TransformSession`, instead of composing a world matrix and decomposing it back into
 *    position/rotation/scale. See that file for what the round trip used to cost.
 *
 * The gizmo never writes to the Scene directly — it issues SetTransformCommands, which merge
 * into one undo entry per drag.
 */
export class GizmoController {
  private readonly handles = new GizmoHandles();
  private readonly session: TransformSession;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();

  private selection: EntityId[] = [];
  private tool: TransformTool = 'move';
  private space: TransformSpace = 'world';
  private snapping = { enabled: false, move: 1, rotate: 15, scale: 0.1 };
  private drag: Drag | null = null;
  private hovered: HandleId | null = null;

  /** Pivot pose, kept between drags so the handles stay put while the pointer moves. */
  private readonly pivotPosition = new THREE.Vector3();
  private readonly pivotQuaternion = new THREE.Quaternion();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
    private readonly scene: Scene,
    private readonly bridge: RenderBridge,
    private readonly history: CommandHistory,
    overlay: THREE.Scene,
  ) {
    this.session = new TransformSession(scene, bridge);
    overlay.add(this.handles.root);

    // Capture phase on window: this runs before anything listening on the canvas, which is
    // what lets a grab take the pointer away from the orbit controls in the same event rather
    // than a frame later.
    window.addEventListener('pointerdown', this.onPointerDown, true);
    window.addEventListener('pointermove', this.onPointerMove, true);
    window.addEventListener('pointerup', this.onPointerUp, true);
    window.addEventListener('keydown', this.onKeyDown, true);
  }

  /** True while a handle is held — the viewport uses this to suspend orbit controls. */
  get isDragging(): boolean {
    return this.drag !== null;
  }

  setTool(tool: TransformTool): void {
    if (tool === this.tool) return;
    this.tool = tool;
    if (tool !== 'select') this.handles.setMode(toGizmoMode(tool));
    // Handle ids are shared across modes, so a stale hover would light up the new mode's
    // handle of the same name under a pointer that is nowhere near it.
    this.setHovered(null);
    this.refreshVisibility();
    // Switching to or from Scale changes which frame the handles point along.
    this.syncPivot();
  }

  setSpace(space: TransformSpace): void {
    this.space = space;
    this.syncPivot();
  }

  setSnapping(enabled: boolean, move: number, rotate: number, scale: number): void {
    this.snapping = { enabled, move, rotate, scale };
  }

  setSelection(ids: EntityId[]): void {
    // Only the top-most selected entities move; a selected child of a selected parent would
    // otherwise receive the transform twice, once directly and once through its parent.
    this.selection = ids.filter(
      (id) => !ids.some((other) => other !== id && this.scene.isDescendantOf(id, other)),
    );
    this.refreshVisibility();
    this.syncPivot();
  }

  /** Repositions the gizmo onto the selection. Called on selection or transform change. */
  syncPivot(): void {
    if (this.drag || this.selection.length === 0) return;

    const centre = _v1.set(0, 0, 0);
    let counted = 0;
    for (const id of this.selection) {
      const object = this.bridge.objectFor(id);
      if (!object) continue;
      object.updateMatrixWorld(true);
      centre.add(object.getWorldPosition(_v2));
      counted += 1;
    }
    if (counted === 0) return;

    this.pivotPosition.copy(centre.divideScalar(counted));
    this.pivotQuaternion.identity();
    if (this.pivotSpace() === 'local') {
      const first = this.bridge.objectFor(this.selection[0]!);
      if (first) first.getWorldQuaternion(this.pivotQuaternion);
    }
  }

  /**
   * Scale is always oriented to the object, whatever the Global/Local toggle says — the same
   * rule Unity applies.
   *
   * Scale is stored per object along its own axes, so a world-axis handle on a rotated object
   * is asking for a shear the format cannot hold. Rather than silently approximating it, the
   * handles are pointed at the axes that *can* be scaled exactly, and the toggle keeps its
   * meaning for move and rotate where world axes are perfectly representable.
   */
  private pivotSpace(): TransformSpace {
    return this.tool === 'scale' ? 'local' : this.space;
  }

  /** Per-frame: keeps the gizmo a constant size on screen and faces the view-aligned ring. */
  update(): void {
    if (!this.handles.visible) return;
    this.handles.update(this.camera, this.canvas.clientHeight, this.pivotPosition, this.pivotQuaternion);
    this.handles.faceCamera(this.camera);
  }

  dispose(): void {
    window.removeEventListener('pointerdown', this.onPointerDown, true);
    window.removeEventListener('pointermove', this.onPointerMove, true);
    window.removeEventListener('pointerup', this.onPointerUp, true);
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.handles.dispose();
  }

  private refreshVisibility(): void {
    this.handles.setVisible(this.selection.length > 0 && this.tool !== 'select');
  }

  // ------------------------------------------------------------------ input

  private onPointerDown = (event: PointerEvent): void => {
    if (event.target !== this.canvas || event.button !== 0) return;
    if (!this.handles.visible || this.drag) return;

    this.updateRay(event);
    const handle = this.handles.pick(this.raycaster);
    if (!handle) return;

    // Ours: the orbit controls and the click-to-select handler both listen on the canvas and
    // neither should see this pointer.
    event.stopPropagation();
    event.preventDefault();
    this.beginDrag(handle, event);
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.drag) {
      if (event.pointerId !== this.drag.pointerId) return;
      event.stopPropagation();
      this.updateRay(event);
      this.applyDrag();
      return;
    }

    if (event.target !== this.canvas || !this.handles.visible) {
      this.setHovered(null);
      return;
    }
    this.updateRay(event);
    this.setHovered(this.handles.pick(this.raycaster));
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    event.stopPropagation();
    this.endDrag();
  };

  /** Escape aborts a drag and puts everything back, the way Blender's does. */
  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.drag || event.key !== 'Escape') return;
    event.stopPropagation();
    event.preventDefault();
    this.cancelDrag();
  };

  private updateRay(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private setHovered(handle: HandleId | null): void {
    if (handle === this.hovered) return;
    this.hovered = handle;
    this.handles.highlight(handle);
    // A grabbable handle deserves the cursor that says so.
    this.canvas.style.cursor = handle ? 'grab' : '';
  }

  // ------------------------------------------------------------------- drag

  private beginDrag(handle: HandleId, event: PointerEvent): void {
    const mode = this.handles.getMode();
    this.session.begin(this.selection, this.pivotSpace());
    if (this.session.isEmpty) return;

    const axis = this.axisFor(handle, mode);
    const planeNormal = this.planeFor(handle, mode, axis);
    const grabPoint = new THREE.Vector3();
    if (!this.projectPointer(handle, mode, axis, planeNormal, grabPoint)) {
      this.session.end();
      return;
    }

    this.drag = {
      pointerId: event.pointerId,
      handle,
      mode,
      axis,
      planeNormal,
      grabPoint,
      angle: 0,
      reference:
        mode === 'scale'
          ? this.scaleReference(handle, axis, grabPoint)
          : 0,
      changed: false,
    };

    if (mode === 'scale' && Math.abs(this.drag.reference) < MIN_SCALE_REFERENCE) {
      // Grabbed effectively on top of the pivot: there is no length to scale relative to.
      this.drag = null;
      this.session.end();
      return;
    }

    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.style.cursor = 'grabbing';
    this.handles.highlight(handle);
    if (mode !== 'rotate' && isAxisHandle(handle)) this.handles.setAxisLine(localAxis(handle));
    // The drag is one user action, however long it takes and however sparse the events.
    this.history.beginInteraction();
    editorState().setDragReadout(mode === 'scale' ? 'Scale  1×' : 'Move  X 0  Y 0  Z 0');
  }

  private applyDrag(): void {
    const drag = this.drag;
    if (!drag) return;

    const patches =
      drag.mode === 'translate'
        ? this.translatePatches(drag)
        : drag.mode === 'rotate'
          ? this.rotatePatches(drag)
          : this.scalePatches(drag);
    if (!patches) return;

    drag.changed = true;
    this.history.execute(new SetTransformCommand(this.scene, patches));
  }

  private translatePatches(drag: Drag): Map<EntityId, Partial<Transform>> | null {
    const point = _v3;
    if (!this.projectPointer(drag.handle, drag.mode, drag.axis, drag.planeNormal, point)) {
      return null;
    }
    const delta = this.session.snapTranslation(
      point.sub(drag.grabPoint),
      HANDLE_AXES[drag.handle],
      this.snapping.enabled ? this.snapping.move : 0,
      _v5,
    );
    editorState().setDragReadout(
      `Move  X ${formatNumber(delta.x)}  Y ${formatNumber(delta.y)}  Z ${formatNumber(delta.z)}`,
    );
    return this.session.translate(delta);
  }

  private rotatePatches(drag: Drag): Map<EntityId, Partial<Transform>> | null {
    const point = _v3;
    if (!intersectPlane(this.raycaster.ray, this.pivotPosition, drag.planeNormal, point)) {
      return null;
    }
    const from = _v4.copy(drag.grabPoint).sub(this.pivotPosition);
    const to = point.sub(this.pivotPosition);
    if (from.lengthSq() < 1e-8 || to.lengthSq() < 1e-8) return null;

    drag.angle = unwrapAngle(signedAngle(from, to, drag.axis), drag.angle);
    const increment = this.snapping.enabled ? this.snapping.rotate * DEG2RAD : 0;
    const angle = snap(drag.angle, increment);

    editorState().setDragReadout(`Rotate ${formatNumber(angle * RAD2DEG)}°`);
    return this.session.rotate(drag.axis, angle);
  }

  private scalePatches(drag: Drag): Map<EntityId, Partial<Transform>> | null {
    let ratio: number;
    if (drag.handle === 'xyz') {
      ratio = this.screenDistanceToPivot() / drag.reference;
    } else {
      const point = _v3;
      if (!closestPointOnLine(this.raycaster.ray, this.pivotPosition, drag.axis, point)) {
        return null;
      }
      ratio = point.sub(this.pivotPosition).dot(drag.axis) / drag.reference;
    }

    const increment = this.snapping.enabled ? this.snapping.scale : 0;
    const factor = Math.max(snap(ratio, increment), MIN_SCALE_FACTOR);
    const factors = HANDLE_AXES[drag.handle].map((active) => (active ? factor : 1)) as [
      number,
      number,
      number,
    ];

    editorState().setDragReadout(`Scale  ${factors.map((f) => `${formatNumber(f)}×`).join('  ')}`);
    return this.session.scale(factors);
  }

  private endDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.finishDrag(drag);
  }

  private cancelDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    // The whole drag merged into a single history entry, so one undo restores the start pose.
    const changed = drag.changed;
    this.finishDrag(drag);
    if (changed) this.history.undo();
  }

  private finishDrag(drag: Drag): void {
    this.drag = null;
    this.history.endInteraction();
    this.session.end();
    this.handles.setAxisLine(null);
    this.handles.highlight(this.hovered);
    editorState().setDragReadout(null);
    if (this.canvas.hasPointerCapture(drag.pointerId)) {
      this.canvas.releasePointerCapture(drag.pointerId);
    }
    this.canvas.style.cursor = this.hovered ? 'grab' : '';
    this.syncPivot();
  }

  // ------------------------------------------------------------------ frames

  /** World-space direction of a handle's axis, in the gizmo's current frame. */
  private axisFor(handle: HandleId, mode: GizmoMode): THREE.Vector3 {
    if (handle === 'screen' && mode === 'rotate') {
      // Spinning about the view direction, which is the only usable ring when every axis
      // points nearly at the camera.
      return this.camera.getWorldDirection(new THREE.Vector3()).normalize();
    }
    const axis = localAxis(handle);
    return axis.applyQuaternion(this.pivotQuaternion).normalize();
  }

  /** The plane a pointer is tracked on for a given handle. */
  private planeFor(handle: HandleId, mode: GizmoMode, axis: THREE.Vector3): THREE.Vector3 {
    if (mode === 'rotate') return axis.clone();
    if (handle === 'screen' || handle === 'xyz') {
      return this.camera.getWorldDirection(new THREE.Vector3()).negate();
    }
    if (isAxisHandle(handle)) {
      // Axis drags project onto the line, so the plane is unused; kept meaningful anyway.
      return axis.clone();
    }
    // A plane handle's normal is the axis it is *not* aligned with.
    const missing = HANDLE_AXES[handle].findIndex((active) => !active);
    return new THREE.Vector3(missing === 0 ? 1 : 0, missing === 1 ? 1 : 0, missing === 2 ? 1 : 0)
      .applyQuaternion(this.pivotQuaternion)
      .normalize();
  }

  /**
   * Where the pointer is, in the space the handle constrains it to: a point on the axis line
   * for single-axis handles, a point on the plane for everything else.
   */
  private projectPointer(
    handle: HandleId,
    mode: GizmoMode,
    axis: THREE.Vector3,
    planeNormal: THREE.Vector3,
    target: THREE.Vector3,
  ): boolean {
    if (mode !== 'rotate' && isAxisHandle(handle)) {
      return closestPointOnLine(this.raycaster.ray, this.pivotPosition, axis, target) !== null;
    }
    return intersectPlane(this.raycaster.ray, this.pivotPosition, planeNormal, target) !== null;
  }

  private scaleReference(handle: HandleId, axis: THREE.Vector3, grabPoint: THREE.Vector3): number {
    if (handle === 'xyz') return this.screenDistanceToPivot();
    return _v4.copy(grabPoint).sub(this.pivotPosition).dot(axis);
  }

  /** Pointer distance from the pivot in normalised screen space — drives uniform scale. */
  private screenDistanceToPivot(): number {
    const projected = _v4.copy(this.pivotPosition).project(this.camera);
    return Math.max(
      Math.hypot(this.pointer.x - projected.x, this.pointer.y - projected.y),
      MIN_SCALE_REFERENCE,
    );
  }
}

function toGizmoMode(tool: TransformTool): GizmoMode {
  if (tool === 'rotate') return 'rotate';
  if (tool === 'scale') return 'scale';
  return 'translate';
}

function isAxisHandle(handle: HandleId): boolean {
  return handle === 'x' || handle === 'y' || handle === 'z';
}

function localAxis(handle: HandleId): THREE.Vector3 {
  if (handle === 'x') return new THREE.Vector3(1, 0, 0);
  if (handle === 'y') return new THREE.Vector3(0, 1, 0);
  if (handle === 'z') return new THREE.Vector3(0, 0, 1);
  return new THREE.Vector3(0, 0, 1);
}

function formatNumber(value: number): string {
  return (Math.abs(value) < 1e-4 ? 0 : value).toFixed(2).replace(/\.00$/, '');
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
