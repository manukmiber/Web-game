import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import '../components';
import { RenderBridge } from './RenderBridge';
import { Scene } from '../scene/Scene';
import { createPrimitiveEntity } from '../scene/primitives';

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

    const applyShading = (solidVisible: boolean) => {
      bridge.root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh) mesh.visible = solidVisible && mesh.userData.entityVisible !== false;
      });
    };
    applyShading(true);

    const byName = (name: string) =>
      bridge.pickables().find((object) => object.userData.entityId === name) as THREE.Mesh;
    expect(byName(hidden.id).visible).toBe(false);
    expect(byName(shown.id).visible).toBe(true);

    bridge.dispose();
  });
});
