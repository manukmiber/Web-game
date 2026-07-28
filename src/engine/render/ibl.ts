import * as THREE from 'three';
import type { EnvironmentComponent } from '../components/Environment';

/**
 * Image-based lighting from the scene's own sky.
 *
 * This is the piece without which a PBR material system is a lie. `metalness = 1` means "the base
 * colour is the *reflection* and there is no diffuse term" — so a metal with nothing to reflect is
 * black, and every chrome sphere in the engine came out as a dark blob no matter how many lights
 * were pointed at it. Analytic lights only give a metal its specular highlight; the rest of a
 * metal is the environment, and the environment has to be prefiltered per roughness level or a
 * rough metal reflects a sharp mirror image of the sky.
 *
 * `PMREMGenerator` does exactly that prefiltering, and the source is the same three-colour
 * gradient the `SkyDome` already draws — so a scene's reflections match its background because
 * they are generated from it, rather than because someone remembered to load a matching HDR.
 *
 * Regenerated only when the colours change. It is a handful of small render passes, but they are
 * render passes, and doing them per frame would show up in the frame graph.
 */
export class EnvironmentProbe {
  private target: THREE.WebGLRenderTarget | null = null;
  private generator: THREE.PMREMGenerator | null = null;
  private key: string | null = null;

  /**
   * The prefiltered environment for these sky colours, building it if needed.
   *
   * Returns null when the component has IBL turned off, which is the signal to clear
   * `scene.environment` — a flat-background scene has no environment to reflect, and reflecting
   * the *previous* sky would be worse than reflecting nothing.
   */
  resolve(renderer: THREE.WebGLRenderer, environment: EnvironmentComponent): THREE.Texture | null {
    if (!environment.ibl) {
      this.dispose();
      return null;
    }

    const key = [
      environment.skyTopColor,
      environment.skyHorizonColor,
      environment.groundColor,
      environment.background,
    ].join('|');
    if (this.target && this.key === key) return this.target.texture;

    this.disposeTarget();
    this.key = key;
    this.generator ??= new THREE.PMREMGenerator(renderer);

    const source = gradientScene(environment);
    // `fromScene` renders the source into a cubemap and then runs the roughness convolution
    // chain over it. The sigma is left at zero: the gradient is already smooth, and blurring a
    // smooth thing costs passes to change nothing.
    this.target = this.generator.fromScene(source, 0, 0.1, 100);
    disposeScene(source);
    return this.target.texture;
  }

  dispose(): void {
    this.disposeTarget();
    this.generator?.dispose();
    this.generator = null;
  }

  private disposeTarget(): void {
    this.target?.dispose();
    this.target = null;
    this.key = null;
  }
}

/**
 * An inside-out sphere carrying the sky gradient, for the probe to capture.
 *
 * A second, simpler shader than `SkyDome`'s rather than reusing it, and the difference is the
 * reason: the dome ends with the tone-mapping and colour-space chunks because it is drawn to the
 * screen, and this one must *not* — a prefiltered environment has to stay in linear radiance or
 * every reflection comes back tone mapped twice.
 */
function gradientScene(environment: EnvironmentComponent): THREE.Scene {
  const scene = new THREE.Scene();
  const geometry = new THREE.SphereGeometry(1, 32, 24);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color(environment.skyTopColor) },
      horizonColor: { value: new THREE.Color(environment.skyHorizonColor) },
      groundColor: { value: new THREE.Color(environment.groundColor) },
      intensity: { value: Math.max(0, environment.iblIntensity) },
    },
    vertexShader: `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 groundColor;
      uniform float intensity;
      varying vec3 vDirection;
      void main() {
        float h = normalize(vDirection).y;
        vec3 colour = h > 0.0
          ? mix(horizonColor, topColor, pow(clamp(h, 0.0, 1.0), 0.55))
          : mix(horizonColor, groundColor, pow(clamp(-h, 0.0, 1.0), 0.35));
        // No tone mapping and no sRGB encode here, unlike the SkyDome: this value is radiance
        // that materials will multiply, not a pixel that a display will read.
        gl_FragColor = vec4(colour * intensity, 1.0);
      }
    `,
  });
  scene.add(new THREE.Mesh(geometry, material));
  return scene;
}

function disposeScene(scene: THREE.Scene): void {
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) for (const m of material) m.dispose();
    else material?.dispose();
  });
}
