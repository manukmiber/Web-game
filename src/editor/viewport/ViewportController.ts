import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { findPrimaryCamera } from '@engine/components/Camera';
import type { Engine } from '@engine/loop/Engine';
import type { GraphicsSettings } from '@engine/render/GraphicsSettings';
import type { RenderBridge } from '@engine/render/RenderBridge';
import { RenderHost } from '@engine/render/RenderHost';
import { collectSceneStats } from '@engine/perf/SceneStats';
import {
  CITY_PRESET,
  FOREST_PRESET,
  StressScene,
  type StressParams,
} from '@engine/perf/StressScene';
import type { EntityId } from '@engine/scene/types';
import type { CommandHistory } from '../commands/Command';
import { isCoarsePointer, isTextEntry } from '../dom';
import { editorState, useEditorStore } from '../state/editorStore';
import { GizmoController } from './GizmoController';
import { GroundGrid } from './GroundGrid';
import { isSelectionClick, type Press } from './pointerGesture';
import { SceneGizmos } from './SceneGizmos';
import { SelectionOutline } from './SelectionOutline';

const AXIS_INDICATOR_PX = 96;
/**
 * How much bigger the transform gizmo is drawn when the pointer is a finger.
 *
 * At size 1 the translate arrows are about 3 mm wide on a phone — under half the ~9 mm that a
 * fingertip can reliably hit — so a drag on an arrow landed on the centre free-move handle, or
 * on nothing. This is the whole of "the gizmo does not work on mobile": the handles were there,
 * they were simply too small to touch.
 */
