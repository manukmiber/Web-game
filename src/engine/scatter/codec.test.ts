import { describe, expect, it } from 'vitest';
import { createScatterLayer } from '../components/ScatterLayer';
import {
  decodeBase64,
  decodeFloat32,
  decodeUint16,
  encodeBase64,
  encodeFloat32,
  encodeUint16,
  instanceCountOf,
  packInstances,
  unpackInstances,
  type ScatterInstance,
} from './codec';

function instance(overrides: Partial<ScatterInstance> = {}): ScatterInstance {
  return {
    position: [1, 2, 3],
    rotation: [0, 0.7071067811865476, 0, 0.7071067811865476],
    scale: 1.5,
    prototype: 0,
    ...overrides,
  };
}

describe('base64', () => {
  it('round-trips every byte value', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect([...decodeBase64(encodeBase64(bytes))]).toEqual([...bytes]);
  });

  it('pads the three remainder cases', () => {
    expect(encodeBase64(Uint8Array.from([77]))).toBe('TQ==');
    expect(encodeBase64(Uint8Array.from([77, 97]))).toBe('TWE=');
    expect(encodeBase64(Uint8Array.from([77, 97, 110]))).toBe('TWFu');
  });

  it('agrees with the platform encoder', () => {
    const bytes = Uint8Array.from({ length: 61 }, (_, i) => (i * 37) % 256);
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('ignores whitespace and other noise, so a hand-wrapped scene file still reads', () => {
    const encoded = encodeBase64(Uint8Array.from([1, 2, 3, 4, 5, 6]));
    const wrapped = `${encoded.slice(0, 4)}\n  ${encoded.slice(4)}`;
    expect([...decodeBase64(wrapped)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('decodes an empty string to nothing rather than throwing', () => {
    expect(decodeBase64('').length).toBe(0);
    expect(decodeFloat32('').length).toBe(0);
    expect(decodeUint16('').length).toBe(0);
  });
});

describe('typed array codec', () => {
  it('round-trips float32 values exactly', () => {
    const values = Float32Array.from([0, -1.5, 1024.25, 1e-8, -0]);
    expect([...decodeFloat32(encodeFloat32(values))]).toEqual([...values]);
  });

  it('round-trips uint16 values including the ceiling', () => {
    const values = Uint16Array.from([0, 1, 255, 256, 65535]);
    expect([...decodeUint16(encodeUint16(values))]).toEqual([...values]);
  });

  /**
   * Typed-array views read in platform order; a scene file must not. This pins the layout so a
   * change to the codec cannot silently make old scenes unreadable.
   */
  it('writes little-endian regardless of the host', () => {
    // 1.0 as float32 is 0x3F800000, which little-endian puts on the wire as 00 00 80 3F.
    expect([...decodeBase64(encodeFloat32(Float32Array.from([1])))]).toEqual([0, 0, 0x80, 0x3f]);
    expect([...decodeBase64(encodeUint16(Uint16Array.from([0x0102])))]).toEqual([0x02, 0x01]);
  });
});

describe('instance packing', () => {
  it('round-trips instances', () => {
    const source = [
      instance(),
      instance({ position: [-4, 0.5, 12], scale: 0.25, prototype: 2 }),
      instance({ rotation: [0, 0, 0, 1], prototype: 1 }),
    ];
    const packed = packInstances(source);
    expect(packed.instanceCount).toBe(3);

    const back = unpackInstances(packed);
    expect(back).toHaveLength(3);
    for (const [index, original] of source.entries()) {
      const decoded = back[index]!;
      expect(decoded.position).toEqual(original.position);
      expect(decoded.prototype).toBe(original.prototype);
      expect(decoded.scale).toBeCloseTo(original.scale, 6);
      for (let i = 0; i < 4; i += 1) {
        expect(decoded.rotation[i]!).toBeCloseTo(original.rotation[i]!, 6);
      }
    }
  });

  it('packs nothing into empty strings rather than a header', () => {
    expect(packInstances([])).toEqual({ instances: '', variants: '', instanceCount: 0 });
    expect(unpackInstances(createScatterLayer())).toEqual([]);
  });

  /**
   * `instanceCount` is a convenience field a human can edit in a scene file. The buffers are the
   * authority, so a wrong count must never make the decoder read past the end of the array.
   */
  it('never reads past the buffer when instanceCount lies', () => {
    const packed = packInstances([instance(), instance()]);
    const inflated = { ...packed, instanceCount: 9999 };
    expect(instanceCountOf(inflated)).toBe(2);
    expect(unpackInstances(inflated)).toHaveLength(2);
  });

  it('honours a count smaller than the buffer, so a layer can be trimmed without re-packing', () => {
    const packed = packInstances([instance(), instance(), instance()]);
    expect(unpackInstances({ ...packed, instanceCount: 1 })).toHaveLength(1);
  });

  it('survives a truncated payload with what it can read', () => {
    const packed = packInstances([instance(), instance()]);
    // Drop the tail: half an instance is unreadable, the first one is not.
    const truncated = { ...packed, instances: packed.instances.slice(0, 24) };
    expect(unpackInstances(truncated).length).toBeLessThanOrEqual(1);
  });

  it('defaults a missing variant to prototype zero', () => {
    const packed = packInstances([instance(), instance()]);
    const decoded = unpackInstances({ ...packed, variants: '' });
    expect(decoded.map((i) => i.prototype)).toEqual([0, 0]);
  });
});
