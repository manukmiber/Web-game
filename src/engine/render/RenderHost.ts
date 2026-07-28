import * as THREE from 'three';
import type { AssetStore } from '../assets/AssetStore';
import type { CameraComponent } from '../components/Camera';
import type { EnvironmentComponent } from '../components/Environment';
import type { FrameStats } from '../perf/FrameStats';
import type { Scene } from '../scene/Scene';
import type { EntityId } from '../scene/types';
import {
  DEFAULT_GRAPHICS,
  needsPostProcessing,
  normalizeGraphics,
  samplesFor,
  shadowMapSizeFor,
  shadowMapTypeFor,
  toneMappingFor,
  usesFxaa,
  VSM_SHADOW_BLUR_SAMPLES,
  VSM_SHADOW_RADIUS,
  type GraphicsSettings,
} from './GraphicsSettings';
import { PostProcess } from './PostProcess';
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
  clearColor?: number;
  /** False once scenes carry their own Light components. */
  defaultLighting?: boolean;
  /** Quality settings. Everything the image depends on lives in here — see GraphicsSettings. */
  graphics?: Partial<GraphicsSettings>;
  /** Needed only so texture filtering can follow the graphics settings. */
  assets?: AssetStore;
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
  /**
   * Owned rather than allocated per rebuild. Every line in a rebuild shares one material, and
   * the rebuild runs on every transform change while a wireframe mode is on — a fresh material
   * each time is a GPU allocation per frame of a gizmo drag that nothing ever disposes.
   */
  private wireframeMaterial: THREE.LineBasicMaterial | null = null;

  private readonly engineScene: Scene;
  /** The placeholder rig, hidden the moment the scene has a Light component of its own. */
  private defaultLights = new THREE.Group();
  private ambient = new THREE.AmbientLight(0xffffff, 0);
  private sky: SkyDome | null = null;
  private clearColor: number;
  private activeCameraEntity: EntityId | null = null;
  private environmentDirty = false;
  private unsubscribes: (() => void)[] = [];

  /** Antialiasing, tone mapping and the sRGB encode when the direct path can't do them. */
  private post = new PostProcess();
  private graphics: GraphicsSettings = { ...DEFAULT_GRAPHICS };
  private assets: AssetStore | null;
  /** Lights that were granted a shadow map by the last frame's budget. */
  private activeShadowCasters = 0;

  constructor(engineScene: Scene, options: RenderHostOptions) {
    const {
      canvas,
      pixelRatio = 1,
      clearColor = 0x2b2b2b,
      defaultLighting = true,
      graphics,
      assets = null,
      stats = null,
    } = options;

    this.stats = stats;
    this.engineScene = engineScene;
    this.clearColor = clearColor;
    this.assets = assets;

    this.basePixelRatio = pixelRatio;

    /**
     * `antialias: false` is not "no antialiasing".
     *
     * The context flag is immutable once the context exists, so building the setting on it
     * would mean a page reload — and a dropped GL context — every time someone changes it.
     * MSAA is done in an offscreen multisampled buffer instead (see PostProcess), which is
     * where FXAA and tone mapping need the image to be anyway.
     */
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setClearColor(clearColor);
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
    this.applyGraphics(normalizeGraphics(graphics));
  }

  // --------------------------------------------------------------- graphics

  getGraphics(): GraphicsSettings {
    return { ...this.graphics };
  }

  /**
   * Applies a whole settings object at once.
   *
   * One entry point rather than a setter per knob, because several of them interact: the shadow
   * map size means nothing without a shadow filter, and the tone mapping curve decides whether
   * the offscreen buffer needs to be half-float. A single apply keeps those decisions in one
   * readable place instead of spread across setters that have to guess at each other's state.
   *
   * Cheap to call with an unchanged object — every branch below is guarded — so callers can
   * simply push the current settings on any change rather than diffing first.
   */
  applyGraphics(settings: Partial<GraphicsSettings>): void {
    const next = normalizeGraphics({ ...this.graphics, ...settings });
    const previous = this.graphics;
    this.graphics = next;

    const shadowsEnabled = next.shadowQuality !== 'off';
    const shadowType = shadowMapTypeFor(next.shadowFilter);
    if (
      this.renderer.shadowMap.enabled !== shadowsEnabled ||
      this.renderer.shadowMap.type !== shadowType
    ) {
      this.renderer.shadowMap.enabled = shadowsEnabled;
      this.renderer.shadowMap.type = shadowType;
      // Shadow support is compiled into every lit material, so changing either of these means
      // the programs currently on the GPU are for the wrong configuration.
      this.invalidateMaterials();
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.applyDefaultShadowSettings();

    // Tone mapping and exposure are program parameters Three tracks itself, so materials
    // recompile on their own — unlike shadows above.
    this.renderer.toneMapping = toneMappingFor(next.toneMapping);
    this.renderer.toneMappingExposure = next.exposure;

    this.post.configure({
      samples: samplesFor(next.antialias),
      fxaa: usesFxaa(next.antialias),
      toneMapping: next.toneMapping,
    });

    if (next.resolutionScale !== this.resolutionScale) {
      this.resolutionScale = next.resolutionScale;
      this.applyPixelRatio();
    }

    // Clamped against the driver rather than the settings range: asking for 16× on a GPU that
    // caps at 4 is silently ignored by WebGL, and the panel would go on claiming 16×.
    this.assets?.setAnisotropy(
      Math.min(next.anisotropy, this.renderer.capabilities.getMaxAnisotropy()),
    );

    // Samples from before a quality change describe a different renderer; keeping them would
    // blend the two regimes together and make every lever look weaker than it is.
    if (
      previous.antialias !== next.antialias ||
      previous.shadowQuality !== next.shadowQuality ||
      previous.shadowFilter !== next.shadowFilter ||
      previous.maxShadowLights !== next.maxShadowLights ||
      previous.resolutionScale !== next.resolutionScale
    ) {
      this.stats?.reset();
    }
  }

  /** True when the frame is routed through the offscreen antialiasing buffer. */
  usesPostProcessing(): boolean {
    return needsPostProcessing(this.graphics.antialias);
  }

  /**
   * Shadow-casting lights the budget granted on the last frame, and how many asked.
   *
   * Reported rather than left implicit because a light silently losing its shadow is exactly
   * the kind of change that reads as a renderer bug. The Statistics panel shows "3 of 9", and
   * the answer to "why is my torch not casting" becomes visible instead of mysterious.
   */
  shadowBudget(): { active: number; requested: number; limit: number } {
    const summary = this.bridge.lightSummary();
    return {
      active: this.activeShadowCasters,
      requested: summary.requestedShadows,
      limit: this.graphics.maxShadowLights,
    };
  }

  private invalidateMaterials(): void {
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.material) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        material.needsUpdate = true;
      }
    });
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
    // Routed through the settings rather than written directly, so the value the panel shows
    // and the value the renderer is using cannot disagree.
    this.applyGraphics({ resolutionScale: scale });
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
   * The submit timer brackets every pass including the overlay and the resolve chain, because
   * from a budget point of view the editor's gizmo and grid cost real milliseconds and so does
   * antialiasing — excluding either would make the editor look faster than the runtime it is
   * supposed to predict.
   */
  render(): void {
    this.renderer.info.reset();
    this.stats?.beginSubmit();

    if (this.environmentDirty) this.syncEnvironment();
    this.syncGameCamera();
    const camera = this.activeCamera;
    this.sky?.update(camera);

    // Spent per frame rather than once, because which lights matter is a function of where the
    // camera is: walking towards a torch should let it take a shadow map from one behind you.
    this.activeShadowCasters =
      this.graphics.shadowQuality === 'off'
        ? 0
        : this.bridge.applyShadowBudget(this.graphics.maxShadowLights, [
            camera.position.x,
            camera.position.y,
            camera.position.z,
          ]);

    // Restored before binding a target, so `setRenderTarget(null)` at the end of the resolve
    // chain comes back to a full-size viewport rather than to whatever the last extra pass left.
    this.renderer.setViewport(0, 0, this.width, this.height);

    const target = this.post.sceneRenderTarget(this.renderer);
    this.renderer.setRenderTarget(target);
    this.renderer.clear();
    this.renderer.render(this.scene, camera);
    // Same depth buffer as the world pass, which is what lets the grid be occluded by geometry
    // while the selection outline draws over it.
    if (this.overlay) this.renderer.render(this.overlay, camera);

    // Resolves multisampling, tone maps and encodes, and leaves the canvas bound — so extra
    // passes below draw over the finished image whether or not antialiasing is on.
    this.post.present(this.renderer);
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
   * world has no usable resolution anywhere; cascades arrive with the streaming work. Its size
   * and resolution come from the graphics settings, applied by `applyDefaultShadowSettings`.
   */
  private buildDefaultLighting(): void {
    // Ambient is not part of the rig: it is owned by the Environment component (or its
    // fallback) so a scene that adds one directional Light of its own still gets fill.
    this.scene.add(this.defaultLights);

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(12, 20, 8);
    key.castShadow = true;
    key.shadow.bias = -0.0005;
    // Offsets the shadow lookup along the surface normal, which is what removes the acne on
    // curved and steeply-lit surfaces that depth bias alone can only trade for peter-panning.
    key.shadow.normalBias = 0.02;
    this.defaultLights.add(key);
    this.keyLight = key;

    const fill = new THREE.DirectionalLight(0x8fb3ff, 0.3);
    fill.position.set(-10, 8, -12);
    this.defaultLights.add(fill);
  }

  /** Pushes the shadow settings onto the placeholder sun. Scene lights carry their own. */
  private applyDefaultShadowSettings(): void {
    const key = this.keyLight;
    if (!key) return;

    const enabled = this.graphics.shadowQuality !== 'off';
    key.castShadow = enabled;
    if (!enabled) return;

    const size = shadowMapSizeFor(this.graphics.shadowQuality);
    if (key.shadow.mapSize.width !== size) {
      key.shadow.mapSize.set(size, size);
      // Three allocates a shadow map once; dropping it is what forces the new size.
      key.shadow.map?.dispose();
      key.shadow.map = null;
    }

    // Only VSM has a blur to configure; for the other filters the radius is inert, so it is set
    // to zero rather than left at a stale value from the last time soft shadows were on.
    const soft = this.graphics.shadowFilter === 'soft';
    key.shadow.radius = soft ? VSM_SHADOW_RADIUS : 0;
    key.shadow.blurSamples = soft ? VSM_SHADOW_BLUR_SAMPLES : 0;

    const extent = this.graphics.shadowDistance;
    const camera = key.shadow.camera;
    if (camera.right !== extent) {
      camera.left = -extent;
      camera.right = extent;
      camera.top = extent;
      camera.bottom = -extent;
      // Far has to reach the ground from wherever the rig's sun sits, and the shadow distance
      // is the only hint of world scale available here.
      camera.far = Math.max(120, extent * 6);
      camera.updateProjectionMatrix();
    }
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
    if (this.shading === 'shaded') {
      this.wireframeMaterial?.dispose();
      this.wireframeMaterial = null;
      return;
    }

    // Standalone wireframe reads as a bright line drawing; over a shaded surface it wants to be
    // a faint dark overlay, or it fights the material underneath it.
    const standalone = this.shading === 'wireframe';
    const material = (this.wireframeMaterial ??= new THREE.LineBasicMaterial({ transparent: true }));
    material.color.setHex(standalone ? 0x9ad0ff : 0x000000);
    material.opacity = standalone ? 0.9 : 0.28;

    this.bridge.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      // Hidden geometry has no wireframe: the overlay would otherwise be the one thing that
      // ignores the Visible checkbox. Instanced scatter is skipped for a different reason —
      // one WireframeGeometry would draw at the layer's origin, not at each instance.
      if (mesh.userData.entityVisible === false) return;
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) return;
      const lines = new THREE.LineSegments(new THREE.WireframeGeometry(mesh.geometry), material);
      // Match the mesh's world transform without reparenting it out of the bridge's tree.
      mesh.updateMatrixWorld(true);
      lines.matrixAutoUpdate = false;
      lines.matrix.copy(mesh.matrixWorld);
      this.wireframeOverlay.add(lines);
    });
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    this.setShadingMode('shaded');
    this.wireframeMaterial?.dispose();
    this.wireframeMaterial = null;
    this.disposeSky();
    this.post.dispose();
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
