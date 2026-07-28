import * as THREE from 'three';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { TONE_MAPPING_FUNCTIONS, type ToneMappingMode } from './GraphicsSettings';

/**
 * Offscreen resolve chain: multisampling, FXAA, tone mapping and the sRGB encode.
 *
 * ### Why the scene is not simply drawn to the canvas
 *
 * The obvious way to get MSAA in WebGL is the context's `antialias: true` flag. It works, and
 * it is a dead end: the flag is fixed when the context is created, so an antialiasing setting
 * built on it can only ever be applied on reload — and a reload drops every GPU resource the
 * editor has uploaded. Rendering into a multisampled *render target* instead makes the sample
 * count an ordinary runtime value, and hands us the intermediate buffer that FXAA needs anyway.
 *
 * ### Why tone mapping has to be done here
 *
 * Three only applies `renderer.toneMapping` and the output colour-space encode when it is
 * drawing to the canvas — see `WebGLPrograms`, which forces `NoToneMapping` and the linear
 * working space for every render-target draw. That is correct (an intermediate buffer should
 * stay linear HDR), but it means the moment the scene goes through a render target, the last
 * pass owns tone mapping. This one does, and it does it by including Three's own
 * `tonemapping_pars_fragment` chunk rather than reimplementing the curves — the direct path and
 * the post path therefore run the *same* code, and cannot drift.
 *
 * ### Pass order
 *
 * scene → HDR linear target (multisampled) → resolve (tone map + sRGB) → FXAA → canvas.
 *
 * FXAA runs *after* the encode on purpose: it thresholds on luma, and luma computed from linear
 * radiance under-detects edges in shadow and over-detects them in highlights. The extra LDR
 * buffer that costs is only allocated when FXAA is actually on.
 */

const RESOLVE_VERTEX = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * `sRGBTransferOETF` and the tone-mapping functions both come from Three's shader chunks.
 *
 * `colorspace_pars_fragment` is prepended to every non-raw fragment shader by `WebGLProgram`,
 * so `sRGBTransferOETF` is already in scope and including it again would be a redefinition.
 * The tone-mapping chunk is only prepended when the material is tone-mapped, which this one
 * deliberately is not — it applies the curve itself, so letting Three apply a second one would
 * double it.
 */
const RESOLVE_FRAGMENT = /* glsl */ `
${THREE.ShaderChunk.tonemapping_pars_fragment}

uniform sampler2D tDiffuse;
varying vec2 vUv;

void main() {
  vec4 texel = texture2D(tDiffuse, vUv);
  #ifdef TONE_MAPPING_FUNCTION
    texel.rgb = TONE_MAPPING_FUNCTION(texel.rgb);
  #endif
  gl_FragColor = sRGBTransferOETF(texel);
}
`;

export interface PostProcessConfig {
  /** MSAA samples for the scene buffer. Zero means a single-sampled buffer. */
  samples: number;
  fxaa: boolean;
  toneMapping: ToneMappingMode;
}

export class PostProcess {
  private samples = 0;
  private fxaa = false;
  private toneMapping: ToneMappingMode = 'none';

  private sceneTarget: THREE.WebGLRenderTarget | null = null;
  private ldrTarget: THREE.WebGLRenderTarget | null = null;

  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly resolveMaterial: THREE.ShaderMaterial;
  private readonly fxaaMaterial: THREE.ShaderMaterial;

  private width = 0;
  private height = 0;
  /** `null` until the first frame has a renderer to ask about float render targets. */
  private floatTargets: boolean | null = null;
  private readonly bufferSize = new THREE.Vector2();

