import * as THREE from 'three';
import type { RenderBridge } from '../render/RenderBridge';
import type { Scene } from '../scene/Scene';
import type { EntityId } from '../scene/types';

/**
 * A detailed census of what is in the scene and what it costs.
 *
 * `renderer.info` already reports the two headline numbers — draw calls and triangles — and
 * they are the two least actionable numbers in the engine. "1.4M triangles" tells you the
 * scene is heavy; it does not tell you that 1.1M of them are one over-subdivided rock you
 * duplicated forty times, which is the fact that actually changes what you do next. This walks
 * the rendered tree and attributes every triangle to the entity that put it there.
 *
 * Distinct from `renderer.info` in one other way worth understanding: this counts what *exists*,
 * not what was drawn. Frustum culling means the renderer's number is usually lower, and the gap
 * between the two is itself informative — a scene where they are equal is a scene where culling
 * is doing nothing for you.
 */

export interface EntityCost {
  /** Empty for `external` rows — there is no entity to select. */
  id: EntityId | '';
  name: string;
  /** Triangles this entity contributes, instances included. */
  triangles: number;
  /** How many copies are drawn — 1 for an ordinary mesh, the batch size for a scatter layer. */
  instances: number;
  /** Draw calls it costs, before culling. */
  drawCalls: number;
  visible: boolean;
  castsShadow: boolean;
  /**
   * `external` is geometry the frame draws that no entity owns — the stress harness. It costs
   * exactly as much as authored geometry does, so it belongs in the table; it just cannot be
   * clicked, because there is nothing to select.
   */
  kind: 'mesh' | 'scatter' | 'external';
}

export interface TriangleBreakdown {
  /** Everything the scene contains, visible or not. */
  total: number;
  /** Only what is currently visible — what the frame would draw with no culling at all. */
  visible: number;
  /** Sitting in hidden entities. Costs memory and nothing else. */
  hidden: number;
  /** From ordinary one-per-entity meshes. */
  meshes: number;
  /** From instanced scatter layers, counted per instance. */
  scatter: number;
  /**
   * Distinct triangles in memory, ignoring instancing.
   *
   * The memory axis, and the one instancing does not help with: a forest of a hundred thousand
   * trees drawn from six prototypes has a huge `scatter` count and a tiny `unique` one, and
   * knowing which of the two is large is what decides whether the fix is fewer objects or
   * simpler ones.
   */
  unique: number;
  /**
   * Triangles re-submitted for shadow maps each frame.
   *
   * A shadow-casting light re-renders every caster from its own point of view, so this is the
   * shadow-casting geometry multiplied by the number of lights that were granted a shadow. It
   * is routinely larger than the visible count, and it is the number that explains why turning
   * on a second shadow light halved the frame rate.
   */
  shadowPass: number;
}

export interface ObjectCensus {
  entities: number;
  rootEntities: number;
  /** Deepest parent chain in the scene. A hint at how much matrix work a frame does. */
  maxDepth: number;
  meshes: number;
  hiddenMeshes: number;
  scatterLayers: number;
  scatterInstances: number;
  /** Distinct geometries and materials held by the render caches, after sharing. */
  uniqueGeometries: number;
  uniqueMaterials: number;
  /** Draw calls the scene should cost before culling — one per mesh, one per scatter batch. */
  drawCallEstimate: number;
  vertices: number;
  /**
   * Meshes the frame draws that belong to no entity — currently the stress harness.
   *
   * They are already inside `meshes`, `drawCallEstimate` and every triangle count, because the
   * GPU does not care who put them there. This is the one number that explains why those totals
   * are larger than `entities` can account for.
   */
  externalMeshes: number;
  /** Every component type in the scene and how many there are. */
  components: Record<string, number>;
}

export interface LightCensus {
  total: number;
  enabled: number;
  requestedShadows: number;
  activeShadows: number;
  byType: Record<string, number>;
}

export interface SceneStats {
  triangles: TriangleBreakdown;
  objects: ObjectCensus;
  lights: LightCensus;
  /** The heaviest entities, worst first. This is the list you act on. */
  heaviest: EntityCost[];
}

export interface SceneStatsOptions {
  /** How many entries the `heaviest` list carries. */
  topCount?: number;
  /** Shadow-casting lights the budget granted, for the shadow-pass estimate. */
  activeShadowCasters?: number;
  /**
   * Object trees the frame draws that the render bridge does not own — the stress harness.
   *
   * Without this the panel measured the wrong thing entirely: the harness is added straight to
   * the render host's scene, so loading the Forest preset put four thousand cones and sixty
   * thousand triangles in front of the camera and every number here stayed exactly where it
   * was. A census of "what this frame costs" that ignores most of what the frame draws is worse
   * than no census, because it reads as a fact.
   */
  extraRoots?: THREE.Object3D[];
}

const DEFAULT_TOP_COUNT = 8;

/**
 * Walks the scene and its rendered tree and produces the whole census in one pass.
 *
 * One pass rather than a method per statistic, because every one of them needs the same walk
 * and the panel wants all of them at once — computing them separately would traverse a scene
 * of ten thousand objects a dozen times to fill one table.
 */
