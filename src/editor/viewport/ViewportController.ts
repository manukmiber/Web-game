import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { findPrimaryCamera } from '@engine/components/Camera';
import type { Engine } from '@engine/loop/Engine';
import type { RenderBridge } from '@engine/render/RenderBridge';
import { RenderHost } from '@engine/render/RenderHost';
import {
  CITY_PRESET,
  FOREST_PRESET,
  StressScene,
  type StressParams,
} from '@engine/perf/StressScene';
import type { EntityId } from '@engine/scene/types';
import type { CommandHistory } from '../commands/Command';
import { isTextEntry } from '../dom';
import { editorState, useEditorStore } from '../state/editorStore';
import { GizmoController } from './GizmoController';
import { GroundGrid } from './GroundGrid';
import { SceneGizmos } from './SceneGizmos';
import { SelectionOutline } from './SelectionOutline';

const AXIS_INDICATOR_PX = 96;
/** Pointer travel beyond this is treated as an orbit drag, not a click-to-select. */
const CLICK_SLOP_PX = 4;

/**
 * The editor's viewport: a RenderHost plus the tools that only the editor has.
 *
 * Rendering itself lives in `engine/render/RenderHost` so the game runtime draws through the
 * exact same path. What remains here is everything a runtime would never construct — orbit
 * controls, the transform gizmo, the ground grid, selection outlines, click picking and the
 * axis indicator.
 */
export class ViewportController {
  readonly host: RenderHost;

  private overlay = new THREE.Scene();
  private orbit: OrbitControls;
  private gizmo: GizmoController;
  private outline: SelectionOutline;
  private grid = new GroundGrid();
  private sceneGizmos: SceneGizmos;
  private stress: StressScene | null = null;
  private playing = false;
  private gizmosDirty = false;

  private axisScene = new THREE.Scene();
  private axisCamera: THREE.PerspectiveCamera;

