import * as THREE from 'three';
import type { CameraComponent } from '@engine/components/Camera';
import type { LightComponent } from '@engine/components/Light';
import type { RenderBridge } from '@engine/render/RenderBridge';
import type { Scene } from '@engine/scene/Scene';
import type { EntityId } from '@engine/scene/types';

const LIGHT_COLOR = 0xffd050;
const CAMERA_COLOR = 0x7fd4ff;
/** Where the frustum and cone outlines are drawn to, in metres. Not the actual far plane. */
const GIZMO_REACH = 2;

interface GizmoEntry {
  id: EntityId;
  root: THREE.Group;
  /** The solid icon — also what a click picks, since lights and cameras have no mesh. */
  handle: THREE.Mesh;
}

/**
 * Viewport handles for entities that render nothing: lights and cameras.
 *
 * They have to exist, because an entity with only a Light component is invisible and
 * unclickable — you would be able to add a light and then have no way to select it again
 * except through the Hierarchy. The icon doubles as the pick target for exactly that reason.
 *
 * Lives in the editor's overlay scene, not the render bridge: a runtime must never draw these
 * (ARCHITECTURE.md §2), and putting them in the overlay is also what makes them vanish during
 * Play mode for free, since the overlay is detached while playing.
 */
export class SceneGizmos {
  readonly object = new THREE.Group();

  private entries: GizmoEntry[] = [];
  private iconGeometry = new THREE.OctahedronGeometry(0.18);
  private lightMaterial = new THREE.MeshBasicMaterial({ color: LIGHT_COLOR });
  private cameraMaterial = new THREE.MeshBasicMaterial({ color: CAMERA_COLOR });
  private lightLines = new THREE.LineBasicMaterial({ color: LIGHT_COLOR, transparent: true, opacity: 0.75 });
  private cameraLines = new THREE.LineBasicMaterial({ color: CAMERA_COLOR, transparent: true, opacity: 0.75 });

  constructor(
    private readonly scene: Scene,
    private readonly bridge: RenderBridge,
  ) {
    this.object.name = 'SceneGizmos';
  }

  /** Rebuilds the whole set. Cheap — scenes have a handful of lights and cameras, not thousands. */
  rebuild(): void {
    this.clear();
    for (const entity of this.scene.all()) {
      const light = entity.components.find((c): c is LightComponent => c.type === 'Light');
      const camera = entity.components.find((c): c is CameraComponent => c.type === 'Camera');
      if (!light && !camera) continue;

      const root = new THREE.Group();
      const handle = new THREE.Mesh(
        this.iconGeometry,
        light ? this.lightMaterial : this.cameraMaterial,
      );
      handle.userData.entityId = entity.id;
      root.add(handle);

      if (light) root.add(this.buildLightShape(light));
      if (camera) root.add(this.buildFrustum(camera));

      root.matrixAutoUpdate = false;
      this.object.add(root);
      this.entries.push({ id: entity.id, root, handle });
    }
    this.sync();
  }

  /**
   * Copies world matrices from the render bridge.
   *
   * Called every frame rather than on `transformChanged`, because a gizmo drag moves an entity
   * through the bridge without the editor's overlays being told per axis — and a light dragged
   * around should track the pointer, not lag a frame behind it.
   */
  sync(): void {
    for (const entry of this.entries) {
      const source = this.bridge.objectFor(entry.id);
      if (!source) continue;
      source.updateMatrixWorld();
      // Position and rotation only: scaling an entity should not inflate its light icon.
      entry.root.matrix.copy(source.matrixWorld);
      const scale = new THREE.Vector3().setFromMatrixScale(entry.root.matrix);
      entry.root.matrix.scale(new THREE.Vector3(1 / scale.x, 1 / scale.y, 1 / scale.z));
      entry.root.matrixWorldNeedsUpdate = true;
    }
  }

  pickables(): THREE.Object3D[] {
    return this.entries.map((entry) => entry.handle);
  }

  dispose(): void {
    this.clear();
    this.iconGeometry.dispose();
    this.lightMaterial.dispose();
    this.cameraMaterial.dispose();
    this.lightLines.dispose();
    this.cameraLines.dispose();
    this.object.removeFromParent();
  }

