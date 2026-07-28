import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import '../components';
import { AssetStore } from '../assets/AssetStore';
import { createMaterial, usesPhysicalFeatures } from '../components/Material';
import {
  bindAssetStore,
  disposeMaterial,
  materialCache,
  materialKey,
  needsSecondUv,
  refreshMaterialTextures,
} from './material';

/** A 1x1 texture standing in for a decoded asset. `AssetStore.put` is the procedural path. */
function storeWith(...ids: string[]): AssetStore {
  const store = new AssetStore();
  for (const id of ids) store.put(id, new THREE.Texture());
  bindAssetStore(store);
  return store;
}

afterEach(() => {
  materialCache.disposeAll();
});

describe('material key', () => {
  it('round-trips every field', () => {
    const component = createMaterial({
      color: '#ff8800',
      metalness: 0.75,
      roughness: 0.15,
      normalMap: 'tex-n',
      normalScale: 2,
      emissive: '#112233',
      clearcoat: 0.5,
      transmission: 0.25,
      ior: 1.33,
      tiling: [3, 4],
      offset: [0.25, 0.5],
      flatShading: true,
    });

    // The key is the cache's identity *and* the factory's only input, so a field that does not
    // survive the round trip is a field that silently reverts to its default on screen.
    const rebuilt = JSON.parse(materialKey(component)) as Record<string, unknown>;
    for (const [field, value] of Object.entries(component)) {
      if (field === 'type') continue;
      expect(rebuilt[field]).toEqual(value);
    }
  });

  it('gives identical components the same key and different ones different keys', () => {
    expect(materialKey(createMaterial({ roughness: 0.3 }))).toBe(
      materialKey(createMaterial({ roughness: 0.3 })),
    );
    expect(materialKey(createMaterial({ roughness: 0.3 }))).not.toBe(
      materialKey(createMaterial({ roughness: 0.31 })),
    );
  });

  it('is stable against field order and against unknown fields', () => {
    const a = materialKey(createMaterial({ roughness: 0.3, metalness: 0.6 }));
    const b = materialKey({ ...createMaterial({ metalness: 0.6, roughness: 0.3 }), future: 1 });
    // An unknown field from a newer build must not fragment the cache: it changes nothing about
    // the resulting material, so two entities that look identical should still share one.
    expect(a).toBe(b);
  });

  it('fills in defaults for a component saved before a field existed', () => {
    // Scenes from v0.7.5 have eight of these fields and none of the rest.
    const legacy = { type: 'Material', color: '#ffffff', metalness: 0, roughness: 0.5 } as never;
    const parsed = JSON.parse(materialKey(legacy)) as Record<string, unknown>;
    expect(parsed.clearcoat).toBe(0);
    expect(parsed.tiling).toEqual([1, 1]);
    expect(parsed.normalMap).toBeNull();
  });
});

describe('choosing a program', () => {
  it('stays on the standard material for an ordinary surface', () => {
    const material = materialCache.acquire(materialKey(createMaterial({ roughness: 0.4 })));
    // The physical material compiles clearcoat, sheen and transmission into every fragment. A
    // scene of painted crates should not pay for lobes it left at zero.
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(material).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
  });

  it.each([
    ['clearcoat', { clearcoat: 0.5 }],
    ['sheen', { sheen: 0.3 }],
    ['transmission', { transmission: 0.9 }],
    ['a non-default ior', { ior: 1.33 }],
    ['a non-default specular', { specularIntensity: 0.5 }],
  ])('upgrades to the physical material for %s', (_label, overrides) => {
    const component = createMaterial(overrides);
    expect(usesPhysicalFeatures(component)).toBe(true);
    expect(materialCache.acquire(materialKey(component))).toBeInstanceOf(THREE.MeshPhysicalMaterial);
  });

  it('copies the extension lobes onto the physical material', () => {
    const material = materialCache.acquire(
      materialKey(
        createMaterial({
          clearcoat: 0.6,
          clearcoatRoughness: 0.2,
          sheen: 0.4,
          sheenRoughness: 0.7,
          transmission: 0.8,
          thickness: 2,
          ior: 1.4,
        }),
      ),
    ) as THREE.MeshPhysicalMaterial;

    expect(material.clearcoat).toBeCloseTo(0.6);
    expect(material.clearcoatRoughness).toBeCloseTo(0.2);
    expect(material.sheen).toBeCloseTo(0.4);
    expect(material.sheenRoughness).toBeCloseTo(0.7);
    expect(material.transmission).toBeCloseTo(0.8);
    expect(material.thickness).toBeCloseTo(2);
    expect(material.ior).toBeCloseTo(1.4);
  });

  it('copies the base surface properties', () => {
    const material = materialCache.acquire(
      materialKey(
        createMaterial({
          metalness: 0.9,
          roughness: 0.2,
          emissive: '#ff0000',
          emissiveIntensity: 3,
          flatShading: true,
          wireframe: true,
          doubleSided: true,
        }),
      ),
    ) as THREE.MeshStandardMaterial;

    expect(material.metalness).toBeCloseTo(0.9);
    expect(material.roughness).toBeCloseTo(0.2);
    expect(material.emissiveIntensity).toBe(3);
    expect(material.flatShading).toBe(true);
    expect(material.wireframe).toBe(true);
    expect(material.side).toBe(THREE.DoubleSide);
  });
});

