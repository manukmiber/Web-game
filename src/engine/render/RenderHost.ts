import * as THREE from 'three';
import type { CameraComponent } from '../components/Camera';
import type { EnvironmentComponent } from '../components/Environment';
import type { FrameStats } from '../perf/FrameStats';
import type { Scene } from '../scene/Scene';
import type { EntityId } from '../scene/types';
import { RenderBridge } from './RenderBridge';
import { SkyDome, applyFog } from './environment';

export const SHADING_MODES = ['shaded', 'wireframe', 'shadedWireframe'] as const;
export type ShadingMode = (typeof SHADING_MODES)[number];

export interface RenderHostOptions {
  /**
   * Injected rather than created. Two reasons: the engine must not touch `document`
   * (ARCHITECTURE.md §9.5), and accepting an OffscreenCanvas is what makes a worker-side
   * renderer possible later without changing this class.
   */
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Device pixel ratio, passed in rather than read off a global. */
  pixelRatio?: number;
  antialias?: boolean;
  clearColor?: number;
  /** False once scenes carry their own Light components. */
  defaultLighting?: boolean;
  shadows?: boolean;
  /** The engine's FrameStats, so submit time lands in the same window as the frame time. */
  stats?: FrameStats;
}

/**
 * The renderer, camera and per-frame draw — shared by the editor and the game runtime.
 *
 * This exists because the two must render *identically*. Before it, the WebGLRenderer lived
 * inside the editor's ViewportController, which meant a runtime would have had to build its
 * own renderer and would have drifted from the editor immediately — exactly what
 * ARCHITECTURE.md §2 is written to prevent.
 *
 * What stays out of here: orbit controls, gizmos, grid, picking, selection. Those are editor
 * tools. The host offers an `overlay` scene and an `onAfterRender` hook, and the editor fills
 * them; a runtime leaves both untouched and pays nothing.
 */
export class RenderHost {
  readonly renderer: THREE.WebGLRenderer;
  /** The free-look camera. The editor drives it; Play mode renders through a scene camera. */
  readonly camera: THREE.PerspectiveCamera;
  /** Stand-in for whichever Camera entity is active. */
  readonly gameCamera: THREE.PerspectiveCamera;
  /** Scene contents projected from the entity data. */
  readonly scene = new THREE.Scene();
  readonly bridge: RenderBridge;

  /** Editor-only extras, drawn over the world with the same camera and depth buffer. */
  overlay: THREE.Scene | null = null;
  /** Extra passes after the main draw — the editor's axis indicator uses this. */
  onAfterRender: ((host: RenderHost) => void) | null = null;

  private width = 1;
  private height = 1;
  private basePixelRatio: number;
  private resolutionScale = 1;
  private keyLight: THREE.DirectionalLight | null = null;
  private stats: FrameStats | null;
  private shading: ShadingMode = 'shaded';
  private wireframeOverlay = new THREE.Group();

  private readonly engineScene: Scene;
  /** The placeholder rig, hidden the moment the scene has a Light component of its own. */
  private defaultLights = new THREE.Group();
  private ambient = new THREE.AmbientLight(0xffffff, 0);
  private sky: SkyDome | null = null;
  private clearColor: number;
  private activeCameraEntity: EntityId | null = null;
  private environmentDirty = false;
  private unsubscribes: (() => void)[] = [];

