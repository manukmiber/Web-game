import * as THREE from 'three';
import type { LightComponent, LightType } from '../components/Light';
import { createMaterial, type MaterialComponent } from '../components/Material';
import type { MeshRendererComponent } from '../components/MeshRenderer';
import type { ScatterLayerComponent } from '../components/ScatterLayer';
import {
  resolveScatterSources,
  sameScatterKey,
  scatterKey,
  unpackInstances,
  type ScatterKey,
} from '../scatter/layer';
import type { Scene } from '../scene/Scene';
import type { Entity, EntityId, Vec3 } from '../scene/types';
import { acquireGeometry, geometryCache } from './geometry';
import { materialCache, materialKey } from './material';

const DEG2RAD = Math.PI / 180;

/**
 * Point and spot intensity is candela in Three's physical lighting model, where a value that
 * lights a room is in the tens — while a directional light's is a plain multiplier around 1.
 * Authoring one "intensity" field that means both would make switching a light's type change
 * its brightness by an order of magnitude, so the conversion happens here instead.
 */
const PUNCTUAL_INTENSITY_SCALE = 12;

/** One prototype's worth of a scatter layer: a single draw call, however many instances. */
interface ScatterBatch {
  mesh: THREE.InstancedMesh;
  geometryKey: string;
  materialKey: string;
}

interface ScatterNode {
  batches: ScatterBatch[];
  /** What the layer looked like when these batches were built. See `sameScatterKey`. */
  key: ScatterKey;
}

interface EntityNode {
  /** Always present — carries the Transform. Empties are this and nothing else. */
  group: THREE.Group;
  mesh: THREE.Mesh | null;
  geometryKey: string | null;
  materialKey: string | null;
  light: THREE.Light | null;
  /** Which light class `light` is, so a type change rebuilds rather than mis-configures. */
  lightKind: LightType | null;
  /** Instanced geometry from a ScatterLayer, if the entity carries one. */
  scatter: ScatterNode | null;
}

/**
 * Projects scene data onto a Three.js object tree.
 *
 * Data is the source of truth in one direction only: the bridge reads the Scene and writes
 * Three.js. Nothing here writes back into the Scene — when the gizmo moves something, the
 * editor issues a command that mutates the Scene, and the change arrives back through the
 * normal event path. That one-way rule is what lets the same bridge serve a headless runtime.
 *
 * Each entity gets a Group (its Transform) with an optional Mesh child, rather than a bare
 * Mesh. It keeps Empties, meshes and future component types structurally identical, so
 * parenting logic never branches on what an entity contains.
 */
export class RenderBridge {
  readonly root = new THREE.Group();

  private nodes = new Map<EntityId, EntityNode>();
  private unsubscribes: (() => void)[] = [];

  /**
   * Rendering origin. Subtracted from root-level positions so the GPU never sees coordinates
   * large enough to lose float32 precision — ARCHITECTURE.md §9.1. Stays at zero through
   * Phase 1; the streaming system will drive it later.
   */
  private originOffset: Vec3 = [0, 0, 0];

  constructor(private readonly scene: Scene) {
    this.root.name = 'SceneRoot';
    this.subscribe();
    this.rebuildAll();
  }

  // ------------------------------------------------------------- public API

  /** Three.js object for an entity, for raycasting and gizmo attachment. */
  objectFor(id: EntityId): THREE.Object3D | undefined {
    return this.nodes.get(id)?.group;
  }

  entityIdFor(object: THREE.Object3D): EntityId | undefined {
    let current: THREE.Object3D | null = object;
    while (current) {
      const id = current.userData.entityId as EntityId | undefined;
      if (id) return id;
      current = current.parent;
    }
    return undefined;
  }

