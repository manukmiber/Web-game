import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { findPrimaryCamera } from '@engine/components/Camera';
import type { CharacterControllerComponent } from '@engine/components/CharacterController';
import type { Engine } from '@engine/loop/Engine';
import type { GraphicsSettings } from '@engine/render/GraphicsSettings';
import type { RenderBridge } from '@engine/render/RenderBridge';
import { RenderHost } from '@engine/render/RenderHost';
import {
  ORTHO_EYE_HEIGHT,
  ORTHO_MAX_ZOOM,
  ORTHO_MIN_ZOOM,
  clampOrthoZoom,
  orthoHalfHeight,
  zoomToFit,
} from '@engine/render/topDownView';
import { collectSceneStats } from '@engine/perf/SceneStats';
import {
  CITY_PRESET,
  FOREST_PRESET,
  StressScene,
  type StressParams,
} from '@engine/perf/StressScene';
import type { Scene } from '@engine/scene/Scene';
import type { EntityId } from '@engine/scene/types';
import type { CommandHistory } from '../commands/Command';
import { isCoarsePointer, isTextEntry } from '../dom';
import { editorState, useEditorStore, type ViewMode } from '../state/editorStore';
import { GizmoController } from './GizmoController';
import { GroundGrid } from './GroundGrid';
import { SceneGizmos } from './SceneGizmos';
import { SelectionOutline } from './SelectionOutline';

const AXIS_INDICATOR_PX = 96;
/** Pointer travel beyond this is treated as an orbit drag, not a click-to-select. */
const CLICK_SLOP_PX = 4;
/**
 * The same threshold for a finger.
 *
 * A mouse click moves a pixel or two; a tap on glass routinely moves ten while the finger
 * flattens and rolls. At the mouse threshold roughly half of all taps were read as tiny orbit
 * drags and selected nothing, which is indistinguishable from picking being broken.
 */
const TOUCH_CLICK_SLOP_PX = 14;
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
 * How long after the pointer lock ends an Escape is still read as having ended it.
 *
 * Browsers disagree about whether the Escape that releases a pointer lock is also delivered to
 * the page: Chrome swallows it, others do not. Without this, Play mode would stop on the first
 * Escape in one browser and the second in another — and stopping Play is destructive, because
 * the running scene is thrown away and the authored one restored. The grace window makes the
 * answer the same everywhere: the first Escape gives the mouse back, the second stops playing.
 */
