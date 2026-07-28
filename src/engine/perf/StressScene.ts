import * as THREE from 'three';
import { xorshift32 } from '../core/random';

export type StressPreset = 'forest' | 'city';

export interface StressParams {
  preset: StressPreset;
  /** Half-extent of the generated area, metres. Content fills a square of 2x this. */
  extent: number;
  /** Objects per 100 m². Scaled by the quality system's instance density later. */
  density: number;
  /** How many distinct meshes exist. This is the memory axis, separate from instance count. */
  uniqueMeshes: number;
  /** Draw everything as one InstancedMesh per prototype, versus one Mesh per object. */
  instanced: boolean;
  /** Objects beyond this distance from the origin are not generated at all. */
  renderDistance: number;
  seed: number;
}

export const FOREST_PRESET: StressParams = {
  preset: 'forest',
  extent: 400,
  density: 0.8,
  uniqueMeshes: 6,
  instanced: true,
  renderDistance: 400,
  seed: 1,
};

export const CITY_PRESET: StressParams = {
  preset: 'city',
  extent: 400,
  density: 0.12,
  uniqueMeshes: 120,
  instanced: false,
  renderDistance: 400,
  seed: 2,
};

/** How far under y = 0 the harness ground sits, in metres. See where it is built. */
const HARNESS_GROUND_DROP = 0.002;

export interface StressStats {
  objects: number;
  instances: number;
  uniqueGeometries: number;
  /** Draw calls this scene should cost, before culling. */
  expectedDrawCalls: number;
  triangles: number;
}

/**
 * Builds the two load shapes the engine has to survive, so the budget can be measured
 * instead of argued about.
 *
 * They are deliberately opposites, because they fail for different reasons:
 *
 * - **forest** — a great many instances of very few unique meshes. Instancing carries it;
 *   occlusion culling does almost nothing because everything is visible at once. This is the
 *   shape a zombie-survival landscape takes.
 * - **city** — many *unique* meshes at lower counts. Instancing barely helps, memory is the
 *   pressure, and buildings occlude each other heavily so occlusion culling is the win.
 *
 * An engine has to serve both. Tuning against only one produces a renderer that collapses on
 * the other, which is exactly the trap this harness exists to avoid.
 */
export class StressScene {
  readonly root = new THREE.Group();

  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.Material[] = [];
  private stats: StressStats = {
    objects: 0,
    instances: 0,
    uniqueGeometries: 0,
    expectedDrawCalls: 0,
    triangles: 0,
  };

  constructor(params: StressParams = FOREST_PRESET) {
    this.root.name = 'StressScene';
    this.build(params);
  }

  getStats(): StressStats {
    return { ...this.stats };
  }

  /** Tears down and regenerates. Called whenever a harness slider moves. */
  rebuild(params: StressParams): void {
    this.clear();
    this.build(params);
  }

  private build(params: StressParams): void {
    const random = xorshift32(params.seed);
    const prototypes = this.buildPrototypes(params, random);

    // Area covered, converted from "objects per 100 m²" to an absolute count.
    const area = (params.extent * 2) ** 2;
    const target = Math.max(1, Math.round((area / 100) * params.density));

    const placements: THREE.Matrix4[][] = prototypes.map(() => []);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i < target; i += 1) {
      const x = (random() * 2 - 1) * params.extent;
      const z = (random() * 2 - 1) * params.extent;
      if (Math.hypot(x, z) > params.renderDistance) continue;

      const index = Math.floor(random() * prototypes.length) % prototypes.length;
      const proto = prototypes[index]!;
      const uniformScale = 0.7 + random() * 0.8;

      position.set(x, (proto.height * uniformScale) / 2, z);
      quaternion.setFromAxisAngle(up, random() * Math.PI * 2);
      scale.setScalar(uniformScale);
      placements[index]!.push(matrix.compose(position, quaternion, scale).clone());
    }

    let objects = 0;
    let triangles = 0;
    let drawCalls = 0;

    for (const [index, proto] of prototypes.entries()) {
      const matrices = placements[index]!;
      if (matrices.length === 0) continue;
      const trianglesEach = triangleCount(proto.geometry);

      if (params.instanced) {
        const mesh = new THREE.InstancedMesh(proto.geometry, proto.material, matrices.length);
        for (const [i, m] of matrices.entries()) mesh.setMatrixAt(i, m);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.root.add(mesh);
        drawCalls += 1;
      } else {
        for (const m of matrices) {
          const mesh = new THREE.Mesh(proto.geometry, proto.material);
          mesh.applyMatrix4(m);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          this.root.add(mesh);
        }
        drawCalls += matrices.length;
      }

      objects += matrices.length;
      triangles += trianglesEach * matrices.length;
    }

    /**
     * Ground, so shadows land on something and fill rate is realistic.
     *
     * Sunk just below y = 0 rather than sitting on it. Scenes authored in this editor put their
     * own ground plane at exactly zero, and two coplanar shadow-receiving planes z-fight — which
     * on a shadowed surface reads as a second, flickering copy of every shadow. A millimetre of
     * separation is invisible and settles the depth test.
     */
    const groundGeometry = new THREE.PlaneGeometry(params.extent * 2, params.extent * 2);
    groundGeometry.rotateX(-Math.PI / 2);
    groundGeometry.translate(0, -HARNESS_GROUND_DROP, 0);
    const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x4a5548, roughness: 1 });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.receiveShadow = true;
    this.root.add(ground);
    this.geometries.push(groundGeometry);
    this.materials.push(groundMaterial);

    this.stats = {
      objects,
      instances: params.instanced ? objects : 0,
      uniqueGeometries: prototypes.length,
      expectedDrawCalls: drawCalls + 1,
      triangles: triangles + 2,
    };
  }

  private buildPrototypes(
    params: StressParams,
    random: () => number,
  ): { geometry: THREE.BufferGeometry; material: THREE.Material; height: number }[] {
    const out: { geometry: THREE.BufferGeometry; material: THREE.Material; height: number }[] = [];

    for (let i = 0; i < params.uniqueMeshes; i += 1) {
      let geometry: THREE.BufferGeometry;
      let height: number;

      if (params.preset === 'forest') {
        // Cone on a trunk: low poly, tall, and thin — poor occluders, which is the point.
        height = 4 + random() * 6;
        geometry = new THREE.ConeGeometry(1 + random(), height, 6 + Math.floor(random() * 4));
      } else {
        // Boxy blocks: heavy occluders, and each one a distinct geometry so the memory and
        // draw-call cost of unique meshes is what gets measured.
        height = 6 + random() * 30;
        geometry = new THREE.BoxGeometry(6 + random() * 8, height, 6 + random() * 8);
      }

      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(random(), params.preset === 'forest' ? 0.4 : 0.1, 0.45),
        roughness: 0.85,
      });

      this.geometries.push(geometry);
      this.materials.push(material);
      out.push({ geometry, material, height });
    }

    return out;
  }

  private clear(): void {
    this.root.clear();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries = [];
    this.materials = [];
  }

  dispose(): void {
    this.clear();
    this.root.removeFromParent();
  }
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  if (index) return index.count / 3;
  const position = geometry.getAttribute('position');
  return position ? position.count / 3 : 0;
}
