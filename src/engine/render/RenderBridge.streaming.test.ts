import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import '../components';
import { Scene } from '../scene/Scene';
import { createPrimitiveEntity } from '../scene/primitives';
import { RenderBridge } from './RenderBridge';

/**
 * The seam between the bridge (which decides what is in the tree) and Origo (which decides
 * whether it should be there right now) — ARCHITECTURE.md §9.2. `RenderHost.render()` is the
 * real caller of `updateStreaming`, once per frame; it needs a WebGL context this environment
 * does not have, so these call it directly the same way `shading.test.ts` reproduces the host's
 * shading pass rather than constructing one.
 */
describe('RenderBridge streaming', () => {
  it('keeps a nearby entity visible and unloads a distant one', () => {
    const scene = new Scene();
    const near = createPrimitiveEntity('Box', { name: 'Near', position: [0, 0, 0] });
    const far = createPrimitiveEntity('Box', { name: 'Far', position: [50_000, 0, 50_000] });
    scene.add(near);
    scene.add(far);

    const bridge = new RenderBridge(scene);
    bridge.updateStreaming(0, 0, 0);

    expect(bridge.objectFor(near.id)?.visible).toBe(true);
    expect(bridge.objectFor(far.id)?.visible).toBe(false);

    bridge.dispose();
  });

  it('reloads an entity once the camera comes back into range', () => {
    const scene = new Scene();
    const entity = createPrimitiveEntity('Box', { name: 'Roamer', position: [3000, 0, 0] });
    scene.add(entity);

    const bridge = new RenderBridge(scene);
    bridge.updateStreaming(0, 0, 0);
    expect(bridge.objectFor(entity.id)?.visible).toBe(false);

    bridge.updateStreaming(3000, 0, 0);
    expect(bridge.objectFor(entity.id)?.visible).toBe(true);

    bridge.dispose();
  });

  it('excludes a streamed-out entity from pickables, so a hidden chunk cannot be clicked', () => {
    const scene = new Scene();
    const far = createPrimitiveEntity('Box', { name: 'Far', position: [80_000, 0, 0] });
    scene.add(far);

    const bridge = new RenderBridge(scene);
    bridge.updateStreaming(0, 0, 0);

    expect(bridge.pickables().some((object) => object.userData.entityId === far.id)).toBe(false);

    bridge.dispose();
  });

  it('suppresses shadow-casting on a far LOD band without touching the authored setting', () => {
    const scene = new Scene();
    const entity = createPrimitiveEntity('Box', { name: 'Distant' });
    scene.add(entity);
    scene.updateComponent(entity.id, 'MeshRenderer', { castShadow: true });

    const bridge = new RenderBridge(scene);
    const mesh = bridge.objectFor(entity.id)?.children.find((c) => (c as THREE.Mesh).isMesh) as
      | THREE.Mesh
      | undefined;
    expect(mesh?.castShadow).toBe(true);

    // Placed just outside the default LOD split (half the load radius) but still inside the
    // load radius itself, so the entity stays loaded — only its LOD band changes.
    const chunkSize = bridge.streamingSystem.chunkSize;
    scene.setTransform(entity.id, { position: [chunkSize * 3, 0, 0] });

    bridge.updateStreaming(0, 0, 0);
    expect(bridge.objectFor(entity.id)?.visible).toBe(true);
    expect(mesh?.castShadow).toBe(false);

    bridge.dispose();
  });
});
