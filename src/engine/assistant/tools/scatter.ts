import { createScatterLayer, type ScatterLayerComponent } from '../../components/ScatterLayer';
import {
  SCATTER_SHAPES,
  brushOf,
  createPrototype,
  refillLayer,
  scatterDemand,
  scatterStats,
} from '../../scatter';
import { generateEntityId } from '../../scene/Scene';
import { createTransform, type Entity, type Vec3 } from '../../scene/types';
import { registerTool } from '../ToolRegistry';
import { vec3Schema } from '../schema';
import { resolveEntity } from './shared';

/**
 * Scatter, as one tool call.
 *
 * "Fill this clearing with trees" is the request this exists for, and it is the one request
 * where the model must *not* be allowed to do the obvious thing — a loop of `create_primitive`
 * would put ten thousand entities in the Hierarchy and take the editor down with it. Giving it
 * a tool that writes the packed format instead is the difference between a feature and a
 * denial-of-service, which is why it is worth its own tool rather than a note in a description.
 *
 * The tool is idempotent on a named layer: calling it twice with the same arguments produces
 * the same forest, because the brush is seeded. Calling it with a new seed re-rolls.
 */
registerTool<{
  layer?: string;
  prototypes: string[];
  weights?: number[];
  position?: number[];
  shape?: string;
  extentX?: number;
  extentZ?: number;
  density?: number;
  seed?: number;
  minScale?: number;
  maxScale?: number;
  randomYaw?: boolean;
  groundHeight?: number;
  maxInstances?: number;
}>({
  name: 'scatter_instances',
  title: 'Scatter instances',
  description:
    'Fills an area with many instances of existing objects — trees, rocks, grass — as ONE ' +
    'entity carrying packed instance data, drawn with one draw call per prototype. ' +
    'Always use this instead of creating many entities: a thousand primitives would be a ' +
    'thousand Hierarchy rows and a thousand draw calls. ' +
    'Name an existing scatter layer to refill it, or omit `layer` to create a new one. ' +
    'The prototypes are entities that already exist and have a mesh; edit one later and every ' +
    'instance of it follows.',
  input: {
    type: 'object',
    properties: {
      layer: {
        type: 'string',
        description:
          'Id or name of an existing scatter layer to refill. Omit to create a new one.',
      },
      prototypes: {
        type: 'array',
        description: 'Ids or names of the entities to scatter. Each must have a mesh.',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 16,
      },
      weights: {
        type: 'array',
        description: 'Relative frequency per prototype, in the same order. Defaults to equal.',
        items: { type: 'number', minimum: 0 },
        maxItems: 16,
      },
      position: vec3Schema('Centre of the scattered area. Defaults to where the camera looks.'),
      shape: { type: 'string', description: 'Area shape.', enum: SCATTER_SHAPES, default: 'Rect' },
      extentX: {
        type: 'number',
        description: 'Half-width in metres for Rect; the radius for Disc.',
        minimum: 0,
        maximum: 5000,
        default: 20,
      },
      extentZ: {
        type: 'number',
        description: 'Half-depth in metres for Rect. Ignored for Disc.',
        minimum: 0,
        maximum: 5000,
        default: 20,
      },
      density: {
        type: 'number',
        description: 'Instances per 100 m². 4 is a sparse wood, 40 is dense undergrowth.',
        minimum: 0,
        maximum: 2000,
        default: 4,
      },
      seed: {
        type: 'integer',
        description: 'Change it to re-roll the same settings into a different layout.',
        minimum: 1,
        default: 1,
      },
      minScale: { type: 'number', description: 'Smallest instance scale.', minimum: 0.001, default: 0.8 },
      maxScale: { type: 'number', description: 'Largest instance scale.', minimum: 0.001, default: 1.25 },
      randomYaw: { type: 'boolean', description: 'Randomly rotate each instance about Y.', default: true },
      groundHeight: { type: 'number', description: 'Local Y for every instance.', default: 0 },
      maxInstances: {
        type: 'integer',
        description: 'Cap, whatever the density works out to.',
        minimum: 0,
        maximum: 200000,
        default: 20000,
      },
    },
    required: ['prototypes'],
  },
  run(input, { editor, spawnPoint }) {
    const sources = input.prototypes.map((reference) => {
      const entity = resolveEntity(editor.scene, reference);
      if (!entity.components.some((component) => component.type === 'MeshRenderer')) {
        throw new Error(
          `"${entity.name}" has no mesh, so there is nothing to scatter. Pick an object with geometry.`,
        );
      }
      return entity;
    });

    const weights = input.weights ?? [];
    if (weights.length > 0 && weights.length !== sources.length) {
      throw new Error(
        `weights has ${weights.length} entries but prototypes has ${sources.length}. Give one weight per prototype, or none at all.`,
      );
    }

    const settings: Partial<ScatterLayerComponent> = {
      prototypes: sources.map((entity, index) => createPrototype(entity.id, weights[index] ?? 1)),
      shape: input.shape as ScatterLayerComponent['shape'],
      extentX: input.extentX,
      extentZ: input.extentZ,
      density: input.density,
      seed: input.seed,
      minScale: input.minScale,
      maxScale: input.maxScale,
      randomYaw: input.randomYaw,
      groundHeight: input.groundHeight,
      maxInstances: input.maxInstances,
    };

    // What was asked for, before the cap. Reported so a request for half a million trees comes
    // back as a number the caller can react to rather than as a silently smaller forest.
    const demand = scatterDemand(brushOf(settings));

    const existing = input.layer ? resolveEntity(editor.scene, input.layer) : null;
    if (existing && !existing.components.some((component) => component.type === 'ScatterLayer')) {
      throw new Error(`"${existing.name}" is not a scatter layer. Omit \`layer\` to create one.`);
    }

    return editor.batch(existing ? `Scatter ${existing.name}` : 'Scatter', () => {
      const layer = createScatterLayer(settings);
      Object.assign(layer, refillLayer(layer));

      let id = existing?.id;
      if (existing) {
        // Replaced wholesale rather than patched field by field: a layer whose prototypes and
        // instance buffer disagree renders trees as rocks.
        editor.removeComponent(existing.id, 'ScatterLayer');
        editor.addComponent(existing.id, layer);
      } else {
        const entity: Entity = {
          id: generateEntityId(),
          name: 'Scatter Layer',
          parentId: null,
          transform: createTransform((input.position as Vec3) ?? spawnPoint()),
          components: [layer],
        };
        editor.add([entity]);
        id = entity.id;
      }

      editor.select(id ? [id] : []);
      const stats = scatterStats(editor.scene, layer);
      const names = sources.map((entity) => entity.name).join(', ');
      return (
        `Scattered ${stats.instances.toLocaleString()} instances of ${names} ` +
        `across ${describeArea(layer)} — ${stats.drawCalls} draw ` +
        `${stats.drawCalls === 1 ? 'call' : 'calls'}, one entity in the Hierarchy.` +
        (demand > stats.instances ? ` Capped at ${layer.maxInstances} of ${demand.toLocaleString()} requested.` : '')
      );
    });
  },
});

function describeArea(layer: ScatterLayerComponent): string {
  if (layer.shape === 'Disc') return `a ${layer.extentX * 2} m disc`;
  return `${layer.extentX * 2} x ${layer.extentZ * 2} m`;
}
