import * as THREE from 'three';
import type { Scene } from '../scene/Scene';
import { RenderBridge } from './RenderBridge';

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
  readonly camera: THREE.PerspectiveCamera;
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

  constructor(engineScene: Scene, options: RenderHostOptions) {
    const {
      canvas,
      pixelRatio = 1,
      antialias = true,
      clearColor = 0x2b2b2b,
      defaultLighting = true,
      shadows = true,
    } = options;

    this.basePixelRatio = pixelRatio;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias, alpha: false });
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setClearColor(clearColor);
    this.renderer.shadowMap.enabled = shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Overlay and extra passes draw over the main pass, so clearing is done explicitly once
    // per frame in render() rather than implicitly by each render call.
    this.renderer.autoClear = false;

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
    this.camera.position.set(8, 6, 10);

    this.bridge = new RenderBridge(engineScene);
    this.scene.add(this.bridge.root);

    if (defaultLighting) this.buildDefaultLighting();
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
    this.resolutionScale = Math.max(0.25, Math.min(1, scale));
    this.applyPixelRatio();
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

  render(): void {
    this.renderer.clear();
    this.renderer.setViewport(0, 0, this.width, this.height);
    this.renderer.render(this.scene, this.camera);
    if (this.overlay) this.renderer.render(this.overlay, this.camera);
    this.onAfterRender?.(this);
    // Extra passes are free to move the viewport; restore it so the next frame starts clean.
    this.renderer.setViewport(0, 0, this.width, this.height);
  }

  // ---------------------------------------------------------------- lighting

  /**
   * Placeholder rig until scenes carry Light components.
   *
   * The shadow frustum is deliberately small. A single shadow camera stretched over a large
   * world has no usable resolution anywhere; cascades arrive with the streaming work.
   */
  private buildDefaultLighting(): void {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));

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
    this.scene.add(key);
    this.keyLight = key;

    const fill = new THREE.DirectionalLight(0x8fb3ff, 0.3);
    fill.position.set(-10, 8, -12);
    this.scene.add(fill);
  }

  /** Shadow quality tier, driven by adaptive quality in Stage 2. */
  setShadowsEnabled(enabled: boolean): void {
    this.renderer.shadowMap.enabled = enabled;
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
    this.bridge.dispose();
    this.renderer.dispose();
    this.onAfterRender = null;
    this.overlay = null;
  }
}
