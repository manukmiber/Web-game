import * as THREE from 'three';
import type { RenderBridge } from '@engine/render/RenderBridge';
import type { EntityId } from '@engine/scene/types';

const SELECTION_COLOR = 0x4a9eff;

/**
 * Wireframe boxes around the selection.
 *
 * Lives in an overlay scene rather than in the RenderBridge on purpose: selection is an
 * editor concept, and the bridge has to stay usable by a runtime that has no notion of it
 * (ARCHITECTURE.md §2). Rebuilt on demand rather than tracked per frame — selections change
 * on interaction, not continuously.
 */
export class SelectionOutline {
  readonly object = new THREE.Group();
  private boxes: THREE.Box3Helper[] = [];

  constructor(private readonly bridge: RenderBridge) {
    this.object.name = 'SelectionOutline';
  }

  update(ids: EntityId[]): void {
    this.clear();
    for (const id of ids) {
      const target = this.bridge.objectFor(id);
      if (!target) continue;
      const box = new THREE.Box3().setFromObject(target);
      // An Empty has no geometry, so the box collapses to a point. Give it a visible size so
      // group nodes can still be seen and grabbed.
      if (box.isEmpty()) {
        const origin = target.getWorldPosition(new THREE.Vector3());
        box.setFromCenterAndSize(origin, new THREE.Vector3(0.5, 0.5, 0.5));
      }
      const helper = new THREE.Box3Helper(box, new THREE.Color(SELECTION_COLOR));
      // Draw over the geometry so the outline reads on top of the object it wraps.
      const material = helper.material as THREE.LineBasicMaterial;
      material.depthTest = false;
      material.transparent = true;
      helper.renderOrder = 999;
      this.boxes.push(helper);
      this.object.add(helper);
    }
  }

  private clear(): void {
    for (const helper of this.boxes) {
      helper.removeFromParent();
      helper.geometry.dispose();
      (helper.material as THREE.Material).dispose();
    }
    this.boxes = [];
  }

  dispose(): void {
    this.clear();
    this.object.removeFromParent();
  }
}
