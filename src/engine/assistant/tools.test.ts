import { beforeEach, describe, expect, it } from 'vitest';
import '../components';
import type { MeshRendererComponent } from '../components/MeshRenderer';
import type { ScriptComponent } from '../components/Script';
import { Scene } from '../scene/Scene';
import type { Vec3 } from '../scene/types';
import { DirectSceneEditor } from './SceneEditor';
import { executeTool, listTools, type ToolContext } from './ToolRegistry';
import './tools';

const SPAWN: Vec3 = [1, 0, 2];

let scene: Scene;
let context: ToolContext;

function call(name: string, input: Record<string, unknown> = {}) {
  return executeTool(name, input, context);
}

/** Creates something and hands back its id, which most of these tests need first. */
function createBox(overrides: Record<string, unknown> = {}): string {
  const before = new Set(scene.all().map((entity) => entity.id));
  call('create_primitive', { kind: 'Box', name: 'Crate', ...overrides });
  return scene.all().find((entity) => !before.has(entity.id))!.id;
}

beforeEach(() => {
  scene = new Scene();
  context = { editor: new DirectSceneEditor(scene), spawnPoint: () => [...SPAWN] };
});

describe('tool registry', () => {
  it('registers every built-in tool with a schema', () => {
    const tools = listTools();
    expect(tools.length).toBeGreaterThan(10);
    for (const tool of tools) {
      expect(tool.input.type).toBe('object');
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it('lists tools in a stable order', () => {
    // An unstable tool list rewrites the cached prompt prefix on every request, which throws
    // away prompt caching for the whole conversation.
    expect(listTools().map((tool) => tool.name)).toEqual([...listTools().map((tool) => tool.name)].sort());
  });

  it('answers an unknown tool with the list of real ones', () => {
    const result = call('make_a_house');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('create_primitive');
  });

  it('turns a thrown error into a readable result rather than propagating it', () => {
    const result = call('get_entity', { entity: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('No entity with id or name "nope"');
  });
});

describe('create_primitive', () => {
  it('places an object where the camera is looking when no position is given', () => {
    createBox();
    expect(scene.all()[0]!.transform.position).toEqual(SPAWN);
  });

  it('applies primitive parameters', () => {
    const id = createBox({ params: { width: 4, depth: 2 } });
    const renderer = scene.getComponent<MeshRendererComponent>(id, 'MeshRenderer')!;
    expect(renderer.params.width).toBe(4);
    expect(renderer.params.depth).toBe(2);
  });

  it('rejects a parameter the primitive does not have, and names the ones it does', () => {
    const result = call('create_primitive', { kind: 'Box', params: { size: 4 } });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('no parameter "size"');
    expect(result.text).toContain('width');
    // Nothing partially applied: a rejected call must leave the scene untouched.
    expect(scene.size).toBe(0);
  });

  it('rejects a colour that is not a hex triplet', () => {
    expect(call('create_primitive', { kind: 'Box', color: 'red' }).isError).toBe(true);
  });

  it('keeps names unique', () => {
    createBox();
    createBox();
    expect(scene.all().map((entity) => entity.name).sort()).toEqual(['Crate', 'Crate (1)']);
  });
});

describe('entity references', () => {
  it('accepts a name where an id is expected', () => {
    createBox();
    expect(call('get_entity', { entity: 'Crate' }).isError).toBeUndefined();
  });

  it('refuses to guess when a name is ambiguous', () => {
    const first = createBox();
    // Two entities deliberately given the same name, which only a direct scene write can do.
    scene.add({ ...structuredClone(scene.expect(first)), id: 'duplicate-id' });
    const result = call('get_entity', { entity: 'Crate' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('matches 2 entities');
  });
});

describe('editing', () => {
  it('sets a transform absolutely and relatively', () => {
    const id = createBox();
    call('set_transform', { entity: id, position: [0, 0, 0] });
    call('set_transform', { entity: id, position: [1, 2, 3], relative: true });
    expect(scene.expect(id).transform.position).toEqual([1, 2, 3]);

    call('set_transform', { entity: id, scale: [2, 2, 2], relative: true });
    expect(scene.expect(id).transform.scale).toEqual([2, 2, 2]);
  });

  it('duplicates with a cumulative offset', () => {
    const id = createBox();
    call('set_transform', { entity: id, position: [0, 0, 0] });
    call('duplicate_entity', { entity: id, count: 3, offset: [2, 0, 0] });

    const xs = scene.all().map((entity) => entity.transform.position[0]).sort((a, b) => a - b);
    expect(xs).toEqual([0, 2, 4, 6]);
  });

  it('keeps child names when duplicating a rig', () => {
    call('create_prefab', { kind: 'Player' });
    const player = scene.all().find((entity) => entity.name === 'Player')!;
    call('duplicate_entity', { entity: player.id });

    const cameras = scene.all().filter((entity) => entity.name === 'Player Camera');
    // Both rigs keep a plainly named camera; only the root is disambiguated.
    expect(cameras).toHaveLength(2);
    expect(scene.all().some((entity) => entity.name === 'Player (1)')).toBe(true);
  });

  it('refuses to parent an entity under its own descendant', () => {
    const parent = createBox({ name: 'Parent' });
    call('create_primitive', { kind: 'Box', name: 'Child', parent });
    const child = scene.all().find((entity) => entity.name === 'Child')!;

    const result = call('reparent_entities', { entities: [parent], parent: child.id });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('own descendant');
  });

  it('deletes a subtree with its root', () => {
    const parent = createBox({ name: 'Parent' });
    call('create_primitive', { kind: 'Box', name: 'Child', parent });
    call('delete_entities', { entities: [parent] });
    expect(scene.size).toBe(0);
  });
});

describe('components', () => {
  it('adds a component with initial values', () => {
    const id = createBox();
    call('add_component', { entity: id, component: 'Light', properties: { lightType: 'Point', intensity: 3 } });
    const light = scene.getComponent(id, 'Light')!;
    expect(light.lightType).toBe('Point');
    expect(light.intensity).toBe(3);
  });

  it('names the valid fields when given one that does not exist', () => {
    const id = createBox();
    const result = call('set_component_property', {
      entities: [id],
      component: 'Material',
      path: 'colour',
      value: '#ff0000',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('color');
  });

  it('will not write a component the entity does not have', () => {
    const id = createBox();
    const result = call('set_component_property', {
      entities: [id],
      component: 'Light',
      path: 'intensity',
      value: 2,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('add_component');
  });

  it('writes one property across several entities', () => {
    const first = createBox({ name: 'A' });
    const second = createBox({ name: 'B' });
    call('set_component_property', {
      entities: [first, second],
      component: 'Material',
      path: 'color',
      value: '#123456',
    });
    expect(scene.getComponent(first, 'Material')!.color).toBe('#123456');
    expect(scene.getComponent(second, 'Material')!.color).toBe('#123456');
  });
});

describe('set_script', () => {
  it('adds the component and its props in one call', () => {
    const id = createBox();
    call('set_script', { entity: id, source: 'function update(dt) {}', name: 'Spin', props: { speed: 2 } });
    const script = scene.getComponent<ScriptComponent>(id, 'Script')!;
    expect(script.name).toBe('Spin');
    expect(script.props).toEqual({ speed: 2 });
  });

  it('rejects a prop that would not survive the scene file', () => {
    const id = createBox();
    const result = call('set_script', { entity: id, props: { target: { x: 1 } } });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('number, string or boolean');
  });
});

describe('modifiers', () => {
  it('adds, edits and removes stack entries', () => {
    const id = createBox();
    call('add_modifier', { entity: id, modifier: 'Subdivide', properties: { levels: 2 } });

    const renderer = () => scene.getComponent<MeshRendererComponent>(id, 'MeshRenderer')!;
    expect(renderer().modifiers).toHaveLength(1);
    expect(renderer().modifiers[0]!.levels).toBe(2);

    call('set_modifier_property', { entity: id, index: 0, field: 'levels', value: 3 });
    expect(renderer().modifiers[0]!.levels).toBe(3);

    call('remove_modifier', { entity: id, index: 0 });
    expect(renderer().modifiers).toHaveLength(0);
  });

  it('reports the real fields when given one that does not exist', () => {
    const id = createBox();
    const result = call('add_modifier', { entity: id, modifier: 'Subdivide', properties: { depth: 2 } });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('levels');
  });

  it('refuses an index past the end of the stack', () => {
    const id = createBox();
    expect(call('remove_modifier', { entity: id, index: 4 }).isError).toBe(true);
  });
});

describe('reading the scene', () => {
  it('describes an empty scene without pretending otherwise', () => {
    expect(call('describe_scene').text).toBe('The scene is empty.');
  });

  it('outlines the hierarchy with ids', () => {
    const parent = createBox({ name: 'Parent' });
    call('create_primitive', { kind: 'Sphere', name: 'Child', parent });

    const text = call('describe_scene').text;
    expect(text).toContain(parent);
    expect(text).toContain('  ');
    expect(text).toContain('Child');
  });

  it('filters by component and primitive', () => {
    createBox({ name: 'Crate' });
    call('create_prefab', { kind: 'Point Light' });

    expect(call('find_entities', { primitive: 'Box' }).text).toContain('Crate');
    expect(call('find_entities', { component: 'Light' }).text).not.toContain('Crate');
    expect(call('find_entities', { name: 'crat' }).text).toContain('Crate');
  });

  it('reads capabilities out of the registries rather than a hard-coded list', () => {
    const text = call('list_capabilities').text;
    // Everything the editor can build should be discoverable without a code change here.
    expect(text).toContain('Icosphere');
    expect(text).toContain('NpcAgent');
    expect(text).toContain('Subdivide');
    expect(text).toContain('Zombie');
  });
});
