import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import '../components';
import { createScatterLayer } from '../components/ScatterLayer';
import { createPrototype, refillLayer } from '../scatter/layer';
import { RenderBridge } from './RenderBridge';
import { Scene } from '../scene/Scene';
import { createPrimitiveEntity } from '../scene/primitives';
import type { Entity } from '../scene/types';

/** The host's pass, reproduced. See the note on the second test for why it is not the real one. */
function applyShading(bridge: RenderBridge, solidVisible: boolean): void {
  bridge.root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) mesh.visible = solidVisible && mesh.userData.entityVisible !== false;
  });
}

/**
 * These cover the seam between the bridge (which decides *what* is in the tree) and the host's
 * shading pass (which rewrites `visible` across the whole tree). The pass has no other way to
 * tell a mesh hidden on purpose from one it hid itself, so the bridge has to say — and when it
 * did not, unchecking Visible worked until the next event that re-ran the pass, which is any
 * transform change while a wireframe mode is on.
 */
describe('entity visibility', () => {
  it('records the renderer visibility on the mesh, not only on the object', () => {
    const scene = new Scene();
    const entity = createPrimitiveEntity('Box', { name: 'Crate' });
    scene.add(entity);

    const bridge = new RenderBridge(scene);
    const mesh = bridge.pickables()[0] as THREE.Mesh;
    expect(mesh.visible).toBe(true);
    expect(mesh.userData.entityVisible).toBe(true);

    scene.updateComponent(entity.id, 'MeshRenderer', { visible: false });
    expect(mesh.visible).toBe(false);
    expect(mesh.userData.entityVisible).toBe(false);

    scene.updateComponent(entity.id, 'MeshRenderer', { visible: true });
    expect(mesh.userData.entityVisible).toBe(true);

    bridge.dispose();
  });

  /**
   * The host's pass is `visible = solidVisible && userData.entityVisible !== false`. Reproduced
   * here rather than by constructing a RenderHost, which needs a WebGL context this environment
   * does not have — the flag on the mesh is the contract between the two, and it is what broke.
   */
  it('survives a shading pass that rewrites visibility across the tree', () => {
    const scene = new Scene();
    const hidden = createPrimitiveEntity('Box', { name: 'Hidden' });
    const shown = createPrimitiveEntity('Box', { name: 'Shown' });
    scene.add(hidden);
    scene.add(shown);

    const bridge = new RenderBridge(scene);
    scene.updateComponent(hidden.id, 'MeshRenderer', { visible: false });

    applyShading(bridge, true);

    const byName = (name: string) =>
      bridge.pickables().find((object) => object.userData.entityId === name) as THREE.Mesh;
    expect(byName(hidden.id).visible).toBe(false);
    expect(byName(shown.id).visible).toBe(true);

    bridge.dispose();
  });

  /**
   * Scatter batches go through the same pass — `InstancedMesh.isMesh` is true — and they were
   * the one thing in the tree that never recorded the flag. So hiding a forest worked until any
   * shading change, at which point ten thousand trees came back with no way to hide them again
   * short of deleting the layer.
   */
  it('keeps a hidden scatter layer hidden through a shading pass', () => {
    const scene = new Scene();
    const tree = createPrimitiveEntity('Box', { name: 'Tree' });
    scene.add(tree);

    const layer = createScatterLayer({
      prototypes: [createPrototype(tree.id)],
      extentX: 10,
      extentZ: 10,
      density: 5,
      visible: false,
    });
    Object.assign(layer, refillLayer(layer));
    const entity: Entity = {
      id: 'forest',
      name: 'Forest',
      parentId: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [layer],
    };
    scene.add(entity);

    const bridge = new RenderBridge(scene);
    const batches = bridge
      .pickables()
      .filter((object): object is THREE.InstancedMesh => (object as THREE.InstancedMesh).isInstancedMesh);
    expect(batches.length).toBeGreaterThan(0);

    // Leaving wireframe mode: the pass makes solid geometry visible again across the tree.
    applyShading(bridge, true);
    for (const batch of batches) expect(batch.visible).toBe(false);

    scene.updateComponent(entity.id, 'ScatterLayer', { visible: true });
    applyShading(bridge, true);
    for (const batch of bridge.pickables()) {
      if ((batch as THREE.InstancedMesh).isInstancedMesh) expect(batch.visible).toBe(true);
    }

    bridge.dispose();
  });
});