const TOUCH_GIZMO_SCALE = 1.9;
/** How far off a tap's centre the extra picking rays are fired. See `pick`. */
const TOUCH_PICK_SPREAD_PX = 11;

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
  private pointerDownAt: Press | null = null;
  /** True when the primary pointer is a finger. Decides hit-target sizes, nothing else. */
  private coarsePointer = false;
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

    const graphics = editorState().graphics;
    this.host = new RenderHost(engine.scene, {
      canvas: this.canvas,
      pixelRatio: pixelRatioFor(graphics.pixelRatioCap),
      graphics,
      assets: engine.assets,
      stats: engine.stats,
    });
    this.host.overlay = this.overlay;
    this.host.onAfterRender = () => this.renderAxisIndicator();

    this.coarsePointer = isCoarsePointer();

    this.orbit = new OrbitControls(this.host.camera, this.canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.screenSpacePanning = false;
    this.orbit.maxPolarAngle = Math.PI * 0.98;
    // One finger orbits, two pinch to zoom and drag to pan — the gesture set every 3D app on a
    // phone uses. Spelled out rather than left to the default because the default one-finger
    // gesture changed between Three releases, and orbit-on-one-finger is what the viewport hint
    // promises.
    this.orbit.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

    this.gizmo = new GizmoController(
      this.host.camera,
      this.canvas,
      engine.scene,
      this.host.bridge,
      history,
      this.overlay,
    );
    if (this.coarsePointer) this.gizmo.setHandleScale(TOUCH_GIZMO_SCALE);
    /**
     * Orbit yields to the gizmo the instant a handle is grabbed.
     *
     * This used to be done once per frame in `render()`, which left the first frame of every
     * drag with both controls live: the camera swung as the handle was picked up, and on a
     * touch screen — where the same one-finger gesture drives both — that was enough to throw
     * the drag off the axis entirely.
     */
    this.gizmo.controls.addEventListener('dragging-changed', (event) => {
      this.orbit.enabled = !event.value;
    });
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

  /**
   * What the scene's scatter layers cost right now.
   *
   * Beside the stress presets rather than folded into them: those are synthetic loads, this is
   * authored content, and a forest you painted is exactly the thing you want to watch the frame
   * budget against while you paint it.
   */
  scatterStats() {
    return this.bridge.scatterStats();
  }

  frameReport() {
    return this.engine.stats.report();
  }

  /**
   * The full triangle and object census.
   *
   * Computed on demand rather than every frame: it walks the whole rendered tree, and the panel
   * that wants it polls four times a second. Doing it in the render loop would make the thing
   * being measured slower, which is the one failure a performance instrument must not have.
   */
  sceneStats(topCount?: number) {
    return collectSceneStats(this.engine.scene, this.bridge, {
      ...(topCount === undefined ? {} : { topCount }),
      activeShadowCasters: this.host.shadowBudget().active,
      // The harness lives in the render host's scene rather than in the bridge, because it is
      // not authored content and must never appear in the Hierarchy. It is still geometry this
      // frame draws, so a census that left it out reported a 900-triangle scene while sixty
      // thousand harness triangles were on screen.
      extraRoots: this.stress ? [this.stress.root] : [],
    });
  }

  /** Shadow-casting lights granted, requested, and the current cap. */
  shadowBudget() {
    return this.host.shadowBudget();
  }

  /**
   * The order systems will tick in, as resolved by the schedule.
   *
   * Worth surfacing rather than trusting: the order is now computed from stages and declared
   * dependencies (see `ecs/Schedule`), and a computed order that cannot be inspected is harder to
   * reason about than the hand-written list it replaced. "Why does my system see last frame's
   * position" is answered by reading this.
   */
  systemSchedule(): { name: string; stage: string; modes: string }[] {
    return this.engine.systemOrder().map((system) => ({
      name: system.name,
      stage: system.stage ?? 'simulate',
      modes: system.runsIn.join('/'),
    }));
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
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
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
        if (state.graphics !== previous.graphics) this.applyGraphics(state.graphics);
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

  /**
   * The pixel-ratio cap is applied here rather than in the RenderHost because `devicePixelRatio`
   * is a `window` property, and the host is written to be constructible from a worker
   * (ARCHITECTURE.md §9.5). Everything else in the settings goes straight through.
   */
  private applyGraphics(settings: GraphicsSettings): void {
    this.host.setPixelRatio(pixelRatioFor(settings.pixelRatioCap));
    this.host.applyGraphics(settings);
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
    this.pointerDownAt = {
      x: event.clientX,
      y: event.clientY,
      touch: event.pointerType === 'touch',
    };
  };

  /**
   * A pointer the browser took back — a system gesture, a window switch, a palm the touch stack
   * decided against. No pointerup follows one, so without this the press record and the gizmo's
   * claim would both outlive the press and be answered by the next one.
   */
  private onPointerCancel = (): void => {
    this.pointerDownAt = null;
    this.gizmo.claimedPress();
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.playing) {
      this.engine.input.setButtons(event.buttons);
      return;
    }
    const down = this.pointerDownAt;
    this.pointerDownAt = null;
    // Consumed before any early return: a claim left lying around would swallow the next click.
    const claimedByGizmo = this.gizmo.claimedPress();
    if (!down || event.button !== 0) return;
    // Suppress selection when the pointer was orbiting or driving the gizmo.
    if (!isSelectionClick(down, { x: event.clientX, y: event.clientY }, claimedByGizmo)) return;

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

  /**
   * What is under the pointer, if anything.
   *
   * A finger gets more than one ray. A tap reports a single point at the centre of a contact
   * patch the better part of a centimetre across, so a ray through that point misses anything
   * thin — a lamp post, a fence, a light gizmo — even when the user is plainly touching it. The
   * extra samples cost four raycasts against a handful of objects, and only when the first one
   * finds nothing.
   */
  private pick(event: PointerEvent): EntityId | null {
    const targets = [...this.bridge.pickables(), ...this.sceneGizmos.pickables()];
    const spread = event.pointerType === 'touch' ? TOUCH_PICK_SPREAD_PX : 0;
    const offsets: [number, number][] =
      spread > 0
        ? [[0, 0], [-spread, 0], [spread, 0], [0, -spread], [0, spread]]
        : [[0, 0]];

    for (const [dx, dy] of offsets) {
      const id = this.pickAt(event.clientX + dx, event.clientY + dy, targets);
      if (id) return id;
    }
    return null;
  }

  private pickAt(clientX: number, clientY: number, targets: THREE.Object3D[]): EntityId | null {
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    // Light and camera handles are pickable too — they are the only way to click an entity
    // that renders no geometry.
    const hits = this.raycaster.intersectObjects(targets, false);
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
      // A safety net, not the mechanism: `dragging-changed` disables orbit the moment a handle
      // is grabbed. This catches the one path that never fires it — the gizmo being detached
      // mid-drag, by a tool shortcut — which would otherwise leave the camera locked for good.
      if (!this.gizmo.isDragging) this.orbit.enabled = true;
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
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
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

/**
 * A 3× phone screen renders nine times the pixels of a 1× one for a difference almost nobody
 * can see, so the cap is the first thing to reach for on mobile — and unlike resolution scale
 * it costs nothing in sharpness until it actually bites.
 */
function pixelRatioFor(cap: number): number {
  return Math.min(window.devicePixelRatio || 1, cap);
}