  /**
   * Meshes only — what the viewport raycasts against.
   *
   * Scatter batches are in here too: Three raycasts an `InstancedMesh` per instance, so a click
   * on one tree in a forest hits, and the entity id on the batch resolves it to the layer.
   */
  pickables(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const node of this.nodes.values()) {
      if (node.mesh) out.push(node.mesh);
      for (const batch of node.scatter?.batches ?? []) out.push(batch.mesh);
    }
    return out;
  }

  getOriginOffset(): Vec3 {
    return [...this.originOffset];
  }

  setOriginOffset(offset: Vec3): void {
    this.originOffset = [...offset];
    for (const id of this.scene.rootIds()) this.syncTransform(id);
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    for (const id of [...this.nodes.keys()]) this.destroyNode(id);
    this.root.clear();
  }

  // -------------------------------------------------------------- lifecycle

  private subscribe(): void {
    const { events } = this.scene;
    this.unsubscribes.push(
      events.on('entityAdded', ({ entity }) => {
        this.createNode(entity);
        this.rebuildScatterUsing(entity.id);
      }),
      events.on('entityRemoved', ({ id }) => {
        this.destroySubtree(id);
        this.rebuildScatterUsing(id);
      }),
      events.on('entityReparented', ({ id }) => this.attachToParent(id)),
      events.on('transformChanged', ({ id }) => this.syncTransform(id)),
      events.on('componentsChanged', ({ id }) => {
        this.syncComponents(id);
        this.rebuildScatterUsing(id);
      }),
      events.on('sceneReplaced', () => this.rebuildAll()),
    );
  }

  private rebuildAll(): void {
    for (const id of [...this.nodes.keys()]) this.destroyNode(id);
    this.root.clear();
    // Parents first, so attachToParent always finds its target already built.
    const walk = (id: EntityId) => {
      const entity = this.scene.get(id);
      if (!entity) return;
      this.createNode(entity);
      for (const child of this.scene.childrenOf(id)) walk(child);
    };
    for (const id of this.scene.rootIds()) walk(id);
  }

  private createNode(entity: Entity): void {
    if (this.nodes.has(entity.id)) this.destroyNode(entity.id);

    const group = new THREE.Group();
    group.name = entity.name;
    group.userData.entityId = entity.id;

    const node: EntityNode = {
      group,
      mesh: null,
      geometryKey: null,
      materialKey: null,
      light: null,
      lightKind: null,
      scatter: null,
    };
    this.nodes.set(entity.id, node);

    this.attachToParent(entity.id);
    this.syncTransform(entity.id);
    this.syncComponents(entity.id);
  }

  /**
   * Removes an entity's node and every descendant's.
   *
   * Walks `nodes` rather than the Scene because by the time `entityRemoved` fires the entity
   * is already gone from the Scene — so the Three.js tree is the only remaining record of
   * what the subtree contained.
   */
  private destroySubtree(id: EntityId): void {
    const node = this.nodes.get(id);
    if (!node) return;
    const ids: EntityId[] = [];
    node.group.traverse((object) => {
      const childId = object.userData.entityId as EntityId | undefined;
      if (childId) ids.push(childId);
    });
    for (const childId of ids) this.destroyNode(childId);
  }

  private destroyNode(id: EntityId): void {
    const node = this.nodes.get(id);
    if (!node) return;
    this.releaseMesh(node);
    this.releaseLight(node);
    this.releaseScatter(node);
    node.group.removeFromParent();
    this.nodes.delete(id);
  }

  private releaseMesh(node: EntityNode): void {
    if (node.geometryKey) geometryCache.release(node.geometryKey);
    if (node.materialKey) materialCache.release(node.materialKey);
    node.mesh?.removeFromParent();
    node.mesh = null;
    node.geometryKey = null;
    node.materialKey = null;
  }

  // ------------------------------------------------------------------ sync

  private attachToParent(id: EntityId): void {
    const node = this.nodes.get(id);
    const entity = this.scene.get(id);
    if (!node || !entity) return;
    const parent = entity.parentId ? this.nodes.get(entity.parentId)?.group : undefined;
    (parent ?? this.root).add(node.group);
    // Root-level entities carry the origin offset; children inherit it through the parent.
    this.syncTransform(id);
  }

  private syncTransform(id: EntityId): void {
    const node = this.nodes.get(id);
    const entity = this.scene.get(id);
    if (!node || !entity) return;

    const { position, rotation, scale } = entity.transform;
    const isRoot = entity.parentId === null;
    node.group.position.set(
      position[0] - (isRoot ? this.originOffset[0] : 0),
      position[1] - (isRoot ? this.originOffset[1] : 0),
      position[2] - (isRoot ? this.originOffset[2] : 0),
    );
    node.group.rotation.set(rotation[0] * DEG2RAD, rotation[1] * DEG2RAD, rotation[2] * DEG2RAD);
    node.group.scale.set(scale[0], scale[1], scale[2]);
    node.group.updateMatrixWorld(true);
  }

  private syncComponents(id: EntityId): void {
    const node = this.nodes.get(id);
    const entity = this.scene.get(id);
    if (!node || !entity) return;
    node.group.name = entity.name;
    this.syncMesh(node, entity);
    this.syncLight(node, entity);
    this.syncScatter(node, entity);
  }

  private syncMesh(node: EntityNode, entity: Entity): void {
    const renderer = entity.components.find(
      (c): c is MeshRendererComponent => c.type === 'MeshRenderer',
    );
    if (!renderer) {
      this.releaseMesh(node);
      return;
    }

    const material = entity.components.find(
      (c): c is MaterialComponent => c.type === 'Material',
    );

    // A mesh without a Material component falls back to the component defaults rather than a
    // sentinel, so the key stays parseable by the cache factory.
    const nextMaterialKey = materialKey(material ?? createMaterial());

    if (!node.mesh) {
      node.mesh = new THREE.Mesh();
      node.mesh.userData.entityId = entity.id;
      node.group.add(node.mesh);
    }

    // Acquire before release: if the key is unchanged, this keeps the refcount above zero and
    // avoids disposing a resource we're about to ask for again.
    const { key: nextGeometryKey, geometry } = acquireGeometry(renderer);
    if (node.geometryKey !== nextGeometryKey) {
      if (node.geometryKey) geometryCache.release(node.geometryKey);
      node.geometryKey = nextGeometryKey;
      node.mesh.geometry = geometry;
    } else {
      // Same key: acquire bumped the refcount, so give it straight back.
      geometryCache.release(nextGeometryKey);
    }
    if (node.materialKey !== nextMaterialKey) {
      const nextMaterial = materialCache.acquire(nextMaterialKey);
      if (node.materialKey) materialCache.release(node.materialKey);
      node.materialKey = nextMaterialKey;
      node.mesh.material = nextMaterial;
    }

    node.mesh.visible = renderer.visible;
    // Recorded as well as applied, because the host's shading pass rewrites `visible` for the
    // whole tree and has no other way to know an entity was hidden on purpose. Without it,
    // hiding an object and then touching anything that re-runs the pass brings it back.
    node.mesh.userData.entityVisible = renderer.visible;
    node.mesh.castShadow = renderer.castShadow;
    node.mesh.receiveShadow = renderer.receiveShadow;
    // Meshes are lit by lights, but they are also *hit* by picking; keeping the entity id on
    // the mesh as well as the group is what lets a raycast resolve without walking up.
    node.mesh.userData.entityId = entity.id;
  }

  /**
   * Lights are attached to the entity's group, so a light inherits its transform the same way
   * a mesh does — parent a spot light to a torch and it follows the torch.
   *
   * Directional and spot lights point along the entity's **local -Z**, the same convention as
   * a camera, implemented by parking their `target` one unit down that axis. Three's default
   * (aim at the world origin) makes a light's rotation do nothing, which is baffling the first
   * time you rotate one and the shadows do not move.
   */
  private syncLight(node: EntityNode, entity: Entity): void {
    const component = entity.components.find((c): c is LightComponent => c.type === 'Light');
    if (!component) {
      this.releaseLight(node);
      return;
    }

    if (node.lightKind !== component.lightType) {
      this.releaseLight(node);
      node.light = createThreeLight(component.lightType);
      node.lightKind = component.lightType;
      node.group.add(node.light);
      const target = targetOf(node.light);
      if (target) {
        target.position.set(0, 0, -1);
        node.group.add(target);
      }
    }

    const light = node.light;
    if (!light) return;
    light.color.set(component.color);
    light.intensity =
      component.intensity * (component.lightType === 'Directional' ? 1 : PUNCTUAL_INTENSITY_SCALE);

    if (light instanceof THREE.PointLight || light instanceof THREE.SpotLight) {
      light.distance = Math.max(0, component.range);
      light.decay = 2;
    }
    if (light instanceof THREE.SpotLight) {
      light.angle = Math.min(Math.max(component.angle, 1), 89) * DEG2RAD;
      light.penumbra = Math.min(Math.max(component.penumbra, 0), 1);
    }

    light.castShadow = component.castShadow;
    const shadow = shadowOf(light);
    if (component.castShadow && shadow) {
      const size = THREE.MathUtils.floorPowerOfTwo(
        Math.min(Math.max(component.shadowMapSize, 256), 4096),
      );
      if (shadow.mapSize.width !== size) {
        shadow.mapSize.set(size, size);
        // Three only allocates a shadow map once; dropping it forces the new size.
        shadow.map?.dispose();
        shadow.map = null;
      }
      shadow.bias = component.shadowBias;
      // Defaulted rather than read straight through: scenes saved before this field existed
      // deserialize without it, and an undefined normal bias is a NaN shadow matrix — which
      // renders as every shadow in the scene disappearing at once.
      shadow.normalBias = component.shadowNormalBias ?? 0.02;
      if (shadow.camera instanceof THREE.OrthographicCamera) {
        const extent = Math.max(1, component.shadowRange);
        shadow.camera.left = -extent;
        shadow.camera.right = extent;
        shadow.camera.top = extent;
        shadow.camera.bottom = -extent;
        shadow.camera.near = 0.5;
        // Far has to reach the ground from wherever the sun entity was placed, and the shadow
        // range is the only hint of world size available here.
        shadow.camera.far = Math.max(200, extent * 6);
        shadow.camera.updateProjectionMatrix();
      }
    }
  }

  private releaseLight(node: EntityNode): void {
    const light = node.light;
    if (!light) return;
    targetOf(light)?.removeFromParent();
    light.removeFromParent();
    light.dispose();
    node.light = null;
    node.lightKind = null;
  }

  /**
   * Projects a `ScatterLayer` onto one `InstancedMesh` per prototype.
   *
   * This is ARCHITECTURE.md §9.3's whole argument made real: a layer holding a hundred thousand
   * trees is one entity in the Hierarchy, one node in this tree, and as many draw calls as it
   * has prototypes — not one of each per tree. The instance matrices come out of packed typed
   * arrays, so nothing here ever allocates per instance beyond the buffer the GPU needs.
   *
   * Geometry and material are borrowed from the *source entity* through the same refcounted
   * caches ordinary meshes use, which is what makes editing the source tree — its parameters,
   * its modifier stack, its colour — update every instance for free.
   */
  private syncScatter(node: EntityNode, entity: Entity): void {
    const layer = entity.components.find(
      (c): c is ScatterLayerComponent => c.type === 'ScatterLayer',
    );
    if (!layer) {
      this.releaseScatter(node);
      return;
    }

    const key = scatterKey(layer);
    if (sameScatterKey(node.scatter?.key ?? null, key)) return;
    this.releaseScatter(node);

    const sources = resolveScatterSources(this.scene, layer);
    if (sources.length === 0) {
      node.scatter = { batches: [], key };
      return;
    }

    const instances = unpackInstances(layer);
    // Bucket by prototype first, so each batch is allocated once at its true size rather than
    // at the layer's total and then trimmed.
    const buckets = new Map<number, typeof instances>();
    for (const instance of instances) {
      const bucket = buckets.get(instance.prototype);
      if (bucket) bucket.push(instance);
      else buckets.set(instance.prototype, [instance]);
    }

    const batches: ScatterBatch[] = [];
    for (const source of sources) {
      const bucket = buckets.get(source.index);
      if (!bucket || bucket.length === 0) continue;

      const { key: geometryKey, geometry } = acquireGeometry(source.renderer);
      const nextMaterialKey = materialKey(source.material);
      const material = materialCache.acquire(nextMaterialKey);

      const mesh = new THREE.InstancedMesh(geometry, material, bucket.length);
      mesh.name = `${entity.name} · ${source.entity.name}`;
      mesh.visible = key.visible;
      // Recorded for the same reason ordinary meshes record it: the host's shading pass rewrites
      // `visible` across the whole tree and has no other way to tell a batch hidden on purpose
      // from one it hid itself. Without it, hiding a scatter layer and then leaving wireframe
      // brought the whole forest back.
      mesh.userData.entityVisible = key.visible;
      mesh.castShadow = key.castShadow;
      mesh.receiveShadow = key.receiveShadow;
      // A click on any instance selects the layer. Selecting one tree out of a packed buffer
      // would need a selection model that does not exist yet, and "you selected the forest" is
      // the honest answer to clicking a forest.
      mesh.userData.entityId = entity.id;
      mesh.userData.scatterPrototype = source.prototype.id;

      for (const [index, instance] of bucket.entries()) {
        SCATTER_POSITION.set(instance.position[0], instance.position[1], instance.position[2]);
        SCATTER_QUATERNION.set(
          instance.rotation[0],
          instance.rotation[1],
          instance.rotation[2],
          instance.rotation[3],
        );
        const scale = Number.isFinite(instance.scale) ? instance.scale : 1;
        SCATTER_SCALE.setScalar(scale);
        SCATTER_MATRIX.compose(SCATTER_POSITION, SCATTER_QUATERNION, SCATTER_SCALE);
        mesh.setMatrixAt(index, SCATTER_MATRIX);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();

      node.group.add(mesh);
      batches.push({ mesh, geometryKey, materialKey: nextMaterialKey });
    }

    node.scatter = { batches, key };
  }

  /**
   * Rebuilds every layer that borrows its mesh from `sourceId`.
   *
   * A scatter batch is built from the *source entity's* renderer and material, so editing the
   * tree that a forest was scattered from — its radius, its colour, a modifier on its stack —
   * changes nothing the layer's own component can see. Without this, the source tree updates
   * and the thousand copies of it do not, which reads as a broken feature rather than a missed
   * event. Layers are counted in ones, so the scan costs nothing.
   */
  private rebuildScatterUsing(sourceId: EntityId): void {
    for (const [id, node] of this.nodes) {
      if (!node.scatter) continue;
      const entity = this.scene.get(id);
      if (!entity) continue;
      const layer = entity.components.find(
        (c): c is ScatterLayerComponent => c.type === 'ScatterLayer',
      );
      if (!layer?.prototypes?.some((prototype) => prototype.sourceId === sourceId)) continue;
      this.releaseScatter(node);
      this.syncScatter(node, entity);
    }
  }

  private releaseScatter(node: EntityNode): void {
    if (!node.scatter) return;
    for (const batch of node.scatter.batches) {
      batch.mesh.removeFromParent();
      // The InstancedMesh owns its per-instance buffer and nothing else; the geometry and
      // material belong to the caches, so they are released rather than disposed.
      batch.mesh.dispose();
      geometryCache.release(batch.geometryKey);
      materialCache.release(batch.materialKey);
    }
    node.scatter = null;
  }

  /** True when the scene lights itself, so the host can drop its placeholder rig. */
  hasLights(): boolean {
    for (const node of this.nodes.values()) if (node.light) return true;
    return false;
  }

  /** Instances drawn by scatter layers, and the draw calls they cost. Read by the perf HUD. */
  scatterStats(): { instances: number; drawCalls: number } {
    let instances = 0;
    let drawCalls = 0;
    for (const node of this.nodes.values()) {
      for (const batch of node.scatter?.batches ?? []) {
        instances += batch.mesh.count;
        drawCalls += 1;
      }
    }
    return { instances, drawCalls };
  }
}

