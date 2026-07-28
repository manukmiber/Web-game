import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCollider } from '../components/Collider';
import { createLight } from '../components/Light';
import { createRigidBody } from '../components/RigidBody';
import { createScript } from '../components/Script';
import { RenderBridge } from '../render/RenderBridge';
import { Scene } from '../scene/Scene';
import { createPrimitiveEntity } from '../scene/primitives';
import { createTransform, type Entity, type Vec3 } from '../scene/types';
import { collectSceneStats } from './SceneStats';
import '../components';

function empty(name: string, position: Vec3 = [0, 0, 0]): Entity {
  return {
    id: `e-${name}`,
    name,
    parentId: null,
    transform: createTransform(position),
    components: [],
  };
}

describe('collectSceneStats', () => {
  let scene: Scene;
  let bridge: RenderBridge;

  beforeEach(() => {
    scene = new Scene();
    bridge = new RenderBridge(scene);
  });

  it('reports an empty scene as empty rather than as zeroes it made up', () => {
    const stats = collectSceneStats(scene, bridge);
    expect(stats.objects.entities).toBe(0);
    expect(stats.triangles.total).toBe(0);
    expect(stats.heaviest).toEqual([]);
  });

  it('counts triangles per entity and names the heaviest', () => {
    // A 64-segment sphere against a box: the same one entity, wildly different cost.
    const box = createPrimitiveEntity('Box', { name: 'Box' });
    const sphere = createPrimitiveEntity('Sphere', { name: 'Sphere' });
    const renderer = sphere.components.find((c) => c.type === 'MeshRenderer')!;
    Object.assign(renderer.params as Record<string, number>, {
      widthSegments: 64,
      heightSegments: 48,
    });
    scene.add(box);
    scene.add(sphere);

    const stats = collectSceneStats(scene, bridge);
    expect(stats.objects.meshes).toBe(2);
    expect(stats.heaviest[0]!.name).toBe('Sphere');
    expect(stats.heaviest[0]!.triangles).toBeGreaterThan(stats.heaviest[1]!.triangles * 10);
    // Every triangle is accounted for by exactly one entity.
    const attributed = stats.heaviest.reduce((sum, entry) => sum + entry.triangles, 0);
    expect(attributed).toBe(stats.triangles.total);
  });

  it('separates hidden geometry from visible, since one costs frame time and one does not', () => {
    const shown = createPrimitiveEntity('Box', { name: 'Shown' });
    const hidden = createPrimitiveEntity('Box', { name: 'Hidden' });
    const renderer = hidden.components.find((c) => c.type === 'MeshRenderer')!;
    renderer.visible = false;
    scene.add(shown);
    scene.add(hidden);

    const stats = collectSceneStats(scene, bridge);
    expect(stats.triangles.total).toBe(stats.triangles.visible + stats.triangles.hidden);
    expect(stats.triangles.hidden).toBeGreaterThan(0);
    expect(stats.objects.hiddenMeshes).toBe(1);
  });

  it('shares one geometry between identical objects, so `unique` stays flat', () => {
    for (let i = 0; i < 5; i += 1) {
      const box = createPrimitiveEntity('Box', { name: `Box ${i}`, position: [i * 2, 0, 0] });
      scene.add(box);
    }

    const stats = collectSceneStats(scene, bridge);
    // Five draw calls, five copies of the triangles — but one geometry in memory. Knowing
    // which of the two numbers is large is the whole point of reporting both.
    expect(stats.objects.meshes).toBe(5);
    expect(stats.objects.uniqueGeometries).toBe(1);
    expect(stats.triangles.total).toBe(stats.triangles.unique * 5);
  });

  it('multiplies shadow-casting geometry by the number of shadow lights', () => {
    scene.add(createPrimitiveEntity('Box', { name: 'Caster' }));

    const none = collectSceneStats(scene, bridge, { activeShadowCasters: 0 });
    const three = collectSceneStats(scene, bridge, { activeShadowCasters: 3 });

    expect(none.triangles.shadowPass).toBe(0);
    expect(three.triangles.shadowPass).toBe(none.triangles.total * 3);
  });

  it('counts every component type, including ones it does not recognise', () => {
    const entity = createPrimitiveEntity('Box', { name: 'Busy' });
    entity.components.push(
      createCollider(),
      createRigidBody(),
      createScript({ name: 'One' }),
      createScript({ name: 'Two' }),
      // A type from a newer build. Silently omitting it would make the census untrustworthy.
      { type: 'FromTheFuture', mystery: true },
    );
    scene.add(entity);

    const { components } = collectSceneStats(scene, bridge).objects;
    expect(components.Script).toBe(2);
    expect(components.Collider).toBe(1);
    expect(components.RigidBody).toBe(1);
    expect(components.FromTheFuture).toBe(1);
  });

  it('reports the nesting depth, which is a hint at per-frame matrix work', () => {
    const root = empty('Root');
    scene.add(root);
    const child = empty('Child');
    child.parentId = root.id;
    scene.add(child);
    const grandchild = empty('Grandchild');
    grandchild.parentId = child.id;
    scene.add(grandchild);

    const stats = collectSceneStats(scene, bridge);
    expect(stats.objects.entities).toBe(3);
    expect(stats.objects.rootEntities).toBe(1);
    expect(stats.objects.maxDepth).toBe(2);
  });

  it('censuses lights by type', () => {
    const sun = empty('Sun');
    sun.components.push(createLight({ lightType: 'Directional' }));
    scene.add(sun);

    const lamp = empty('Lamp', [3, 2, 0]);
    lamp.components.push(createLight({ lightType: 'Point' }));
    scene.add(lamp);

    const off = empty('Off', [6, 2, 0]);
    off.components.push(createLight({ lightType: 'Point', enabled: false }));
    scene.add(off);

    const { lights } = collectSceneStats(scene, bridge);
    expect(lights.total).toBe(3);
    expect(lights.enabled).toBe(2);
    expect(lights.byType).toEqual({ Directional: 1, Point: 2 });
  });

  it('honours the topCount cap', () => {
    for (let i = 0; i < 20; i += 1) {
      scene.add(createPrimitiveEntity('Box', { name: `Box ${i}`, position: [i * 2, 0, 0] }));
    }
    expect(collectSceneStats(scene, bridge, { topCount: 3 }).heaviest).toHaveLength(3);
  });

  /**
   * The bug this covers: the Performance panel's stress harness is added to the render host's
   * scene rather than to the bridge, so loading the Forest preset put four thousand cones on
   * screen and every number in the Statistics panel stayed exactly where it was.
   */
  describe('geometry that belongs to no entity', () => {
    /** Stand-in for the stress harness: a root the bridge knows nothing about. */
    function harness(instances: number): THREE.Group {
      const root = new THREE.Group();
      root.name = 'StressScene';
      const mesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial(),
        instances,
      );
      mesh.castShadow = true;
      root.add(mesh);
      return root;
    }

    it('counts it, because the frame draws it whoever put it there', () => {
      scene.add(createPrimitiveEntity('Box', { name: 'Crate' }));
      const authored = collectSceneStats(scene, bridge);

      const stats = collectSceneStats(scene, bridge, { extraRoots: [harness(100)] });
      // 100 boxes of 12 triangles each, on top of whatever the scene already had.
      expect(stats.triangles.total).toBe(authored.triangles.total + 1200);
      expect(stats.triangles.visible).toBe(authored.triangles.visible + 1200);
      expect(stats.objects.scatterInstances).toBe(100);
      expect(stats.objects.drawCallEstimate).toBe(authored.objects.drawCallEstimate + 1);
    });

    it('leaves the entity census alone, because the harness owns no entities', () => {
      scene.add(createPrimitiveEntity('Box', { name: 'Crate' }));
      const stats = collectSceneStats(scene, bridge, { extraRoots: [harness(50)] });
      expect(stats.objects.entities).toBe(1);
      expect(stats.objects.externalMeshes).toBe(1);
    });

    it('names it in the heaviest table but leaves it unselectable', () => {
      scene.add(createPrimitiveEntity('Box', { name: 'Crate' }));
      const { heaviest } = collectSceneStats(scene, bridge, { extraRoots: [harness(500)] });

      const external = heaviest.find((entry) => entry.kind === 'external');
      expect(external?.name).toBe('StressScene');
      expect(external?.instances).toBe(500);
      // No entity behind it, so the panel must not offer a row that selects nothing.
      expect(external?.id).toBe('');
      // Far heavier than the one authored box, so it sorts to the top.
      expect(heaviest[0]).toBe(external);
    });

    it('shares geometry with the scene, so `unique` does not double-count it', () => {
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const first = new THREE.Group();
      first.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
      const second = new THREE.Group();
      second.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));

      const stats = collectSceneStats(scene, bridge, { extraRoots: [first, second] });
      expect(stats.triangles.total).toBe(24);
      expect(stats.triangles.unique).toBe(12);
    });
  });
});
