import * as THREE from 'three';
import type { EnvironmentComponent } from '../components/Environment';

/**
 * Procedural gradient sky.
 *
 * A mesh rather than `scene.background`, for the same reason the editor's grid is a shader
 * rather than a `GridHelper` (ARCHITECTURE.md §9.6): a background texture would have to be
 * *generated*, and generating one means a canvas, and the engine is not allowed to touch the
 * DOM. Three lines of GLSL and an inverted sphere cost nothing, resize for free, and keep the
 * whole thing inside the "runs in a worker" constraint.
 *
 * The dome follows the camera and never writes depth, so it is always behind everything
 * regardless of how far the far plane is.
 */
export class SkyDome {
  readonly mesh: THREE.Mesh;

  private material: THREE.ShaderMaterial;
  private geometry: THREE.SphereGeometry;

  constructor() {
    this.geometry = new THREE.SphereGeometry(1, 24, 16);
    this.material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color('#3f6fb5') },
        horizonColor: { value: new THREE.Color('#cfd9e6') },
        groundColor: { value: new THREE.Color('#3a3630') },
      },
      vertexShader: `
        varying vec3 vDirection;
        void main() {
          vDirection = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      /**
       * The two includes at the end are not optional decoration.
       *
       * `Color.set('#3f6fb5')` converts the authored sRGB value into the linear working space,
       * so a shader that writes it out untouched hands the framebuffer linear numbers that the
       * display then reads as sRGB — the sky came out visibly dark and desaturated, and the
       * further a colour was from grey the more wrong it looked. Three's built-in materials end
       * with these same two chunks; a ShaderMaterial has to ask for them.
       *
       * Both resolve per render target: drawing to the canvas they tone map and encode, drawing
       * into the antialiasing buffer they compile away to nothing, because the resolve pass does
       * it once for the whole image instead. That is what keeps the sky matching the geometry
       * beside it whether or not antialiasing is on.
       */
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        uniform vec3 groundColor;
        varying vec3 vDirection;
        void main() {
          float h = normalize(vDirection).y;
          // Different exponents above and below: the sky gradient is soft and the ground
          // meets the horizon quickly, which is what stops the seam reading as a hard line.
          vec3 colour = h > 0.0
            ? mix(horizonColor, topColor, pow(clamp(h, 0.0, 1.0), 0.55))
            : mix(horizonColor, groundColor, pow(clamp(-h, 0.0, 1.0), 0.35));
          gl_FragColor = vec4(colour, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'SkyDome';
    // Drawn first, and never culled — it is always exactly around the camera.
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  setColors(top: string, horizon: string, ground: string): void {
    (this.material.uniforms.topColor!.value as THREE.Color).set(top);
    (this.material.uniforms.horizonColor!.value as THREE.Color).set(horizon);
    (this.material.uniforms.groundColor!.value as THREE.Color).set(ground);
  }

  /** Keeps the dome centred on the camera and comfortably inside its far plane. */
  update(camera: THREE.PerspectiveCamera): void {
    const radius = Math.max(camera.far * 0.5, 10);
    this.mesh.matrix.makeScale(radius, radius, radius);
    this.mesh.matrix.setPosition(camera.position);
    this.mesh.matrixWorldNeedsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Applies fog settings to a Three scene. Returns the fog it set, if any. */
export function applyFog(scene: THREE.Scene, environment: EnvironmentComponent): void {
  switch (environment.fog) {
    case 'Linear':
      scene.fog = new THREE.Fog(
        new THREE.Color(environment.fogColor),
        environment.fogNear,
        environment.fogFar,
      );
      break;
    case 'Exponential':
      scene.fog = new THREE.FogExp2(new THREE.Color(environment.fogColor), environment.fogDensity);
      break;
    case 'None':
    default:
      scene.fog = null;
      break;
  }
}