  private raycaster = new THREE.Raycaster();
  private pointerDownAt: { x: number; y: number } | null = null;
  private canvas: HTMLCanvasElement;
  private resizeObserver: ResizeObserver;
  private unsubscribes: (() => void)[] = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly engine: Engine,
    history: CommandHistory,
  ) {
    this.canvas = document.createElement('canvas');
    container.appendChild(this.canvas);

    this.host = new RenderHost(engine.scene, {
      canvas: this.canvas,
      pixelRatio: Math.min(devicePixelRatio, 2),
      stats: engine.stats,
    });
    this.host.overlay = this.overlay;
    this.host.onAfterRender = () => this.renderAxisIndicator();

    this.orbit = new OrbitControls(this.host.camera, this.canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.screenSpacePanning = false;
    this.orbit.maxPolarAngle = Math.PI * 0.98;

    this.gizmo = new GizmoController(
      this.host.camera,
      this.canvas,
      engine.scene,
      this.host.bridge,
      history,
      this.overlay,
    );
    this.outline = new SelectionOutline(this.host.bridge);
    this.sceneGizmos = new SceneGizmos(engine.scene, this.host.bridge);
    this.sceneGizmos.rebuild();
    this.overlay.add(this.outline.object);
    this.overlay.add(this.grid.mesh);
    this.overlay.add(this.sceneGizmos.object);

    this.axisCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
    this.buildAxisIndicator();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.bindEvents();
  }

  /**
   * Swaps the measurement scene in or out. Lives in the world scene, not the overlay, so it
   * is measured through exactly the same path as authored content.
   */
  setStressScene(preset: 'off' | 'forest' | 'city', overrides: Partial<StressParams> = {}): void {
    if (preset === 'off') {
      this.stress?.dispose();
      this.stress = null;
      this.engine.stats.reset();
      return;
    }
    const params: StressParams = {
      ...(preset === 'city' ? CITY_PRESET : FOREST_PRESET),
      ...overrides,
    };
    if (this.stress) {
      this.stress.rebuild(params);
    } else {
      this.stress = new StressScene(params);
      this.host.scene.add(this.stress.root);
    }
    this.engine.stats.reset();
  }

  stressStats() {
    return this.stress?.getStats() ?? null;
  }

  frameReport() {
    return this.engine.stats.report();
  }

  /** Convenience passthrough — plenty of editor code only wants the bridge. */
  get bridge(): RenderBridge {
    return this.host.bridge;
  }

  private get camera(): THREE.PerspectiveCamera {
    return this.host.camera;
  }

  // ------------------------------------------------------------------ setup

  private buildAxisIndicator(): void {
    const axes = new THREE.AxesHelper(1);
    (axes.material as THREE.Material).depthTest = false;
    this.axisScene.add(axes);
    this.axisCamera.position.set(0, 0, 3);
  }

  private bindEvents(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    // Input for Play mode. Bound once and gated on `playing` rather than added and removed,
    // so a key held as Play starts cannot be missed between the two.
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: true });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);

    /**
     * Deferred to the next frame rather than done per event.
     *
     * Rebuilding walks the scene, and a script that spawns fifty entities in one frame would
     * otherwise walk it fifty times — the exact workload Play mode now makes easy to write.
     */
    const invalidateGizmos = () => {
      this.gizmosDirty = true;
    };

    this.unsubscribes.push(
      this.engine.events.on('afterUpdate', () => this.render()),
      // The gizmo pivot and selection outline follow whatever moves the scene, whether that
      // is the gizmo itself, the Inspector, or an undo.
      this.engine.scene.events.on('transformChanged', () => this.refreshOverlays()),
      this.engine.scene.events.on('componentsChanged', () => this.refreshOverlays()),
      this.engine.scene.events.on('sceneReplaced', () => this.refreshOverlays()),
      // Light and camera handles exist per component, so they are rebuilt on the events that
      // can add or remove one.
      this.engine.scene.events.on('entityAdded', invalidateGizmos),
      this.engine.scene.events.on('entityRemoved', invalidateGizmos),
      this.engine.scene.events.on('componentsChanged', invalidateGizmos),
      this.engine.scene.events.on('sceneReplaced', invalidateGizmos),
      this.engine.events.on('modeChanged', ({ mode }) => this.setPlaying(mode === 'play')),
      useEditorStore.subscribe((state, previous) => {
        if (state.selection !== previous.selection) {
          this.gizmo.setSelection(state.selection);
          this.outline.update(state.selection);
        }
        if (state.shading !== previous.shading) this.host.setShadingMode(state.shading);
        if (state.tool !== previous.tool) this.gizmo.setTool(state.tool);
        if (state.space !== previous.space) this.gizmo.setSpace(state.space);
        if (
          state.snapEnabled !== previous.snapEnabled ||
          state.moveSnap !== previous.moveSnap ||
          state.rotateSnap !== previous.rotateSnap ||
          state.scaleSnap !== previous.scaleSnap
        ) {
          this.gizmo.setSnapping(
            state.snapEnabled,
            state.moveSnap,
            state.rotateSnap,
            state.scaleSnap,
          );
        }
      }),
    );

    const initial = editorState();
    this.host.setShadingMode(initial.shading);
    this.gizmo.setTool(initial.tool);
    this.gizmo.setSpace(initial.space);
    this.gizmo.setSnapping(
      initial.snapEnabled,
      initial.moveSnap,
      initial.rotateSnap,
      initial.scaleSnap,
    );
  }

  // -------------------------------------------------------------- interaction

  /**
   * Enters or leaves the game view.
   *
   * Three things change and nothing else does: the camera becomes the scene's own, the editor
   * overlay is detached (grid, gizmo, selection outline, light handles — none of which exist
   * in a shipped game), and the orbit controls stop fighting the scene camera for the pointer.
   * The renderer, the scene and the bridge are untouched, which is the §6 seam working as
   * designed: Play mode is a different *view* of the same frame, not a different renderer.
   */
  private setPlaying(playing: boolean): void {
    if (playing === this.playing) return;
    this.playing = playing;

    if (playing) {
      const camera = findPrimaryCamera(this.engine.scene.all());
      const attached = camera ? this.host.setActiveCameraEntity(camera.id) : false;
      this.host.overlay = null;
      this.orbit.enabled = false;
      // Focus the canvas so keys reach the page rather than whatever panel was last clicked.
      this.canvas.tabIndex = -1;
      this.canvas.focus({ preventScroll: true });
      editorState().pushConsole({
        level: attached ? 'info' : 'warn',
        source: 'Play',
        text: attached
          ? `Playing through "${camera!.name}". WASD to move, arrows to turn, Esc to stop.`
          : 'No Camera component in the scene — playing through the editor camera.',
        entityId: camera?.id ?? null,
      });
    } else {
      this.host.setActiveCameraEntity(null);
      this.host.overlay = this.overlay;
      this.orbit.enabled = true;
      // The scene was restored from the snapshot, so every handle is pointing at a stale node.
      this.gizmosDirty = true;
    }
  }

  // --------------------------------------------------------- play-mode input

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.playing || isTextEntry(event.target)) return;
    // Arrows and space scroll the page by default, which is very obvious the first time you
    // strafe and the whole editor jumps.
    if (event.code.startsWith('Arrow') || event.code === 'Space') event.preventDefault();
    this.engine.input.setKey(event.code, true);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (!this.playing) return;
    this.engine.input.setKey(event.code, false);
  };

  /** A key held while the window loses focus never delivers its keyup. */
  private onBlur = (): void => {
    this.engine.input.clear();
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.playing) return;
    const rect = this.canvas.getBoundingClientRect();
    this.engine.input.setPointer(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
      event.movementX,
      event.movementY,
    );
    this.engine.input.setButtons(event.buttons);
  };

  private onWheel = (event: WheelEvent): void => {
    if (!this.playing) return;
    this.engine.input.addWheel(event.deltaY);
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (this.playing) {
      this.engine.input.setButtons(event.buttons);
      return;
    }
    this.pointerDownAt = { x: event.clientX, y: event.clientY };
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.playing) {
      this.engine.input.setButtons(event.buttons);
      return;
    }
    const down = this.pointerDownAt;
    this.pointerDownAt = null;
    if (!down || event.button !== 0) return;
    // Suppress selection when the pointer was orbiting or driving the gizmo.
    if (this.gizmo.isDragging) return;
    const travelled = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (travelled > CLICK_SLOP_PX) return;

    const hit = this.pick(event);
    const store = editorState();
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;

    if (!hit) {
      if (!additive) store.clearSelection();
      return;
    }
    if (additive) store.toggleSelection(hit);
    else store.setSelection([hit]);
  };

  private pick(event: PointerEvent): EntityId | null {
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    // Light and camera handles are pickable too — they are the only way to click an entity
    // that renders no geometry.
    const hits = this.raycaster.intersectObjects(
      [...this.bridge.pickables(), ...this.sceneGizmos.pickables()],
      false,
    );
    for (const hit of hits) {
      const id =
        (hit.object.userData.entityId as EntityId | undefined) ??
        this.bridge.entityIdFor(hit.object);
      if (id) return id;
    }
    return null;
  }

  /** Frames the selection, or the whole scene if nothing is selected (the F shortcut). */
  focusSelection(): void {
    const ids = editorState().selection;
    const box = new THREE.Box3();
    const targets = ids.length > 0 ? ids : this.engine.scene.rootIds();
    for (const id of targets) {
      const object = this.bridge.objectFor(id);
      if (object) box.expandByObject(object);
    }
    if (box.isEmpty()) return;

    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 0.5);
    const distance = radius / Math.sin((this.camera.fov * Math.PI) / 360);
    const direction = this.camera.position.clone().sub(this.orbit.target).normalize();

    this.orbit.target.copy(centre);
    this.camera.position.copy(centre).addScaledVector(direction, distance * 1.4);
    this.orbit.update();
  }

  /** World point in front of the camera — where newly created primitives land. */
  spawnPoint(): [number, number, number] {
    const target = this.orbit.target.clone();
    return [round(target.x), 0, round(target.z)];
  }

  private refreshOverlays(): void {
    // While playing, the overlay is detached and the scene moves every frame — refreshing
    // outlines a hundred times a second for something nobody can see is pure waste.
    if (this.playing) return;
    this.gizmo.syncPivot();
    this.outline.update(editorState().selection);
    // The wireframe mirrors evaluated geometry, so it has to be rebuilt whenever the mesh
    // changes — a modifier edit replaces the geometry entirely.
    if (this.host.getShadingMode() !== 'shaded') this.host.applyShading();
  }

  // ------------------------------------------------------------------ frame

  private resize(): void {
    const { clientWidth, clientHeight } = this.container;
    this.host.setSize(clientWidth, clientHeight);
  }

  private render(): void {
    if (!this.playing) {
      this.orbit.enabled = !this.gizmo.isDragging;
      this.orbit.update();
      this.grid.update(this.camera);
      if (this.gizmosDirty) {
        this.gizmosDirty = false;
        this.sceneGizmos.rebuild();
        // A newly added mesh has not been through the shading pass yet, so in wireframe mode
        // it would arrive solid.
        if (this.host.getShadingMode() !== 'shaded') this.host.applyShading();
      }
      this.sceneGizmos.sync();
    }
    this.host.render();
  }

  /** Bottom-left orientation widget, sharing the main camera's rotation. */
  private renderAxisIndicator(): void {
    // An editor affordance like any other, so it goes away with the rest of them in Play mode.
    if (this.playing) return;
    this.axisCamera.position.set(0, 0, 3).applyQuaternion(this.camera.quaternion);
    this.axisCamera.quaternion.copy(this.camera.quaternion);
    this.host.renderer.clearDepth();
    this.host.renderer.setViewport(12, 12, AXIS_INDICATOR_PX, AXIS_INDICATOR_PX);
    this.host.renderer.render(this.axisScene, this.axisCamera);
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.gizmo.dispose();
    this.outline.dispose();
    this.sceneGizmos.dispose();
    this.grid.dispose();
    this.stress?.dispose();
    this.orbit.dispose();
    this.host.dispose();
    this.canvas.remove();
  }
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