  constructor(engineScene: Scene, options: RenderHostOptions) {
    const {
      canvas,
      pixelRatio = 1,
      antialias = true,
      clearColor = 0x2b2b2b,
      defaultLighting = true,
      shadows = true,
      stats = null,
    } = options;

    this.stats = stats;
    this.engineScene = engineScene;
    this.clearColor = clearColor;

    this.basePixelRatio = pixelRatio;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias, alpha: false });
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setClearColor(clearColor);
    this.renderer.shadowMap.enabled = shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Overlay and extra passes draw over the main pass, so clearing is done explicitly once
    // per frame in render() rather than implicitly by each render call.
    this.renderer.autoClear = false;
    // Three resets its render counters at the start of every render() call, so with several
    // passes per frame the stats would only ever describe the last one. Reset once per frame
    // instead, and the numbers cover the whole frame.
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
    this.camera.position.set(8, 6, 10);
    this.gameCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);

    this.bridge = new RenderBridge(engineScene);
    this.scene.add(this.bridge.root);
    this.wireframeOverlay.name = 'WireframeOverlay';
    this.wireframeOverlay.visible = false;
    this.scene.add(this.wireframeOverlay);
    this.scene.add(this.ambient);

    if (defaultLighting) this.buildDefaultLighting();

    // The environment and the lighting fallback are both decided by what components exist, so
    // they resync on exactly the events that can change that.
    // Marked rather than applied: resolving the environment scans the scene, and a script
    // spawning a hundred entities in a frame would otherwise scan it a hundred times. The
    // flag collapses that to one scan before the next draw.
    const { events } = engineScene;
    const invalidate = () => {
      this.environmentDirty = true;
    };
    this.unsubscribes.push(
      events.on('componentsChanged', invalidate),
      events.on('entityAdded', invalidate),
      events.on('entityRemoved', invalidate),
      events.on('sceneReplaced', invalidate),
    );
    this.syncEnvironment();
  }

  // ------------------------------------------------------------ scene camera

  /**
   * Renders through a Camera entity instead of the free-look camera — this is what Play mode
   * flips. Returns false if the id has no camera, leaving the previous camera active.
   */
  setActiveCameraEntity(id: EntityId | null): boolean {
    if (id === null) {
      this.activeCameraEntity = null;
      return true;
    }
    const entity = this.engineScene.get(id);
    if (!entity?.components.some((c) => c.type === 'Camera')) return false;
    this.activeCameraEntity = id;
    this.syncGameCamera();
    return true;
  }

  getActiveCameraEntity(): EntityId | null {
    return this.activeCameraEntity;
  }

  /** Whichever camera the next `render()` will use. */
  get activeCamera(): THREE.PerspectiveCamera {
    return this.activeCameraEntity ? this.gameCamera : this.camera;
  }

  /**
   * Copies the camera entity's world pose onto the render camera.
   *
   * Position and rotation only: a camera parented under a scaled entity would otherwise
   * inherit that scale into its view matrix and quietly distort the projection. Decomposing
   * and dropping the scale is also why the camera is not just parented into the bridge's tree.
   */
  private syncGameCamera(): void {
    const id = this.activeCameraEntity;
    if (!id) return;
    const entity = this.engineScene.get(id);
    const object = this.bridge.objectFor(id);
    if (!entity || !object) {
      // The camera entity was deleted mid-play; fall back rather than freeze on a stale pose.
      this.activeCameraEntity = null;
      return;
    }

    object.updateMatrixWorld(true);
    object.matrixWorld.decompose(this.gameCamera.position, this.gameCamera.quaternion, SCRATCH);

    const component = entity.components.find((c): c is CameraComponent => c.type === 'Camera');
    if (component) {
      const aspect = this.height > 0 ? this.width / this.height : 1;
      if (
        this.gameCamera.fov !== component.fov ||
        this.gameCamera.near !== component.near ||
        this.gameCamera.far !== component.far ||
        this.gameCamera.aspect !== aspect
      ) {
        this.gameCamera.fov = component.fov;
        this.gameCamera.near = Math.max(0.001, component.near);
        this.gameCamera.far = Math.max(this.gameCamera.near + 1, component.far);
        this.gameCamera.aspect = aspect;
        this.gameCamera.updateProjectionMatrix();
      }
    }
  }

  // ------------------------------------------------------------- environment

  /**
   * Applies the scene's Environment component — background, ambient light and fog — and
   * decides whether the placeholder lighting rig is still needed.
   *
   * Both are "what does the scene say" questions rather than "what did the host decide", which
   * is the point of moving them into components: the runtime gets the same look as the editor
   * without being told anything.
   */
  syncEnvironment(): void {
    this.environmentDirty = false;
    const environment = findEnvironment(this.engineScene);

    // The scene's own lights win outright. A scene that has one Light and still gets the
    // built-in three would be impossible to light deliberately.
    this.defaultLights.visible = !this.bridge.hasLights();

    if (!environment) {
      // Enough fill to read shapes in an unlit scene, matching what the rig used to add.
      this.ambient.color.set(0xffffff);
      this.ambient.intensity = 0.35;
      this.scene.fog = null;
      this.renderer.setClearColor(this.clearColor);
      this.disposeSky();
      return;
    }

    this.ambient.color.set(environment.ambientColor);
    this.ambient.intensity = environment.ambientIntensity;
    applyFog(this.scene, environment);

    if (environment.background === 'Sky') {
      if (!this.sky) {
        this.sky = new SkyDome();
        this.scene.add(this.sky.mesh);
      }
      this.sky.setColors(
        environment.skyTopColor,
        environment.skyHorizonColor,
        environment.groundColor,
      );
    } else {
      this.disposeSky();
      this.renderer.setClearColor(new THREE.Color(environment.backgroundColor));
    }
  }

  private disposeSky(): void {
    if (!this.sky) return;
    this.sky.mesh.removeFromParent();
    this.sky.dispose();
    this.sky = null;
  }

  // -------------------------------------------------------------- dimensions

  /**
   * Told, not observed. Watching the element is the host page's job — ResizeObserver has no
   * worker equivalent, and keeping it out here is what lets this class move off-thread.
   */
  setSize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.gameCamera.aspect = width / height;
    this.gameCamera.updateProjectionMatrix();
  }

  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  setPixelRatio(pixelRatio: number): void {
    this.basePixelRatio = pixelRatio;
    this.applyPixelRatio();
  }

  /**
   * Renders at a fraction of the display resolution and lets the browser upscale.
   *
   * This is the single most effective quality lever in a browser — it scales fill rate
   * quadratically, and fill rate is the dominant cost on mobile GPUs. Stage 2's adaptive
   * quality reaches for this one first.
   */
  setResolutionScale(scale: number): void {
    const next = Math.max(0.25, Math.min(1, scale));
    if (next === this.resolutionScale) return;
    this.resolutionScale = next;
    this.applyPixelRatio();
    // The old regime's samples describe a different renderer; keeping them would smear the
    // before and after together and make the lever look weaker than it is.
    this.stats?.reset();
  }

  getResolutionScale(): number {
    return this.resolutionScale;
  }

  private applyPixelRatio(): void {
    this.renderer.setPixelRatio(this.basePixelRatio * this.resolutionScale);
    // setPixelRatio alone does not resize the drawing buffer; the size has to be re-applied.
    this.renderer.setSize(this.width, this.height, false);
  }

  // ------------------------------------------------------------------ frame

  /**
   * Draws one frame.
   *
   * The submit timer brackets every pass including the overlay, because from a budget point
   * of view the editor's gizmo and grid cost real milliseconds, and excluding them would make
   * the editor look faster than the runtime it is supposed to predict.
   */
  render(): void {
    this.renderer.info.reset();
    this.stats?.beginSubmit();

    if (this.environmentDirty) this.syncEnvironment();
    this.syncGameCamera();
    const camera = this.activeCamera;
    this.sky?.update(camera);

    this.renderer.clear();
    this.renderer.setViewport(0, 0, this.width, this.height);
    this.renderer.render(this.scene, camera);
    if (this.overlay) this.renderer.render(this.overlay, camera);
    this.onAfterRender?.(this);
    // Extra passes are free to move the viewport; restore it so the next frame starts clean.
    this.renderer.setViewport(0, 0, this.width, this.height);

    this.stats?.endSubmit(this.renderer);
  }

  // ---------------------------------------------------------------- lighting

  /**
   * Placeholder rig until scenes carry Light components.
   *
   * The shadow frustum is deliberately small. A single shadow camera stretched over a large
   * world has no usable resolution anywhere; cascades arrive with the streaming work.
   */
  private buildDefaultLighting(): void {
    // Ambient is not part of the rig: it is owned by the Environment component (or its
    // fallback) so a scene that adds one directional Light of its own still gets fill.
    this.scene.add(this.defaultLights);

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(12, 20, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const extent = 30;
    key.shadow.camera.left = -extent;
    key.shadow.camera.right = extent;
    key.shadow.camera.top = extent;
    key.shadow.camera.bottom = -extent;
    key.shadow.camera.far = 120;
    key.shadow.bias = -0.0005;
    this.defaultLights.add(key);
    this.keyLight = key;

    const fill = new THREE.DirectionalLight(0x8fb3ff, 0.3);
    fill.position.set(-10, 8, -12);
    this.defaultLights.add(fill);
  }

  /**
   * Viewport shading. Wireframe is not decoration — with a modifier stack it is the only way
   * to see what subdivision actually did to the topology, and where a deformer is stretching
   * faces thin.
   *
   * `shadedWireframe` draws edges over the solid surface, which is how Blender and C4D show
   * topology in context. Built by walking the rendered meshes rather than the source mesh
   * data, so it reflects the post-modifier result.
   */
  setShadingMode(mode: ShadingMode): void {
    if (mode === this.shading) return;
    this.shading = mode;
    this.applyShading();
    this.stats?.reset();
  }

  getShadingMode(): ShadingMode {
    return this.shading;
  }

  /** Re-applies shading. Call after the scene changes, since new meshes need the treatment. */
  applyShading(): void {
    const solidVisible = this.shading !== 'wireframe';
    this.bridge.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) mesh.visible = solidVisible && mesh.userData.entityVisible !== false;
    });

    this.rebuildWireframe();
    this.wireframeOverlay.visible = this.shading !== 'shaded';
  }

  private rebuildWireframe(): void {
    for (const child of [...this.wireframeOverlay.children]) {
      child.removeFromParent();
      const line = child as THREE.LineSegments;
      line.geometry?.dispose();
    }
    if (this.shading === 'shaded') return;

    const material = new THREE.LineBasicMaterial({
      color: this.shading === 'wireframe' ? 0x9ad0ff : 0x000000,
      transparent: true,
      opacity: this.shading === 'wireframe' ? 0.9 : 0.28,
    });

    this.bridge.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const lines = new THREE.LineSegments(new THREE.WireframeGeometry(mesh.geometry), material);
      // Match the mesh's world transform without reparenting it out of the bridge's tree.
      mesh.updateMatrixWorld(true);
      lines.matrixAutoUpdate = false;
      lines.matrix.copy(mesh.matrixWorld);
      this.wireframeOverlay.add(lines);
    });
  }

  /** Shadow quality tier, driven by adaptive quality in Stage 2. */
  setShadowsEnabled(enabled: boolean): void {
    if (this.renderer.shadowMap.enabled === enabled) return;
    this.renderer.shadowMap.enabled = enabled;
    this.stats?.reset();
    if (this.keyLight) this.keyLight.castShadow = enabled;
    // Materials compiled against the old shadow state have to be rebuilt.
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.material) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        material.needsUpdate = true;
      }
    });
  }

  setShadowMapSize(size: number): void {
    if (!this.keyLight) return;
    this.keyLight.shadow.mapSize.set(size, size);
    // Dropping the existing map forces Three to allocate one at the new size.
    this.keyLight.shadow.map?.dispose();
    this.keyLight.shadow.map = null;
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    this.setShadingMode('shaded');
    this.disposeSky();
    this.bridge.dispose();
    this.renderer.dispose();
    this.onAfterRender = null;
    this.overlay = null;
  }
}

/** Scratch for matrix decomposition — the scale component is read and thrown away. */
const SCRATCH = new THREE.Vector3();

function findEnvironment(scene: Scene): EnvironmentComponent | null {
  for (const entity of scene.all()) {
    const component = entity.components.find(
      (c): c is EnvironmentComponent => c.type === 'Environment',
    );
    if (component) return component;
  }
  return null;
}