/** Scratch objects for composing instance matrices — one allocation, not one per instance. */
const SCATTER_MATRIX = new THREE.Matrix4();
const SCATTER_POSITION = new THREE.Vector3();
const SCATTER_QUATERNION = new THREE.Quaternion();
const SCATTER_SCALE = new THREE.Vector3();

/** The aim point of a light that has one. Point lights don't. */
function targetOf(light: THREE.Light): THREE.Object3D | null {
  if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
    return light.target;
  }
  return null;
}

function shadowOf(light: THREE.Light): THREE.LightShadow | null {
  if (
    light instanceof THREE.DirectionalLight ||
    light instanceof THREE.SpotLight ||
    light instanceof THREE.PointLight
  ) {
    return light.shadow;
  }
  return null;
}

function createThreeLight(type: LightType): THREE.Light {
  switch (type) {
    case 'Point':
      return new THREE.PointLight(0xffffff, 1);
    case 'Spot':
      return new THREE.SpotLight(0xffffff, 1);
    case 'Directional':
    default: {
      const light = new THREE.DirectionalLight(0xffffff, 1);
      // Three seeds directional lights at (0, 1, 0); the entity's transform is the only thing
      // that should decide where this sits.
      light.position.set(0, 0, 0);
      return light;
    }
  }
}
