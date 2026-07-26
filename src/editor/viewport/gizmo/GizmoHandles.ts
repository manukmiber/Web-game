import * as THREE from 'three';

export type GizmoMode = 'translate' | 'rotate' | 'scale';
/** Single axis, two-axis plane, uniform centre, or the view-facing handle. */
export type HandleId = 'x' | 'y' | 'z' | 'xy' | 'yz' | 'xz' | 'xyz' | 'screen';

/** Which of the gizmo's axes a handle is allowed to move along. */
export const HANDLE_AXES: Record<HandleId, [boolean, boolean, boolean]> = {
  x: [true, false, false],
  y: [false, true, false],
  z: [false, false, true],
  xy: [true, true, false],
  yz: [false, true, true],
  xz: [true, false, true],
  xyz: [true, true, true],
  screen: [true, true, true],
};

const AXIS_COLORS = [0xff3653, 0x8adb00, 0x2c8fff] as const;
const NEUTRAL_COLOR = 0xdddddd;
const HIGHLIGHT_COLOR = 0xffcc22;

/** Target on-screen length of an axis handle, in CSS pixels, at any camera distance. */
const GIZMO_PIXELS = 96;

interface Handle {
  id: HandleId;
  /** Meshes tinted on hover. */
  visuals: THREE.Mesh[];
  materials: THREE.MeshBasicMaterial[];
  baseColor: THREE.Color;
  baseOpacity: number;
}

/**
 * The gizmo's geometry: what you see, and what you can grab.
 *
 * Visuals and pickers are separate objects. A translate arrow is 3 mm thick on screen, which
 * is unusable as a hit target, so each one is shadowed by a fat invisible cylinder that does
 * the picking. Invisible objects are still raycastable in Three, which is what makes this
 * work without drawing anything extra.
 *
 * Everything is authored at unit size around the origin and rescaled per frame so the gizmo
 * covers a constant number of pixels — a gizmo that shrinks into the distance is one you
 * cannot grab, and grabbing it is the entire job.
 */
export class GizmoHandles {
  readonly root = new THREE.Group();

  private readonly groups: Record<GizmoMode, THREE.Group> = {
    translate: new THREE.Group(),
    rotate: new THREE.Group(),
    scale: new THREE.Group(),
  };
  private readonly pickers: Record<GizmoMode, THREE.Group> = {
    translate: new THREE.Group(),
    rotate: new THREE.Group(),
    scale: new THREE.Group(),
  };
  private readonly handles = new Map<string, Handle>();
  private readonly disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  private readonly axisLine: THREE.LineSegments;

  private mode: GizmoMode = 'translate';
  private highlighted: HandleId | null = null;

  constructor() {
    this.root.name = 'TransformGizmo';
    // Drawn after the scene and the overlay's other contents, ignoring depth, so the gizmo is
    // always reachable even when it sits inside the object it is transforming.
    this.root.renderOrder = 1000;
    this.root.visible = false;

    for (const mode of ['translate', 'rotate', 'scale'] as const) {
      this.groups[mode].visible = mode === this.mode;
      this.pickers[mode].visible = false;
      this.root.add(this.groups[mode], this.pickers[mode]);
    }

    this.buildTranslate();
    this.buildRotate();
    this.buildScale();

    this.axisLine = this.buildAxisLine();
    this.root.add(this.axisLine);
  }

  setMode(mode: GizmoMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    for (const key of ['translate', 'rotate', 'scale'] as const) {
      this.groups[key].visible = key === mode;
    }
  }

  getMode(): GizmoMode {
    return this.mode;
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
    if (!visible) this.setAxisLine(null);
  }

  get visible(): boolean {
    return this.root.visible;
  }

  /**
   * Places the gizmo and rescales it to a constant on-screen size.
   *
   * `viewportHeight` is in CSS pixels — the same units the pointer arrives in — so the sizing
   * holds on a HiDPI display, where the drawing buffer is larger than the element.
   */
  update(
    camera: THREE.PerspectiveCamera,
    viewportHeight: number,
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
  ): void {
    this.root.position.copy(position);
    this.root.quaternion.copy(quaternion);

    const distance = camera.position.distanceTo(position);
    const worldPerPixel =
      (2 * Math.tan((camera.fov * Math.PI) / 360) * distance) / Math.max(viewportHeight, 1);
    const scale = Math.max(worldPerPixel * GIZMO_PIXELS, 1e-6);
    this.root.scale.setScalar(scale);
    this.root.updateMatrixWorld(true);
  }

