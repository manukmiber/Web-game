import * as THREE from 'three';

/**
 * Written in the GLSL 1 dialect even though everything compiles as `#version 300 es`.
 *
 * Three rewrites `varying` and `texture2D` for non-raw ShaderMaterials and, crucially, declares
 * the fragment output as `gl_FragColor` itself — which is what its colour-space and tone-mapping
 * chunks are written against. Authoring this as GLSL 3 meant declaring a private `out` that
 * those chunks could not see, and the only way to bridge that is a `#define` of a `gl_`-prefixed
 * name, which the GLSL preprocessor spec reserves. Derivatives (`fwidth`) are core either way.
 */
const VERTEX = /* glsl */ `
varying vec3 vWorldPosition;

void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

const FRAGMENT = /* glsl */ `
varying vec3 vWorldPosition;

uniform vec3 uCameraPosition;
uniform float uCellSize;
uniform float uSectionSize;
uniform vec3 uCellColor;
uniform vec3 uSectionColor;
uniform vec3 uAxisXColor;
uniform vec3 uAxisZColor;
uniform float uFadeStart;
uniform float uFadeEnd;

// Coverage of the nearest grid line, measured in screen space via derivatives. Using fwidth
// rather than a fixed width is what keeps lines one pixel wide at every distance and zoom,
// instead of aliasing into noise when the camera pulls back over a large world.
float lineCoverage(vec2 worldXZ, float spacing) {
  vec2 coord = worldXZ / spacing;
  vec2 derivative = fwidth(coord);
  vec2 distanceToLine = abs(fract(coord - 0.5) - 0.5) / max(derivative, vec2(1e-6));
  return 1.0 - min(min(distanceToLine.x, distanceToLine.y), 1.0);
}

void main() {
  vec2 worldXZ = vWorldPosition.xz;
  float cameraDistance = length(vWorldPosition - uCameraPosition);

  float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, cameraDistance);
  if (fade <= 0.001) discard;

  // Fine cells drop out well before the sections do, so a distant view shows a readable
  // 10 m lattice instead of a solid wash of 1 m lines.
  float cellFade = 1.0 - smoothstep(uFadeStart * 0.10, uFadeStart * 0.55, cameraDistance);

  float cell = lineCoverage(worldXZ, uCellSize) * 0.5 * cellFade;
  float section = lineCoverage(worldXZ, uSectionSize) * 0.8;

  vec3 color = uCellColor;
  float alpha = cell;
  if (section > alpha) {
    color = uSectionColor;
    alpha = section;
  }

  // World axes, drawn last so they win over both line weights.
  vec2 axisDistance = abs(worldXZ) / max(fwidth(worldXZ), vec2(1e-6));
  if (axisDistance.y < 1.0) {
    color = uAxisXColor;
    alpha = max(alpha, 1.0 - axisDistance.y);
  }
  if (axisDistance.x < 1.0) {
    color = uAxisZColor;
    alpha = max(alpha, 1.0 - axisDistance.x);
  }

  alpha *= fade;
  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(color, alpha);
  // Same reason as the sky dome: the uniforms are linear, the framebuffer is not. Without the
  // encode the grid drew far darker than the colour it was authored with, and the axis lines
  // in particular lost most of their tint.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface GroundGridOptions {
  cellSize?: number;
  sectionSize?: number;
  fadeStart?: number;
  fadeEnd?: number;
}

/**
 * Procedural ground grid.
 *
 * Drawn as a single camera-following quad with the lines computed per fragment, rather than
 * as GridHelper line geometry. Three reasons, in order of importance:
 *
 * 1. It has no extent. A 25 km world (ARCHITECTURE.md §9) would need either a grid mesh
 *    sized for the whole map — millions of wasted vertices — or one that gets rebuilt as the
 *    camera travels. This one is two triangles wherever the camera happens to be.
 * 2. Screen-space derivatives keep lines exactly one pixel wide at any distance or zoom,
 *    where line geometry aliases into moiré as soon as the camera pulls back.
 * 3. Long line primitives are fragile: the software rasterizer used in headless Chromium
 *    drops line segments that need frustum clipping once their endpoints are far enough
 *    apart, which makes a large GridHelper vanish entirely. Triangles are unaffected.
 */
export class GroundGrid {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;

  constructor(options: GroundGridOptions = {}) {
    const {
      cellSize = 1,
      sectionSize = 10,
      fadeStart = 60,
      fadeEnd = 260,
    } = options;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      // Depth-tested so scene geometry occludes the grid, but never written, so the grid
      // can't occlude anything itself.
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uCameraPosition: { value: new THREE.Vector3() },
        uCellSize: { value: cellSize },
        uSectionSize: { value: sectionSize },
        uCellColor: { value: new THREE.Color(0x595959) },
        uSectionColor: { value: new THREE.Color(0x8c8c8c) },
        uAxisXColor: { value: new THREE.Color(0xc4564f) },
        uAxisZColor: { value: new THREE.Color(0x4a7fd4) },
        uFadeStart: { value: fadeStart },
        uFadeEnd: { value: fadeEnd },
      },
    });

    // Sized to comfortably exceed the fade radius so its edges are never reachable.
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'GroundGrid';
    // It follows the camera, so a bounding-box cull test against its origin is meaningless.
    this.mesh.frustumCulled = false;
    // Slightly below zero so a ground Plane authored at y=0 wins the depth test cleanly.
    this.mesh.position.y = -0.002;
    this.mesh.renderOrder = -1;
    this.mesh.scale.setScalar(fadeEnd * 2.5);
  }

  /** Recentres the quad on the camera and refreshes the uniform used for distance fade. */
  update(camera: THREE.Camera): void {
    const cameraPosition = camera.getWorldPosition(
      this.material.uniforms.uCameraPosition!.value as THREE.Vector3,
    );
    // Snapping to the section size keeps the lattice from swimming as the quad follows the
    // camera — the shader derives lines from world position, so any drift would be visible.
    const section = this.material.uniforms.uSectionSize!.value as number;
    this.mesh.position.x = Math.round(cameraPosition.x / section) * section;
    this.mesh.position.z = Math.round(cameraPosition.z / section) * section;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
