import * as THREE from 'three';
import type { LightComponent, LightType } from '../components/Light';
import { createMaterial, type MaterialComponent } from '../components/Material';
import type { MeshRendererComponent } from '../components/MeshRenderer';
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

interface EntityNode {
  /** Always present — carries the Transform. Empties are this and nothing else. */
  group: THREE.Group;
  mesh: THREE.Mesh | null;
  geometryKey: string | null;
  materialKey: string | null;
  light: THREE.Light | null;
  /** Which light class `light` is, so a type change rebuilds rather than mis-configures. */
  lightKind: LightType | null;
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

  /** Meshes only — what the viewport raycasts against. */
  pickables(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const node of this.nodes.values()) if (node.mesh) out.push(node.mesh);
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
      events.on('entityAdded', ({ entity }) => this.createNode(entity)),
      events.on('entityRemoved', ({ id }) => this.destroySubtree(id)),
      events.on('entityReparented', ({ id }) => this.attachToParent(id)),
      events.on('transformChanged', ({ id }) => this.syncTransform(id)),
      events.on('componentsChanged', ({ id }) => this.syncComponents(id)),
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

  /** True when the scene lights itself, so the host can drop its placeholder rig. */
  hasLights(): boolean {
    for (const node of this.nodes.values()) if (node.light) return true;
    return false;
  }
}

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
