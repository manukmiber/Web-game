import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import '../components';
import { createMaterial } from '../components/Material';
import { createScatterLayer, type ScatterLayerComponent } from '../components/ScatterLayer';
import { RenderBridge } from '../render/RenderBridge';
import { Scene } from '../scene/Scene';
import { createPrimitiveEntity } from '../scene/primitives';
import type { Entity, EntityId } from '../scene/types';
import { createPrototype, refillLayer, resolveScatterSources, scatterStats } from './layer';

function addPrimitive(scene: Scene, name: string, color = '#ffffff'): Entity {
  const entity = createPrimitiveEntity('Box', { name, color });
  scene.add(entity);
  return entity;
}

function addLayer(
  scene: Scene,
  sources: EntityId[],
  overrides: Partial<ScatterLayerComponent> = {},
): { id: EntityId; layer: ScatterLayerComponent } {
  const layer = createScatterLayer({
    prototypes: sources.map((sourceId) => createPrototype(sourceId)),
    extentX: 10,
    extentZ: 10,
    density: 5,
    ...overrides,
  });
  Object.assign(layer, refillLayer(layer));

  const entity: Entity = {
    id: 'layer',
    name: 'Forest',
    parentId: null,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [layer],
  };
  scene.add(entity);
  return { id: entity.id, layer };
}

/** Every InstancedMesh the bridge produced, in tree order. */
function batches(bridge: RenderBridge): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  bridge.root.traverse((object) => {
    if ((object as THREE.InstancedMesh).isInstancedMesh) out.push(object as THREE.InstancedMesh);
  });
  return out;
}

describe('scatter rendering', () => {
  let scene: Scene;

  beforeEach(() => {
    scene = new Scene();
  });

  it('draws one InstancedMesh per prototype, not one mesh per instance', () => {
    const tree = addPrimitive(scene, 'Tree');
    const rock = addPrimitive(scene, 'Rock');
    const { layer } = addLayer(scene, [tree.id, rock.id]);

    const bridge = new RenderBridge(scene);
    const meshes = batches(bridge);

    expect(meshes).toHaveLength(2);
    const total = meshes.reduce((sum, mesh) => sum + mesh.count, 0);
    expect(total).toBe(layer.instanceCount);
    // 20 x 20 m at 5 per 100 m² is 20 instances — and 2 draw calls, which is the whole point.
    expect(total).toBe(20);
    expect(bridge.scatterStats()).toEqual({ instances: 20, drawCalls: 2 });

    bridge.dispose();
  });

  it('writes each instance transform into the matrix buffer', () => {
    const tree = addPrimitive(scene, 'Tree');
    addLayer(scene, [tree.id], { density: 2, minScale: 1, maxScale: 1, randomYaw: false });

    const bridge = new RenderBridge(scene);
    const [mesh] = batches(bridge);
    expect(mesh).toBeDefined();

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (let i = 0; i < mesh!.count; i += 1) {
      mesh!.getMatrixAt(i, matrix);
      matrix.decompose(position, quaternion, scale);
      expect(Math.abs(position.x)).toBeLessThanOrEqual(10.001);
      expect(Math.abs(position.z)).toBeLessThanOrEqual(10.001);
      expect(scale.x).toBeCloseTo(1, 4);
    }
    bridge.dispose();
  });

  it('resolves an instance click back to the layer, not to the source mesh', () => {
    const tree = addPrimitive(scene, 'Tree');
    const { id } = addLayer(scene, [tree.id]);

    const bridge = new RenderBridge(scene);
    for (const mesh of batches(bridge)) {
      expect(bridge.entityIdFor(mesh)).toBe(id);
      expect(bridge.pickables()).toContain(mesh);
    }
    bridge.dispose();
  });

  it('skips prototypes whose source entity is gone, and keeps drawing the rest', () => {
    const tree = addPrimitive(scene, 'Tree');
    const rock = addPrimitive(scene, 'Rock');
    addLayer(scene, [tree.id, rock.id]);

    const bridge = new RenderBridge(scene);
    expect(batches(bridge)).toHaveLength(2);

    scene.remove(rock.id);
    expect(batches(bridge)).toHaveLength(1);
    expect(bridge.scatterStats().drawCalls).toBe(1);

    bridge.dispose();
  });

  it('rebuilds when the source mesh is edited, so the copies follow the original', () => {
    const tree = addPrimitive(scene, 'Tree');
    addLayer(scene, [tree.id]);

    const bridge = new RenderBridge(scene);
    const before = batches(bridge)[0]!;
    const beforeGeometry = before.geometry;

    scene.updateComponent(tree.id, 'MeshRenderer', { params: { width: 4, height: 4, depth: 4 } });

    const after = batches(bridge)[0]!;
    expect(after.geometry).not.toBe(beforeGeometry);
    expect(after.count).toBe(before.count);

    bridge.dispose();
  });

  it('drops its batches when the layer component is removed', () => {
    const tree = addPrimitive(scene, 'Tree');
    const { id } = addLayer(scene, [tree.id]);

    const bridge = new RenderBridge(scene);
    expect(batches(bridge).length).toBeGreaterThan(0);

    scene.removeComponent(id, 'ScatterLayer');
    expect(batches(bridge)).toHaveLength(0);
    expect(bridge.scatterStats()).toEqual({ instances: 0, drawCalls: 0 });

    bridge.dispose();
  });

  it('renders an empty layer as nothing rather than as an error', () => {
    addLayer(scene, []);
    const bridge = new RenderBridge(scene);
    expect(batches(bridge)).toHaveLength(0);
    bridge.dispose();
  });

  it('applies the layer visibility and shadow flags to every batch', () => {
    const tree = addPrimitive(scene, 'Tree');
    addLayer(scene, [tree.id], { visible: false, castShadow: true, receiveShadow: false });

    const bridge = new RenderBridge(scene);
    for (const mesh of batches(bridge)) {
      expect(mesh.visible).toBe(false);
      expect(mesh.castShadow).toBe(true);
      expect(mesh.receiveShadow).toBe(false);
    }
    bridge.dispose();
  });
});

describe('layer helpers', () => {
  it('skips a prototype pointing at an entity with no mesh', () => {
    const scene = new Scene();
    const empty = createPrimitiveEntity('Empty', { name: 'Group' });
    scene.add(empty);
    const layer = createScatterLayer({ prototypes: [createPrototype(empty.id)] });
    expect(resolveScatterSources(scene, layer)).toEqual([]);
  });

  it('falls back to default material settings when the source has no Material', () => {
    const scene = new Scene();
    const entity = createPrimitiveEntity('Box', { name: 'Bare' });
    entity.components = entity.components.filter((c) => c.type !== 'Material');
    scene.add(entity);

    const [source] = resolveScatterSources(
      scene,
      createScatterLayer({ prototypes: [createPrototype(entity.id)] }),
    );
    expect(source?.material).toEqual(createMaterial());
  });

  it('reports what a refill would place before anything is written', () => {
    const scene = new Scene();
    const tree = createPrimitiveEntity('Box', { name: 'Tree' });
    scene.add(tree);
    const layer = createScatterLayer({
      prototypes: [createPrototype(tree.id)],
      extentX: 10,
      extentZ: 10,
      density: 5,
    });

    expect(scatterStats(scene, layer)).toEqual({
      instances: 0,
      wouldPlace: 20,
      prototypes: 1,
      drawCalls: 1,
    });

    Object.assign(layer, refillLayer(layer));
    expect(scatterStats(scene, layer).instances).toBe(20);
  });
});
