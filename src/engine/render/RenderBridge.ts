import * as THREE from 'three';
import { createMaterial, type MaterialComponent } from '../components/Material';
import type { MeshRendererComponent } from '../components/MeshRenderer';
import type { Scene } from '../scene/Scene';
import type { Entity, EntityId, Vec3 } from '../scene/types';
import { geometryCache, geometryKey } from './geometry';
import { materialCache, materialKey } from './material';

const DEG2RAD = Math.PI / 180;

interface EntityNode {
  /** Always present — carries the Transform. Empties are this and nothing else. */
  group: THREE.Group;
  mesh: THREE.Mesh | null;
  geometryKey: string | null;
  materialKey: string | null;
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

    const node: EntityNode = { group, mesh: null, geometryKey: null, materialKey: null };
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
    const nextGeometryKey = geometryKey(renderer);
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
    if (node.geometryKey !== nextGeometryKey) {
      const geometry = geometryCache.acquire(nextGeometryKey);
      if (node.geometryKey) geometryCache.release(node.geometryKey);
      node.geometryKey = nextGeometryKey;
      node.mesh.geometry = geometry;
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
    node.group.name = entity.name;
  }
}
