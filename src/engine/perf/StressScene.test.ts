import { describe, expect, it } from 'vitest';
import { CITY_PRESET, FOREST_PRESET, StressScene, type StressParams } from './StressScene';

const small = (overrides: Partial<StressParams> = {}): StressParams => ({
  ...FOREST_PRESET,
  extent: 50,
  density: 1,
  ...overrides,
});

describe('StressScene', () => {
  it('is deterministic for a given seed', () => {
    const a = new StressScene(small({ seed: 42 }));
    const b = new StressScene(small({ seed: 42 }));

    expect(a.getStats()).toEqual(b.getStats());
    a.dispose();
    b.dispose();
  });

  it('produces different content for a different seed', () => {
    const a = new StressScene(small({ seed: 1 }));
    const b = new StressScene(small({ seed: 2 }));

    // Object counts can coincide; the triangle totals depend on the randomised geometry, so
    // they are what actually shows the layouts differ.
    expect(a.getStats().triangles).not.toBe(b.getStats().triangles);
    a.dispose();
    b.dispose();
  });

  it('collapses instanced content to one draw call per prototype', () => {
    const scene = new StressScene(small({ instanced: true, uniqueMeshes: 4 }));
    const stats = scene.getStats();

    expect(stats.objects).toBeGreaterThan(50);
    // 4 prototypes plus the ground.
    expect(stats.expectedDrawCalls).toBe(5);
    scene.dispose();
  });

  it('costs one draw call per object when not instanced', () => {
    const scene = new StressScene(small({ instanced: false, uniqueMeshes: 4 }));
    const stats = scene.getStats();

    expect(stats.expectedDrawCalls).toBe(stats.objects + 1);
    scene.dispose();
  });

  it('scales object count with density', () => {
    const sparse = new StressScene(small({ density: 0.5 }));
    const dense = new StressScene(small({ density: 2 }));

    expect(dense.getStats().objects).toBeGreaterThan(sparse.getStats().objects * 2);
    sparse.dispose();
    dense.dispose();
  });

  it('drops content beyond the render distance', () => {
    const near = new StressScene(small({ extent: 200, renderDistance: 50 }));
    const far = new StressScene(small({ extent: 200, renderDistance: 200 }));

    expect(near.getStats().objects).toBeLessThan(far.getStats().objects);
    near.dispose();
    far.dispose();
  });

  it('gives the two presets opposite shapes', () => {
    const forest = new StressScene({ ...FOREST_PRESET, extent: 100 });
    const city = new StressScene({ ...CITY_PRESET, extent: 100 });

    // Forest: many objects, few unique meshes, few draw calls.
    // City: fewer objects, many unique meshes, a draw call each.
    expect(forest.getStats().objects).toBeGreaterThan(city.getStats().objects);
    expect(forest.getStats().uniqueGeometries).toBeLessThan(city.getStats().uniqueGeometries);
    expect(forest.getStats().expectedDrawCalls).toBeLessThan(city.getStats().expectedDrawCalls);

    forest.dispose();
    city.dispose();
  });

  it('replaces its contents on rebuild rather than accumulating them', () => {
    const scene = new StressScene(small({ seed: 1 }));
    const first = scene.root.children.length;

    scene.rebuild(small({ seed: 1 }));
    expect(scene.root.children.length).toBe(first);

    scene.dispose();
  });
});
