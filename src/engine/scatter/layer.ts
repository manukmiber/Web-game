/**
 * What a `ScatterLayer` component means, for everything that is not the renderer.
 *
 * The Inspector panel, the assistant tool and any future runtime all want the same three
 * answers — what brush is this layer using, what does refilling it produce, and which entities
 * are its prototypes — and none of them should be re-deriving those from raw component fields.
 */

import { createMaterial, type MaterialComponent } from '../components/Material';
import type { MeshRendererComponent } from '../components/MeshRenderer';
import type { ScatterLayerComponent, ScatterPrototype } from '../components/ScatterLayer';
import type { Scene } from '../scene/Scene';
import { generateEntityId } from '../scene/Scene';
import type { Entity, EntityId } from '../scene/types';
import { instanceCountOf, packInstances, unpackInstances, type ScatterData } from './codec';
import { generateScatter, normalizeBrush, scatterCount, type ScatterBrush } from './generate';

/** The brush settings a layer carries, with everything missing or invalid filled in. */
export function brushOf(component: Partial<ScatterLayerComponent>): ScatterBrush {
  return normalizeBrush({
    seed: component.seed as number,
    shape: component.shape,
    extentX: component.extentX as number,
    extentZ: component.extentZ as number,
    density: component.density as number,
    maxInstances: component.maxInstances as number,
    minScale: component.minScale as number,
    maxScale: component.maxScale as number,
    randomYaw: component.randomYaw as boolean,
    groundHeight: component.groundHeight as number,
  });
}

export function prototypesOf(component: Partial<ScatterLayerComponent>): ScatterPrototype[] {
  return Array.isArray(component.prototypes) ? component.prototypes : [];
}

/** A fresh prototype entry pointing at an entity. */
export function createPrototype(sourceId: EntityId, weight = 1): ScatterPrototype {
  return { id: generateEntityId(), sourceId, weight: weight > 0 ? weight : 1 };
}

/**
 * Re-runs the brush and returns the packed result.
 *
 * Returns the three fields rather than mutating, because in the editor this has to become one
 * undo entry — the caller writes it through a command, and a function that had already changed
 * the component would leave nothing to record.
 */
export function refillLayer(component: Partial<ScatterLayerComponent>): ScatterData {
  const prototypes = prototypesOf(component);
  const instances = generateScatter(
    brushOf(component),
    prototypes.map((prototype) => prototype.weight),
  );
  return packInstances(instances);
}

export interface ScatterStats {
  /** Instances actually stored, which is the buffers' answer and not `instanceCount`'s. */
  instances: number;
  /** What refilling right now would produce — shown next to the button that would do it. */
  wouldPlace: number;
  prototypes: number;
  /** One per prototype that resolves to a mesh, which is what the layer costs to draw. */
  drawCalls: number;
}

export function scatterStats(scene: Scene, component: Partial<ScatterLayerComponent>): ScatterStats {
  const sources = resolveScatterSources(scene, component);
  return {
    instances: instanceCountOf(component),
    wouldPlace: prototypesOf(component).length === 0 ? 0 : scatterCount(brushOf(component)),
    prototypes: prototypesOf(component).length,
    drawCalls: sources.length,
  };
}

export interface ScatterSource {
  /** Index into the layer's prototype list — this is what the variant buffer stores. */
  index: number;
  prototype: ScatterPrototype;
  entity: Entity;
  renderer: MeshRendererComponent;
  material: MaterialComponent;
}

/**
 * Resolves each prototype to the mesh it borrows.
 *
 * A prototype names a source *entity*, so the tree you scatter is a tree you can select, edit
 * and put a modifier stack on — and the whole layer follows. Prototypes whose source has been
 * deleted, or which never had a MeshRenderer, are skipped rather than throwing: a layer that
 * loses one of four prototypes should draw the other three, not disappear.
 */
export function resolveScatterSources(
  scene: Scene,
  component: Partial<ScatterLayerComponent>,
): ScatterSource[] {
  const out: ScatterSource[] = [];
  for (const [index, prototype] of prototypesOf(component).entries()) {
    const entity = scene.get(prototype.sourceId);
    if (!entity) continue;
    const renderer = entity.components.find(
      (c): c is MeshRendererComponent => c.type === 'MeshRenderer',
    );
    if (!renderer) continue;
    const material =
      entity.components.find((c): c is MaterialComponent => c.type === 'Material') ??
      createMaterial();
    out.push({ index, prototype, entity, renderer, material });
  }
  return out;
}

/** Everything the renderer has to watch for, gathered so it can be compared in one place. */
export interface ScatterKey {
  instances: string;
  variants: string;
  count: number;
  prototypes: string;
  visible: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
}

export function scatterKey(component: Partial<ScatterLayerComponent>): ScatterKey {
  return {
    instances: component.instances ?? '',
    variants: component.variants ?? '',
    count: instanceCountOf(component),
    // Small enough to stringify — a layer has a handful of prototypes, not a handful of million.
    prototypes: JSON.stringify(prototypesOf(component)),
    visible: component.visible !== false,
    castShadow: component.castShadow === true,
    receiveShadow: component.receiveShadow !== false,
  };
}

/**
 * Whether a layer still renders the way it did.
 *
 * Rebuilding means allocating an `InstancedMesh` per prototype and writing a matrix per
 * instance, which is not something to redo because an unrelated component changed on the same
 * entity — and `componentsChanged` fires for all of those. The packed buffers are compared by
 * identity first, so the usual "nothing changed" answer costs a pointer comparison rather than
 * a walk over several megabytes of base64.
 */
export function sameScatterKey(a: ScatterKey | null, b: ScatterKey): boolean {
  if (!a) return false;
  return (
    a.instances === b.instances &&
    a.variants === b.variants &&
    a.count === b.count &&
    a.prototypes === b.prototypes &&
    a.visible === b.visible &&
    a.castShadow === b.castShadow &&
    a.receiveShadow === b.receiveShadow
  );
}

export { instanceCountOf, unpackInstances };