  /** Tints a handle to show it is under the pointer or being dragged. */
  highlight(id: HandleId | null): void {
    if (id === this.highlighted) return;
    this.highlighted = id;
    for (const handle of this.handles.values()) {
      const active = handle.id === id;
      for (const material of handle.materials) {
        material.color.set(active ? HIGHLIGHT_COLOR : handle.baseColor);
        material.opacity = active ? 1 : handle.baseOpacity;
      }
    }
  }

  /**
   * A guide line along the axis being dragged, the way Blender draws one. Without it a
   * constrained drag in a rotated frame looks like the object is wandering off course.
   */
  setAxisLine(axis: THREE.Vector3 | null, color = HIGHLIGHT_COLOR): void {
    if (!axis) {
      this.axisLine.visible = false;
      return;
    }
    this.axisLine.visible = true;
    (this.axisLine.material as THREE.LineBasicMaterial).color.set(color);
    const positions = this.axisLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    positions.setXYZ(0, -axis.x * 1000, -axis.y * 1000, -axis.z * 1000);
    positions.setXYZ(1, axis.x * 1000, axis.y * 1000, axis.z * 1000);
    positions.needsUpdate = true;
  }

  /** Handle under the pointer, or null. Ray must already be set from the camera. */
  pick(raycaster: THREE.Raycaster): HandleId | null {
    const hits = raycaster.intersectObjects(this.pickers[this.mode].children, true);
    for (const hit of hits) {
      const id = hit.object.userData.handleId as HandleId | undefined;
      if (id) return id;
    }
    return null;
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.handles.clear();
    this.root.removeFromParent();
  }

  // ------------------------------------------------------------------ build

