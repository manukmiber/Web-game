import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Engine } from '@engine/loop/Engine';
import { RenderBridge } from '@engine/render/RenderBridge';
import type { EntityId } from '@engine/scene/types';
import type { CommandHistory } from '../commands/Command';
import { editorState, useEditorStore } from '../state/editorStore';
import { GizmoController } from './GizmoController';
import { GroundGrid } from './GroundGrid';
import { SelectionOutline } from './SelectionOutline';

const AXIS_INDICATOR_PX = 96;
/** Pointer travel beyond this is treated as an orbit drag, not a click-to-select. */
const CLICK_SLOP_PX = 4;

/**
 * Owns the canvas: renderer, editor camera, lighting, grid, picking and the gizmo.
 *
 * This is the editor's presentation layer. The scene contents come from the RenderBridge —
 * shared with the future runtime — while the grid, gizmo and selection outline live in a
 * separate overlay scene that the runtime will simply never construct.
 */
export class ViewportController {
  readonly bridge: RenderBridge;

  private renderer: THREE.WebGLRenderer;
  private camera: THREE.PerspectiveCamera;
  private scene = new THREE.Scene();
  private overlay = new THREE.Scene();
  private orbit: OrbitControls;
  private gizmo: GizmoController;
  private outline: SelectionOutline;
  private grid = new GroundGrid();

  private axisScene = new THREE.Scene();
  private axisCamera: THREE.PerspectiveCamera;

  private raycaster = new THREE.Raycaster();
  private pointerDownAt: { x: number; y: number } | null = null;
  private resizeObserver: ResizeObserver;
  private unsubscribes: (() => void)[] = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly engine: Engine,
    history: CommandHistory,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x2b2b2b);
    // The axis indicator draws in a second pass over the same canvas, so the main pass must
    // not clear it away.
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
    this.camera.position.set(8, 6, 10);

    this.bridge = new RenderBridge(engine.scene);
    this.scene.add(this.bridge.root);
    this.buildEnvironment();

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.screenSpacePanning = false;
    this.orbit.maxPolarAngle = Math.PI * 0.98;

    this.gizmo = new GizmoController(
      this.camera,
      this.renderer.domElement,
      engine.scene,
      this.bridge,
      history,
      this.overlay,
    );
    this.outline = new SelectionOutline(this.bridge);
    this.overlay.add(this.outline.object);

    this.axisCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
    this.buildAxisIndicator();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.bindEvents();
  }

  // ------------------------------------------------------------------ setup

  private buildEnvironment(): void {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(12, 20, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    // Tight frustum around the working area — a shadow camera sized for 25 km would have no
    // usable resolution. Cascaded shadows arrive with the streaming work in Phase 3.
    const extent = 30;
    key.shadow.camera.left = -extent;
    key.shadow.camera.right = extent;
    key.shadow.camera.top = extent;
    key.shadow.camera.bottom = -extent;
    key.shadow.camera.far = 120;
    key.shadow.bias = -0.0005;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x8fb3ff, 0.3);
    fill.position.set(-10, 8, -12);
    this.scene.add(fill);

    this.overlay.add(this.grid.mesh);
  }

  private buildAxisIndicator(): void {
    const axes = new THREE.AxesHelper(1);
    (axes.material as THREE.Material).depthTest = false;
    this.axisScene.add(axes);
    this.axisCamera.position.set(0, 0, 3);
  }

  private bindEvents(): void {
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    this.unsubscribes.push(
      this.engine.events.on('afterUpdate', () => this.render()),
      // The gizmo pivot and selection outline follow whatever moves the scene, whether that
      // is the gizmo itself, the Inspector, or an undo.
      this.engine.scene.events.on('transformChanged', () => this.refreshOverlays()),
      this.engine.scene.events.on('componentsChanged', () => this.refreshOverlays()),
      this.engine.scene.events.on('sceneReplaced', () => this.refreshOverlays()),
      useEditorStore.subscribe((state, previous) => {
        if (state.selection !== previous.selection) {
          this.gizmo.setSelection(state.selection);
          this.outline.update(state.selection);
        }
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

  private onPointerDown = (event: PointerEvent): void => {
    this.pointerDownAt = { x: event.clientX, y: event.clientY };
  };

  private onPointerUp = (event: PointerEvent): void => {
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
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.bridge.pickables(), false);
    for (const hit of hits) {
      const id = this.bridge.entityIdFor(hit.object);
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
    this.gizmo.syncPivot();
    this.outline.update(editorState().selection);
  }

  // ------------------------------------------------------------------ frame

  private resize(): void {
    const { clientWidth, clientHeight } = this.container;
    if (clientWidth === 0 || clientHeight === 0) return;
    this.renderer.setSize(clientWidth, clientHeight, false);
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
  }

  private render(): void {
    this.orbit.enabled = !this.gizmo.isDragging;
    this.orbit.update();
    this.grid.update(this.camera);

    const { clientWidth, clientHeight } = this.container;
    this.renderer.clear();
    this.renderer.setViewport(0, 0, clientWidth, clientHeight);
    this.renderer.render(this.scene, this.camera);
    this.renderer.render(this.overlay, this.camera);

    // Axis indicator, bottom-left, sharing the camera's orientation.
    this.axisCamera.position.set(0, 0, 3).applyQuaternion(this.camera.quaternion);
    this.axisCamera.quaternion.copy(this.camera.quaternion);
    this.renderer.clearDepth();
    this.renderer.setViewport(12, 12, AXIS_INDICATOR_PX, AXIS_INDICATOR_PX);
    this.renderer.render(this.axisScene, this.axisCamera);
    this.renderer.setViewport(0, 0, clientWidth, clientHeight);
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.resizeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    this.gizmo.dispose();
    this.outline.dispose();
    this.grid.dispose();
    this.orbit.dispose();
    this.bridge.dispose();
    this.renderer.dispose();
    canvas.remove();
  }
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