describe('texture slots', () => {
  it('decodes a colour map as sRGB and a data map as linear', () => {
    storeWith('albedo', 'normals');
    const material = materialCache.acquire(
      materialKey(createMaterial({ map: 'albedo', normalMap: 'normals' })),
    ) as THREE.MeshStandardMaterial;

    expect(material.map?.colorSpace).toBe(THREE.SRGBColorSpace);
    // A normal map encodes directions, not colour. Decoding it as sRGB bends every normal
    // towards the surface, which reads as a bump map that is weak in the mid-tones.
    expect(material.normalMap?.colorSpace).toBe(THREE.NoColorSpace);
  });

  it('fills every slot it is given', () => {
    storeWith('t');
    const material = materialCache.acquire(
      materialKey(
        createMaterial({
          map: 't',
          normalMap: 't',
          roughnessMap: 't',
          metalnessMap: 't',
          aoMap: 't',
          emissiveMap: 't',
          displacementMap: 't',
        }),
      ),
    ) as THREE.MeshStandardMaterial;

    for (const slot of [
      material.map,
      material.normalMap,
      material.roughnessMap,
      material.metalnessMap,
      material.aoMap,
      material.emissiveMap,
      material.displacementMap,
    ]) {
      expect(slot).not.toBeNull();
    }
  });

  it('applies tiling and offset per material', () => {
    storeWith('t');
    const tiled = materialCache.acquire(
      materialKey(createMaterial({ map: 't', tiling: [4, 2], offset: [0.5, 0.25] })),
    ) as THREE.MeshStandardMaterial;
    const plain = materialCache.acquire(
      materialKey(createMaterial({ map: 't' })),
    ) as THREE.MeshStandardMaterial;

    expect(tiled.map!.repeat.x).toBe(4);
    expect(tiled.map!.repeat.y).toBe(2);
    expect(tiled.map!.offset.x).toBe(0.5);
    // `repeat` lives on the texture, not the material, so two materials tiling one asset
    // differently cannot share a texture object. Each holds its own view.
    expect(plain.map!.repeat.x).toBe(1);
    expect(plain.map).not.toBe(tiled.map);
  });

  it('never hands out the asset store’s own texture', () => {
    const store = storeWith('t');
    const material = materialCache.acquire(
      materialKey(createMaterial({ map: 't' })),
    ) as THREE.MeshStandardMaterial;

    expect(material.map).not.toBe(store.getTexture('t'));
    // Shared image, separate sampler view: Three refcounts sources, so the pixels are uploaded
    // once however many materials reference the asset.
    expect(material.map!.source).toBe(store.getTexture('t')!.source);
  });

  it('leaves the store’s texture usable after a material is disposed', () => {
    const store = storeWith('t');
    const key = materialKey(createMaterial({ map: 't' }));
    materialCache.acquire(key);
    materialCache.release(key);

    // An earlier version disposed `material.map` — which was the store's texture, shared with
    // every other material using the asset — so releasing one material blanked it everywhere.
    const rebuilt = materialCache.acquire(key) as THREE.MeshStandardMaterial;
    expect(store.getTexture('t')).not.toBeNull();
    expect(rebuilt.map).not.toBeNull();
  });

  it('disposes the views it owns', () => {
    storeWith('t');
    const material = materialCache.acquire(
      materialKey(createMaterial({ map: 't', normalMap: 't' })),
    ) as THREE.MeshStandardMaterial;

    let disposed = 0;
    material.map!.addEventListener('dispose', () => {
      disposed += 1;
    });
    material.normalMap!.addEventListener('dispose', () => {
      disposed += 1;
    });

    disposeMaterial(material);
    expect(disposed).toBe(2);
  });

  it('picks up a texture that finished decoding after the material was built', () => {
    const store = storeWith();
    const material = materialCache.acquire(
      materialKey(createMaterial({ map: 'late' })),
    ) as THREE.MeshStandardMaterial;
    expect(material.map).toBeNull();

    store.put('late', new THREE.Texture());
    refreshMaterialTextures('late');

    // Without this hook a material built while its image was in flight stayed untextured for the
    // rest of the session, which reads as "textures work sometimes".
    expect(material.map).not.toBeNull();
    expect(material.map!.colorSpace).toBe(THREE.SRGBColorSpace);
  });

  it('ignores a refresh for an asset it does not use', () => {
    const store = storeWith('a');
    const material = materialCache.acquire(
      materialKey(createMaterial({ map: 'a' })),
    ) as THREE.MeshStandardMaterial;
    const before = material.map;

    store.put('b', new THREE.Texture());
    refreshMaterialTextures('b');

    expect(material.map).toBe(before);
  });
});

describe('second uv set', () => {
  it('is needed only by the occlusion map', () => {
    // Three samples `aoMap` through `uv1`, the glTF convention for a baked pass with its own
    // atlas. Our primitives generate one set, so the bridge has to alias it.
    expect(needsSecondUv(createMaterial({ aoMap: 'x' }))).toBe(true);
    expect(needsSecondUv(createMaterial({ normalMap: 'x' }))).toBe(false);
    expect(needsSecondUv(createMaterial())).toBe(false);
  });
});