  private track<T extends THREE.BufferGeometry | THREE.Material>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  private material(color: number, opacity = 1): THREE.MeshBasicMaterial {
    return this.track(
      new THREE.MeshBasicMaterial({
        color,
        opacity,
        transparent: true,
        // The gizmo must stay grabbable when it is inside the mesh it transforms.
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
  }

  private register(
    mode: GizmoMode,
    id: HandleId,
    color: number,
    opacity: number,
    visuals: THREE.Mesh[],
    pickers: THREE.Mesh[],
  ): void {
    const handle: Handle = {
      id,
      visuals,
      materials: visuals.map((mesh) => mesh.material as THREE.MeshBasicMaterial),
      baseColor: new THREE.Color(color),
      baseOpacity: opacity,
    };
    this.handles.set(`${mode}:${id}`, handle);
    for (const mesh of visuals) this.groups[mode].add(mesh);
    for (const mesh of pickers) {
      mesh.userData.handleId = id;
      mesh.visible = false;
      this.pickers[mode].add(mesh);
    }
  }

  /** Rotates a mesh authored along +Y onto the given axis, then offsets it along that axis. */
  private orient(mesh: THREE.Mesh, axis: number, offset: number): THREE.Mesh {
    if (axis === 0) mesh.rotation.z = -Math.PI / 2;
    else if (axis === 2) mesh.rotation.x = Math.PI / 2;
    mesh.position.setComponent(axis, offset);
    return mesh;
  }

  private buildTranslate(): void {
    const shaft = this.track(new THREE.CylinderGeometry(0.014, 0.014, 0.72, 8));
    const tip = this.track(new THREE.ConeGeometry(0.05, 0.18, 12));
    const picker = this.track(new THREE.CylinderGeometry(0.11, 0.11, 1, 6));

    for (let axis = 0; axis < 3; axis += 1) {
      const color = AXIS_COLORS[axis]!;
      const shaftMesh = this.orient(new THREE.Mesh(shaft, this.material(color)), axis, 0.39);
      const tipMesh = this.orient(new THREE.Mesh(tip, this.material(color)), axis, 0.84);
      const pickerMesh = this.orient(
        new THREE.Mesh(picker, this.material(color, 0)),
        axis,
        0.5,
      );
      this.register('translate', axisId(axis), color, 1, [shaftMesh, tipMesh], [pickerMesh]);
    }

    // Plane handles sit in the corner between two axes and are tinted by the axis they are
    // normal to, matching every DCC that has them.
    const quad = this.track(new THREE.PlaneGeometry(0.22, 0.22));
    for (const [normal, id] of [
      [2, 'xy'],
      [0, 'yz'],
      [1, 'xz'],
    ] as const) {
      const color = AXIS_COLORS[normal]!;
      const mesh = new THREE.Mesh(quad, this.material(color, 0.45));
      const pickerMesh = new THREE.Mesh(quad, this.material(color, 0));
      for (const target of [mesh, pickerMesh]) {
        if (normal === 0) target.rotation.y = Math.PI / 2;
        else if (normal === 1) target.rotation.x = Math.PI / 2;
        target.position.setComponent((normal + 1) % 3, 0.28);
        target.position.setComponent((normal + 2) % 3, 0.28);
      }
      this.register('translate', id, color, 0.45, [mesh], [pickerMesh]);
    }

    const centre = this.track(new THREE.OctahedronGeometry(0.07));
    this.register(
      'translate',
      'screen',
      NEUTRAL_COLOR,
      0.9,
      [new THREE.Mesh(centre, this.material(NEUTRAL_COLOR, 0.9))],
      [new THREE.Mesh(this.track(new THREE.SphereGeometry(0.11, 8, 6)), this.material(NEUTRAL_COLOR, 0))],
    );
  }

  private buildRotate(): void {
    const ring = this.track(new THREE.TorusGeometry(0.8, 0.008, 4, 64));
    const ringPicker = this.track(new THREE.TorusGeometry(0.8, 0.06, 4, 32));

    for (let axis = 0; axis < 3; axis += 1) {
      const color = AXIS_COLORS[axis]!;
      // A torus is authored in XY; spin it so its normal lands on the axis it rotates about.
      const mesh = new THREE.Mesh(ring, this.material(color));
      const pickerMesh = new THREE.Mesh(ringPicker, this.material(color, 0));
      for (const target of [mesh, pickerMesh]) {
        if (axis === 0) target.rotation.y = Math.PI / 2;
        else if (axis === 1) target.rotation.x = Math.PI / 2;
      }
      this.register('rotate', axisId(axis), color, 1, [mesh], [pickerMesh]);
    }

    // The outer ring rotates about the view direction, which is the only way to spin an object
    // whose axes all point nearly at the camera.
    const outer = this.track(new THREE.TorusGeometry(0.98, 0.008, 4, 64));
    const outerPicker = this.track(new THREE.TorusGeometry(0.98, 0.05, 4, 32));
    const mesh = new THREE.Mesh(outer, this.material(NEUTRAL_COLOR, 0.7));
    const pickerMesh = new THREE.Mesh(outerPicker, this.material(NEUTRAL_COLOR, 0));
    mesh.userData.faceCamera = true;
    pickerMesh.userData.faceCamera = true;
    this.register('rotate', 'screen', NEUTRAL_COLOR, 0.7, [mesh], [pickerMesh]);
  }

  private buildScale(): void {
    const shaft = this.track(new THREE.CylinderGeometry(0.012, 0.012, 0.78, 8));
    const box = this.track(new THREE.BoxGeometry(0.1, 0.1, 0.1));
    const picker = this.track(new THREE.CylinderGeometry(0.11, 0.11, 1, 6));

    for (let axis = 0; axis < 3; axis += 1) {
      const color = AXIS_COLORS[axis]!;
      const shaftMesh = this.orient(new THREE.Mesh(shaft, this.material(color)), axis, 0.39);
      const boxMesh = this.orient(new THREE.Mesh(box, this.material(color)), axis, 0.83);
      const pickerMesh = this.orient(new THREE.Mesh(picker, this.material(color, 0)), axis, 0.5);
      this.register('scale', axisId(axis), color, 1, [shaftMesh, boxMesh], [pickerMesh]);
    }

    const centre = this.track(new THREE.BoxGeometry(0.13, 0.13, 0.13));
    this.register(
      'scale',
      'xyz',
      NEUTRAL_COLOR,
      0.9,
      [new THREE.Mesh(centre, this.material(NEUTRAL_COLOR, 0.9))],
      [new THREE.Mesh(this.track(new THREE.BoxGeometry(0.2, 0.2, 0.2)), this.material(NEUTRAL_COLOR, 0))],
    );
  }

  private buildAxisLine(): THREE.LineSegments {
    const geometry = this.track(new THREE.BufferGeometry());
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
    const material = this.track(
      new THREE.LineBasicMaterial({
        color: HIGHLIGHT_COLOR,
        transparent: true,
        opacity: 0.5,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    const line = new THREE.LineSegments(geometry, material);
    line.visible = false;
    line.renderOrder = 999;
    return line;
  }

  /** Turns the view-facing rotate ring toward the camera. Called from `update`'s caller. */
  faceCamera(camera: THREE.Camera): void {
    if (this.mode !== 'rotate') return;
    const inverse = _q.copy(this.root.quaternion).invert();
    const facing = _q2.copy(camera.quaternion).premultiply(inverse);
    for (const group of [this.groups.rotate, this.pickers.rotate]) {
      for (const child of group.children) {
        if (child.userData.faceCamera) child.quaternion.copy(facing);
      }
    }
  }
}

function axisId(axis: number): HandleId {
  return (['x', 'y', 'z'] as const)[axis]!;
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