const POINTER_UNLOCK_GRACE_MS = 350;
/** How far past the frame's edge the 2D grid keeps drawing, as a multiple of the half-height. */
const ORTHO_GRID_REACH = 1.6;

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
  /**
   * One set of controls per camera, rather than one whose camera is swapped.
   *
   * OrbitControls derives its internal frame from `object.up` in its *constructor*, and the 2D
   * camera's up is world -Z where the 3D camera's is +Y — so a swapped-in camera would be driven
   * through the wrong frame. Two instances also mean each view keeps its own target, which is
   * what makes leaving the 2D view and coming back land where you left it.
   */
  private orbit: OrbitControls;
  private orbit2D: OrbitControls;
  private viewMode: ViewMode = '3D';
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
  private pointerDownAt: { x: number; y: number; touch: boolean } | null = null;
  /** Whether this play session wants the pointer captured. See `setPlaying`. */
  private wantsPointerCapture = false;
  /** When the pointer lock last ended, for `consumeLookEscape`. */
  private pointerUnlockedAt = 0;
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
    /**
     * Middle-drag pans, where Three's default dollies it.
     *
     * The viewport hint has promised "Pan: middle / right drag" since the day it was written and
     * the middle button has never done it — it zoomed, duplicating the wheel and leaving the
     * documented gesture missing. Written out in full rather than patching the one entry, because
     * a partial override of a defaulted object is the kind of thing that reads as an accident.
     */
    this.orbit.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };

    /**
     * The 2D view's navigation: pan and zoom, and no orbit at all.
     *
     * Dragging rotates in the 3D view and pans here, because that is what dragging means in every
     * 2D editor there is — and because an orbit that tilted the camera would stop it being a top
     * view. `screenSpacePanning` has to be on: with it off, OrbitControls pans in the plane
     * perpendicular to the camera's up, which for a camera looking straight down is the *vertical*
     * plane, and a pan would fly the view up out of the world instead of across it.
     */
    this.orbit2D = new OrbitControls(this.host.orthoCamera, this.canvas);
    this.orbit2D.enabled = false;
    this.orbit2D.enableDamping = true;
    this.orbit2D.dampingFactor = 0.12;
    this.orbit2D.enableRotate = false;
    this.orbit2D.screenSpacePanning = true;
    this.orbit2D.minZoom = ORTHO_MIN_ZOOM;
    this.orbit2D.maxZoom = ORTHO_MAX_ZOOM;
    this.orbit2D.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.orbit2D.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };

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
      this.activeOrbit.enabled = !event.value;
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

  /** The camera the editor's tools — picking, focus, the axis widget — are looking through. */
  private get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.host.editorCamera;
  }

  /** The controls driving that camera. */
  private get activeOrbit(): OrbitControls {
    return this.viewMode === '2D' ? this.orbit2D : this.orbit;
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
    // On `document`, not the canvas: that is where the spec fires it, and it fires on the way
    // out as well as in — including when the browser drops the lock without asking us.
    document.addEventListener('pointerlockchange', this.onPointerLockChange);

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
        if (state.viewMode !== previous.viewMode) this.setViewMode(state.viewMode);
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
    this.setViewMode(initial.viewMode);
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

  // ---------------------------------------------------------------- view mode

  /**
   * Switches the viewport between free-look 3D and the 2D top-down view.
   *
   * Everything that changes is listed here, and it is all *editor* state: the projection, which
   * controls are live, which gizmo handles are offered, and how the grid fades. The scene, the
   * renderer and the bridge are untouched — the same seam Play mode uses (§6). A scene has no
   * idea it is being looked at from above, which is the point: a 2D game built here is a 3D scene
   * with its depth axis left alone, not a second kind of project.
   *
   * Each switch carries the view centre across, in both directions: drop into 2D and you are
   * looking down at whatever was in front of you, come back up and the perspective camera is over
   * the part of the map you were just editing. Two cameras that each remembered their own place
   * would make the pair a way of losing yourself rather than a way of working.
   */
  private setViewMode(mode: ViewMode): void {
    if (mode === this.viewMode) return;
    const entering2D = mode === '2D';
    if (entering2D) this.frameTopDown(this.orbit.target);
    else this.recentre3D(this.orbit2D.target);
    this.viewMode = mode;

    this.host.setEditorProjection(entering2D ? 'orthographic' : 'perspective');
    this.gizmo.setCamera(this.camera);
    this.gizmo.setPlaneLock(entering2D);
    if (!entering2D) this.grid.resetFade();

    // Play mode owns the pointer; whichever controls are nominally active stay off until it
    // hands it back. `setPlaying` re-enables the right one on the way out.
    this.orbit.enabled = !this.playing && !entering2D;
    this.orbit2D.enabled = !this.playing && entering2D;
  }

  /**
   * Points the 2D camera straight down at `focus`, keeping its zoom.
   *
   * The camera has to sit exactly `ORTHO_EYE_HEIGHT` above the plane it frames: that is the
   * distance `RenderHost.viewPoint` walks back down to work out where the viewer is looking, and
   * everything that depends on it — chunk streaming, the shadow frustum — is wrong by however
   * much this drifts. Panning cannot break the invariant (the 2D camera's pan axes are world X
   * and Z, never Y), so it only has to be established here.
   */
  private frameTopDown(focus: THREE.Vector3): void {
    const target = this.orbit2D.target;
    target.set(focus.x, 0, focus.z);
    this.host.orthoCamera.position.set(target.x, ORTHO_EYE_HEIGHT, target.z);
    this.host.orthoCamera.zoom = clampOrthoZoom(this.host.orthoCamera.zoom);
    this.host.orthoCamera.updateProjectionMatrix();
    this.host.orthoCamera.updateMatrixWorld(true);
    this.orbit2D.update();
  }

  /**
   * Slides the perspective rig sideways so it orbits `focus`, keeping its angle and distance.
   *
   * The pose is preserved rather than recomputed: coming back from the 2D view should feel like
   * the camera followed you across the map, not like it was re-aimed from somewhere new.
   */
  private recentre3D(focus: THREE.Vector3): void {
    const offset = this.host.camera.position.clone().sub(this.orbit.target);
    this.orbit.target.set(focus.x, this.orbit.target.y, focus.z);
    this.host.camera.position.copy(this.orbit.target).add(offset);
    this.orbit.update();
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
      this.activeOrbit.enabled = false;
      // Asked once, here, rather than on every click: the answer is a property of the scene, and
      // the scene is frozen for the duration of a play session by the snapshot Play takes.
      this.wantsPointerCapture = !this.coarsePointer && sceneWantsMouseLook(this.engine.scene);
      // Focus the canvas so keys reach the page rather than whatever panel was last clicked.
      this.canvas.tabIndex = -1;
      this.canvas.focus({ preventScroll: true });
      const look = this.wantsPointerCapture
        ? 'click to capture the mouse and look around'
        : 'arrows to turn';
      editorState().pushConsole({
        level: attached ? 'info' : 'warn',
        source: 'Play',
        text: attached
          ? `Playing through "${camera!.name}". WASD to move, ${look}, Esc to stop.`
          : 'No Camera component in the scene — playing through the editor camera.',
        entityId: camera?.id ?? null,
      });
    } else {
      this.releasePointerLock();
      this.wantsPointerCapture = false;
      this.host.setActiveCameraEntity(null);
      this.host.overlay = this.overlay;
      this.activeOrbit.enabled = true;
      // The scene was restored from the snapshot, so every handle is pointing at a stale node.
      this.gizmosDirty = true;
    }
  }

  // ----------------------------------------------------------- pointer lock

  /**
   * Hands the mouse to the game.
   *
   * Called from the first click inside the viewport while playing, because that is the only
   * moment a browser will grant a lock — the request must come from a user gesture, which rules
   * out doing it when Play starts.
   */
  private capturePointer(): void {
    if (!this.playing || !this.wantsPointerCapture) return;
    if (document.pointerLockElement === this.canvas) return;
    // Chrome returns a promise that rejects when the request is refused — most often because the
    // user pressed Escape a moment ago and the browser is enforcing its own cool-down. A refusal
    // is not an error worth reporting: drag-to-look still works, which is why `lookActive` reads
    // the buttons as well as the lock.
    const request: unknown = this.canvas.requestPointerLock();
    if (request instanceof Promise) request.catch(() => {});
  }

  private releasePointerLock(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  private onPointerLockChange = (): void => {
    const locked = document.pointerLockElement === this.canvas;
    if (!locked) this.pointerUnlockedAt = performance.now();
    this.engine.input.setPointerLocked(locked);
  };

  /**
   * Whether an Escape just now belonged to the mouse look rather than to Play mode.
   *
   * The shortcut layer asks before stopping Play, so that getting your cursor back and throwing
   * away a running scene are never the same keystroke. See `POINTER_UNLOCK_GRACE_MS` for why the
   * answer cannot simply be "is the pointer locked right now".
   */
  consumeLookEscape(): boolean {
    if (document.pointerLockElement === this.canvas) {
      document.exitPointerLock();
      return true;
    }
    return this.playing && performance.now() - this.pointerUnlockedAt < POINTER_UNLOCK_GRACE_MS;
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
      this.capturePointer();
      return;
    }
    this.pointerDownAt = {
      x: event.clientX,
      y: event.clientY,
      touch: event.pointerType === 'touch',
    };
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
    if (travelled > (down.touch ? TOUCH_CLICK_SLOP_PX : CLICK_SLOP_PX)) return;

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

    if (this.viewMode === '2D') {
      /**
       * The 2D view frames by *zoom*, not by distance.
       *
       * Moving an orthographic camera closer changes nothing on screen — that is what makes it
       * orthographic — so the only way to fill the frame with something is to scale the frustum.
       * The camera itself stays at its fixed height above the plane, which keeps the invariant
       * `frameTopDown` establishes intact.
       */
      this.frameTopDown(centre);
      this.host.orthoCamera.zoom = zoomToFit(radius);
      this.host.orthoCamera.updateProjectionMatrix();
      return;
    }

    const distance = radius / Math.sin((this.host.camera.fov * Math.PI) / 360);
    const direction = this.host.camera.position.clone().sub(this.orbit.target).normalize();

    this.orbit.target.copy(centre);
    this.host.camera.position.copy(centre).addScaledVector(direction, distance * 1.4);
    this.orbit.update();
  }

  /** World point in front of the camera — where newly created primitives land. */
  spawnPoint(): [number, number, number] {
    const target = this.activeOrbit.target.clone();
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
      const orbit = this.activeOrbit;
      // A safety net, not the mechanism: `dragging-changed` disables orbit the moment a handle
      // is grabbed. This catches the one path that never fires it — the gizmo being detached
      // mid-drag, by a tool shortcut — which would otherwise leave the camera locked for good.
      if (!this.gizmo.isDragging) orbit.enabled = true;
      orbit.update();
      if (this.viewMode === '2D') {
        // Retuned every frame because the zoom it is derived from changes every frame a scroll
        // is in flight, and a grid that reached only as far as the last zoom would leave the
        // edges of the frame bare.
        const reach = orthoHalfHeight(this.host.orthoCamera.zoom) * ORTHO_GRID_REACH;
        this.grid.setFade(reach * 0.85, reach);
        this.grid.update(this.camera, orbit.target);
      } else {
        this.grid.update(this.camera);
      }
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
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.releasePointerLock();
    this.gizmo.dispose();
    this.outline.dispose();
    this.sceneGizmos.dispose();
    this.grid.dispose();
    this.stress?.dispose();
    this.orbit.dispose();
    this.orbit2D.dispose();
    this.host.dispose();
    this.canvas.remove();
  }
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

/**
 * Whether any character in the scene is set up to be steered by the mouse.
 *
 * Capturing the pointer is not free — the cursor disappears and Escape is spent getting it back
 * — so a scene that does not want mouse look should not pay for it. A top-down game where the
 * pointer aims rather than steers is the case this protects: untick Mouse Look on its character
 * and the cursor stays where the player can see it.
 */
function sceneWantsMouseLook(scene: Scene): boolean {
  return scene
    .all()
    .some((entity) =>
      entity.components.some(
        (component): component is CharacterControllerComponent =>
          component.type === 'CharacterController' &&
          (component as CharacterControllerComponent).mouseLook,
      ),
    );
}

/**
 * A 3× phone screen renders nine times the pixels of a 1× one for a difference almost nobody
 * can see, so the cap is the first thing to reach for on mobile — and unlike resolution scale
 * it costs nothing in sharpness until it actually bites.
 */
function pixelRatioFor(cap: number): number {
  return Math.min(window.devicePixelRatio || 1, cap);
}