  constructor() {
    this.resolveMaterial = new THREE.ShaderMaterial({
      name: 'PostResolve',
      vertexShader: RESOLVE_VERTEX,
      fragmentShader: RESOLVE_FRAGMENT,
      uniforms: { tDiffuse: { value: null } },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      // See RESOLVE_FRAGMENT: the shader tone maps itself.
      toneMapped: false,
    });

    this.fxaaMaterial = new THREE.ShaderMaterial({
      name: 'PostFXAA',
      vertexShader: FXAAShader.vertexShader,
      fragmentShader: FXAAShader.fragmentShader,
      uniforms: THREE.UniformsUtils.clone(FXAAShader.uniforms),
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      // Its input is already encoded — anything applied here would be applied twice.
      toneMapped: false,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.resolveMaterial);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** True when the scene has to be drawn through the offscreen buffer. */
  get enabled(): boolean {
    return this.samples > 0 || this.fxaa;
  }

  configure(config: PostProcessConfig): void {
    const samples = Math.max(0, Math.floor(config.samples));
    if (samples !== this.samples) {
      this.samples = samples;
      // Sample count is baked into the renderbuffer, so the target has to be rebuilt.
      this.disposeSceneTarget();
    }

    if (config.fxaa !== this.fxaa) {
      this.fxaa = config.fxaa;
      if (!this.fxaa) this.disposeLdrTarget();
    }

    if (config.toneMapping !== this.toneMapping) {
      const wasHdr = this.wantsFloat(this.toneMapping);
      this.toneMapping = config.toneMapping;
      const fn = TONE_MAPPING_FUNCTIONS[config.toneMapping];
      this.resolveMaterial.defines = fn ? { TONE_MAPPING_FUNCTION: fn } : {};
      this.resolveMaterial.needsUpdate = true;
      if (this.wantsFloat(this.toneMapping) !== wasHdr) this.disposeSceneTarget();
    }
  }

  /**
   * The buffer the scene pass should draw into, or `null` to draw straight to the canvas.
   *
   * Sized from the renderer's drawing buffer on every call rather than from a pushed-in width
   * and height: the resolution-scale lever changes the drawing buffer without changing the
   * canvas, and a target that missed that change would be silently upscaled twice.
   */
  sceneRenderTarget(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget | null {
    if (!this.enabled) return null;

    renderer.getDrawingBufferSize(this.bufferSize);
    const width = Math.max(1, Math.floor(this.bufferSize.x));
    const height = Math.max(1, Math.floor(this.bufferSize.y));
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.sceneTarget?.setSize(width, height);
      this.ldrTarget?.setSize(width, height);
    }

    if (!this.sceneTarget) {
      this.sceneTarget = new THREE.WebGLRenderTarget(width, height, {
        type: this.floatSupported(renderer) && this.wantsFloat(this.toneMapping)
          ? THREE.HalfFloatType
          : THREE.UnsignedByteType,
        samples: this.samples,
        depthBuffer: true,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
      });
      // Raw values in, raw values out: this buffer holds linear radiance, and the resolve pass
      // is what converts it. Letting Three tag it sRGB would apply a second conversion on read.
      this.sceneTarget.texture.colorSpace = THREE.NoColorSpace;
      this.sceneTarget.texture.name = 'PostSceneTarget';
    }
    return this.sceneTarget;
  }

  /**
   * Runs the resolve chain and leaves the canvas bound.
   *
   * A no-op when disabled, so the caller can invoke it unconditionally and the direct path
   * costs nothing but a boolean test.
   */
  present(renderer: THREE.WebGLRenderer): void {
    if (!this.enabled || !this.sceneTarget) {
      renderer.setRenderTarget(null);
      return;
    }

    const resolveTarget = this.fxaa ? this.ensureLdrTarget() : null;
    this.resolveMaterial.uniforms.tDiffuse!.value = this.sceneTarget.texture;
    this.quad.material = this.resolveMaterial;
    renderer.setRenderTarget(resolveTarget);
    renderer.render(this.quadScene, this.quadCamera);

    if (resolveTarget) {
      this.fxaaMaterial.uniforms.tDiffuse!.value = resolveTarget.texture;
      (this.fxaaMaterial.uniforms.resolution!.value as THREE.Vector2).set(
        1 / this.width,
        1 / this.height,
      );
      this.quad.material = this.fxaaMaterial;
      renderer.setRenderTarget(null);
      renderer.render(this.quadScene, this.quadCamera);
    }

    renderer.setRenderTarget(null);
  }

  private ensureLdrTarget(): THREE.WebGLRenderTarget {
    if (!this.ldrTarget) {
      // Eight bits per channel is enough here and deliberately so — the values are already
      // tone-mapped and encoded, and FXAA reads them as display colours.
      this.ldrTarget = new THREE.WebGLRenderTarget(this.width, this.height, {
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
      });
      this.ldrTarget.texture.colorSpace = THREE.NoColorSpace;
      this.ldrTarget.texture.name = 'PostLdrTarget';
    }
    return this.ldrTarget;
  }

  /** Only a tone-mapped image has anything above white to preserve. */
  private wantsFloat(mode: ToneMappingMode): boolean {
    return mode !== 'none';
  }

  /**
   * Half-float colour buffers are near-universal but not guaranteed, and a target the driver
   * cannot allocate is a black viewport rather than a warning. Fall back to 8-bit instead:
   * highlights clip earlier, which is a far smaller problem than not rendering.
   */
  private floatSupported(renderer: THREE.WebGLRenderer): boolean {
    if (this.floatTargets === null) {
      this.floatTargets = renderer.extensions.has('EXT_color_buffer_float');
    }
    return this.floatTargets;
  }

  private disposeSceneTarget(): void {
    this.sceneTarget?.dispose();
    this.sceneTarget = null;
  }

  private disposeLdrTarget(): void {
    this.ldrTarget?.dispose();
    this.ldrTarget = null;
  }

  dispose(): void {
    this.disposeSceneTarget();
    this.disposeLdrTarget();
    this.quad.geometry.dispose();
    this.resolveMaterial.dispose();
    this.fxaaMaterial.dispose();
  }
}