  // ---------------------------------------------------------------- internal

  private clear(): void {
    for (const entry of this.entries) {
      entry.root.traverse((object) => {
        const withGeometry = object as THREE.Mesh | THREE.LineSegments;
        // Shared geometries are disposed in dispose(); per-entry ones are built fresh here.
        if (withGeometry.geometry && withGeometry.geometry !== this.iconGeometry) {
          withGeometry.geometry.dispose();
        }
      });
      entry.root.removeFromParent();
    }
    this.entries = [];
  }

  private buildLightShape(light: LightComponent): THREE.Object3D {
    const points: THREE.Vector3[] = [];
    switch (light.lightType) {
      case 'Point':
        // Three rings, one per plane — the conventional "this radiates in all directions".
        pushCircle(points, 0.45, 'xy');
        pushCircle(points, 0.45, 'xz');
        pushCircle(points, 0.45, 'yz');
        break;
      case 'Spot': {
        const radius = Math.tan(THREE.MathUtils.degToRad(light.angle)) * GIZMO_REACH;
        pushCircle(points, radius, 'xy', -GIZMO_REACH);
        for (const [x, y] of [
          [radius, 0],
          [-radius, 0],
          [0, radius],
          [0, -radius],
        ] as const) {
          points.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(x, y, -GIZMO_REACH));
        }
        break;
      }
      case 'Directional':
      default:
        // A bundle of parallel rays, which is what "directional" means and what distinguishes
        // it at a glance from a point light's rings.
        pushCircle(points, 0.35, 'xy');
        for (const [x, y] of [
          [0, 0],
          [0.3, 0.18],
          [-0.3, 0.18],
          [0.3, -0.18],
          [-0.3, -0.18],
        ] as const) {
          points.push(new THREE.Vector3(x, y, 0), new THREE.Vector3(x, y, -GIZMO_REACH));
        }
        break;
    }
    return new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(points),
      this.lightLines,
    );
  }

  private buildFrustum(camera: CameraComponent): THREE.Object3D {
    const height = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * GIZMO_REACH;
    // Assume a 16:9 viewport for the outline; the real aspect comes from the canvas at render
    // time and would make the gizmo resize as the window does.
    const width = height * (16 / 9);
    const corners = [
      new THREE.Vector3(width, height, -GIZMO_REACH),
      new THREE.Vector3(-width, height, -GIZMO_REACH),
      new THREE.Vector3(-width, -height, -GIZMO_REACH),
      new THREE.Vector3(width, -height, -GIZMO_REACH),
    ];
    const points: THREE.Vector3[] = [];
    for (const [index, corner] of corners.entries()) {
      points.push(new THREE.Vector3(0, 0, 0), corner.clone());
      points.push(corner.clone(), corners[(index + 1) % corners.length]!.clone());
    }
    // A nub on top, so the frustum's "up" is readable when it is pointing at you.
    points.push(
      new THREE.Vector3(-width * 0.4, height, -GIZMO_REACH),
      new THREE.Vector3(0, height * 1.5, -GIZMO_REACH),
      new THREE.Vector3(0, height * 1.5, -GIZMO_REACH),
      new THREE.Vector3(width * 0.4, height, -GIZMO_REACH),
    );
    return new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(points),
      this.cameraLines,
    );
  }
}

/** Appends a line-segment circle in the given plane. */
function pushCircle(
  out: THREE.Vector3[],
  radius: number,
  plane: 'xy' | 'xz' | 'yz',
  offset = 0,
  segments = 24,
): void {
  const point = (angle: number): THREE.Vector3 => {
    const a = Math.cos(angle) * radius;
    const b = Math.sin(angle) * radius;
    if (plane === 'xy') return new THREE.Vector3(a, b, offset);
    if (plane === 'xz') return new THREE.Vector3(a, offset, b);
    return new THREE.Vector3(offset, a, b);
  };
  for (let i = 0; i < segments; i += 1) {
    out.push(point((i / segments) * Math.PI * 2), point(((i + 1) / segments) * Math.PI * 2));
  }
}