export function collectSceneStats(
  scene: Scene,
  bridge: RenderBridge,
  options: SceneStatsOptions = {},
): SceneStats {
  const topCount = options.topCount ?? DEFAULT_TOP_COUNT;
  const shadowLights = Math.max(0, options.activeShadowCasters ?? 0);

  const costs = new Map<string, EntityCost>();
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();

  let meshTriangles = 0;
  let scatterTriangles = 0;
  let hiddenTriangles = 0;
  let uniqueTriangles = 0;
  let shadowTriangles = 0;
  let vertices = 0;
  let meshes = 0;
  let hiddenMeshes = 0;
  let scatterBatches = 0;
  let scatterInstances = 0;
  let drawCalls = 0;
  let externalMeshes = 0;

  /**
   * One root's worth of the walk.
   *
   * `external` roots are counted into every total exactly the way the bridge's own are — a
   * triangle costs the same whoever put it there — but they are attributed to the root itself
   * rather than to an entity, because they have none.
   */
  const walk = (root: THREE.Object3D, external: boolean) => {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;

      const instanced = mesh as THREE.InstancedMesh;
      const isScatter = instanced.isInstancedMesh === true;
      const count = isScatter ? instanced.count : 1;
      const perInstance = geometryTriangles(mesh.geometry);
      const total = perInstance * count;

      // `entityVisible` is what the bridge records when an entity is hidden on purpose; `visible`
      // alone is unreliable here because the shading pass rewrites it for wireframe modes.
      // External roots never go through that pass, so their own flag is the honest answer.
      const visible = external ? mesh.visible : mesh.userData.entityVisible !== false;

      if (!geometries.has(mesh.geometry)) {
        geometries.add(mesh.geometry);
        uniqueTriangles += perInstance;
        vertices += geometryVertices(mesh.geometry);
      }
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (material) materials.add(material);
      }

      if (isScatter) {
        scatterTriangles += total;
        scatterBatches += 1;
        scatterInstances += count;
      } else {
        meshTriangles += total;
        meshes += 1;
        if (!visible) hiddenMeshes += 1;
      }
      if (external) externalMeshes += 1;

      if (!visible) hiddenTriangles += total;
      if (mesh.castShadow && visible) shadowTriangles += total;
      drawCalls += 1;

      const id = mesh.userData.entityId as EntityId | undefined;
      // External geometry collapses to one row per root: four thousand harness cones listed
      // individually would push every authored object out of a table that exists to name the
      // authored object you should go and fix.
      const key = id ?? (external ? `external:${root.uuid}` : null);
      if (!key) return;

      const existing = costs.get(key);
      if (existing) {
        existing.triangles += total;
        existing.instances += count;
        existing.drawCalls += 1;
        existing.castsShadow ||= mesh.castShadow;
        return;
      }
      costs.set(key, {
        id: id ?? '',
        name: id ? (scene.get(id)?.name ?? id) : (root.name || 'External geometry'),
        triangles: total,
        instances: count,
        drawCalls: 1,
        visible,
        castsShadow: mesh.castShadow,
        kind: external && !id ? 'external' : isScatter ? 'scatter' : 'mesh',
      });
    });
  };

  walk(bridge.root, false);
  for (const root of options.extraRoots ?? []) walk(root, true);

  const totalTriangles = meshTriangles + scatterTriangles;

  return {
    triangles: {
      total: totalTriangles,
      visible: totalTriangles - hiddenTriangles,
      hidden: hiddenTriangles,
      meshes: meshTriangles,
      scatter: scatterTriangles,
      unique: uniqueTriangles,
      shadowPass: shadowTriangles * shadowLights,
    },
    objects: {
      ...countEntities(scene),
      meshes,
      hiddenMeshes,
      scatterLayers: scatterBatches,
      scatterInstances,
      uniqueGeometries: geometries.size,
      uniqueMaterials: materials.size,
      drawCallEstimate: drawCalls,
      vertices,
      externalMeshes,
      components: countComponents(scene),
    },
    lights: bridge.lightSummary(),
    heaviest: [...costs.values()]
      .sort((a, b) => b.triangles - a.triangles)
      .slice(0, topCount),
  };
}

/** Entity counts that come from the data model rather than the rendered tree. */
function countEntities(scene: Scene): Pick<ObjectCensus, 'entities' | 'rootEntities' | 'maxDepth'> {
  let maxDepth = 0;
  const depthOf = (id: EntityId): number => {
    // Walks up rather than recursing down, so a cycle in malformed data cannot hang the panel.
    let depth = 0;
    let current = scene.get(id)?.parentId ?? null;
    const guard = new Set<EntityId>([id]);
    while (current && !guard.has(current)) {
      guard.add(current);
      depth += 1;
      current = scene.get(current)?.parentId ?? null;
    }
    return depth;
  };

  for (const entity of scene.all()) maxDepth = Math.max(maxDepth, depthOf(entity.id));

  return {
    entities: scene.size,
    rootEntities: scene.rootIds().length,
    maxDepth,
  };
}

/**
 * Every component type and how many of it there is.
 *
 * Counted from the raw component arrays rather than from a registry lookup, so unknown types
 * from a newer build appear in the table too — they are still objects in the scene, and a
 * census that quietly omits what it does not recognise is a census you cannot trust.
 */
function countComponents(scene: Scene): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entity of scene.all()) {
    for (const component of entity.components) {
      counts[component.type] = (counts[component.type] ?? 0) + 1;
    }
  }
  return counts;
}

function geometryTriangles(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  if (index) return index.count / 3;
  const position = geometry.getAttribute('position');
  return position ? position.count / 3 : 0;
}

function geometryVertices(geometry: THREE.BufferGeometry): number {
  return geometry.getAttribute('position')?.count ?? 0;
}
