/**
 * The packed instance format, and the only place that knows how to read or write it.
 *
 * ARCHITECTURE.md §9.3 fixed the shape of this before the brush existed, for the reason stated
 * there: scatter output is *not* entities. A million trees as a million entities is not viable
 * in memory, in the Hierarchy or in the draw-call budget, so a layer stores typed arrays and
 * renders through `InstancedMesh`.
 *
 * Two decisions worth recording, because both look odd until you need them:
 *
 * **Base64 rather than an array of numbers.** A scene is JSON. Ten thousand instances written
 * as `[[1.2, 0, 3.4], …]` is roughly 400 KB of text; the same data base64-encoded is 427 KB of
 * *bytes* — but it is one string rather than 80,000 JSON tokens, which is the difference
 * between a parse that takes milliseconds and one that takes seconds. The array form also loses
 * exactly the thing that matters: these are float32 on the way to the GPU, and round-tripping
 * them through decimal text is both larger and lossier.
 *
 * **Explicit little-endian.** `new Float32Array(buffer)` reads in *platform* order, so a scene
 * authored on one machine would decode to garbage on a big-endian one. Nobody is shipping a
 * big-endian browser today, and a save format that silently depends on that is still a bug.
 */

import type { Vec3 } from '../scene/types';
import { SCATTER_FLOATS_PER_INSTANCE } from '../components/ScatterLayer';

/** One placed instance, in the layer entity's local space. */
export interface ScatterInstance {
  position: Vec3;
  /** Rotation as a quaternion [x, y, z, w] — these go to the GPU, never to the Inspector. */
  rotation: [number, number, number, number];
  /** Uniform, because a per-axis scale would cost three floats to buy something nobody paints. */
  scale: number;
  /** Index into the layer's prototype list. */
  prototype: number;
}

/**
 * The three fields of a `ScatterLayerComponent` that describe placed instances.
 *
 * An alias rather than an interface so it carries an implicit index signature: this is spread
 * into component patches and undo commands, both of which take `Record<string, unknown>`.
 */
export type ScatterData = {
  instances: string;
  variants: string;
  instanceCount: number;
};

/**
 * What the readers need, which is less than a whole component.
 *
 * Typed structurally rather than as `Partial<ScatterLayerComponent>` so the output of
 * `packInstances` can be read straight back without being pasted onto a component first — which
 * is exactly what a test, and the Inspector's "what would this produce" readout, want to do.
 */
export interface ScatterReadable {
  instances?: string;
  variants?: string;
  instanceCount?: number;
}

export const EMPTY_SCATTER_DATA: ScatterData = { instances: '', variants: '', instanceCount: 0 };

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse table, built once. -1 marks a character that is not base64 (including padding). */
const LOOKUP = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/**
 * Base64 by hand rather than through `btoa`.
 *
 * `btoa` is a DOM global. ARCHITECTURE.md §9.5 keeps `engine/**` free of those so chunk
 * generation and streaming can move into a Worker later — and the scatter codec is exactly the
 * kind of work that will move.
 */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const triple = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      ALPHABET[(triple >> 18) & 63]! +
      ALPHABET[(triple >> 12) & 63]! +
      ALPHABET[(triple >> 6) & 63]! +
      ALPHABET[triple & 63]!;
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const chunk = bytes[i]! << 16;
    out += ALPHABET[(chunk >> 18) & 63]! + ALPHABET[(chunk >> 12) & 63]! + '==';
  } else if (remaining === 2) {
    const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      ALPHABET[(chunk >> 18) & 63]! +
      ALPHABET[(chunk >> 12) & 63]! +
      ALPHABET[(chunk >> 6) & 63]! +
      '=';
  }
  return out;
}

/**
 * Decodes, skipping anything that is not a base64 character.
 *
 * Lenient on purpose: this data arrives from a scene file a human may have opened in an editor,
 * and a wrapped line or a stray space should cost nothing. A truncated payload decodes to what
 * survived rather than throwing — a layer with half its trees is recoverable, an exception in
 * the middle of a scene load is not.
 */
export function decodeBase64(text: string): Uint8Array {
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? LOOKUP[code]! : -1;
    if (value < 0) continue;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

export function encodeFloat32(values: Float32Array): string {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i += 1) view.setFloat32(i * 4, values[i]!, true);
  return encodeBase64(bytes);
}

export function decodeFloat32(text: string): Float32Array {
  const bytes = decodeBase64(text);
  // Trailing bytes that do not complete a float are dropped rather than read past the end.
  const count = Math.floor(bytes.length / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 4);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export function encodeUint16(values: Uint16Array): string {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i += 1) view.setUint16(i * 2, values[i]!, true);
  return encodeBase64(bytes);
}

export function decodeUint16(text: string): Uint16Array {
  const bytes = decodeBase64(text);
  const count = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i += 1) out[i] = view.getUint16(i * 2, true);
  return out;
}

// ------------------------------------------------------------------ instances

/** Packs placed instances into the three fields a `ScatterLayerComponent` stores. */
export function packInstances(instances: readonly ScatterInstance[]): ScatterData {
  if (instances.length === 0) return { ...EMPTY_SCATTER_DATA };

  const floats = new Float32Array(instances.length * SCATTER_FLOATS_PER_INSTANCE);
  const variants = new Uint16Array(instances.length);

  for (const [index, instance] of instances.entries()) {
    const at = index * SCATTER_FLOATS_PER_INSTANCE;
    floats[at] = instance.position[0];
    floats[at + 1] = instance.position[1];
    floats[at + 2] = instance.position[2];
    floats[at + 3] = instance.rotation[0];
    floats[at + 4] = instance.rotation[1];
    floats[at + 5] = instance.rotation[2];
    floats[at + 6] = instance.rotation[3];
    floats[at + 7] = instance.scale;
    // Clamped rather than wrapped: a prototype index past the end of the list is a bug, and
    // silently pointing it at prototype 3 instead of 65539 makes it findable.
    variants[index] = Math.max(0, Math.min(0xffff, Math.round(instance.prototype)));
  }

  return {
    instances: encodeFloat32(floats),
    variants: encodeUint16(variants),
    instanceCount: instances.length,
  };
}

/**
 * How many instances a layer really carries.
 *
 * `instanceCount` is a convenience for the Inspector and the tools, not the authority — the
 * buffers are. A hand-edited scene where the two disagree reads as the smaller of them, so a
 * wrong count can never make the decoder walk off the end of the array.
 */
export function instanceCountOf(component: ScatterReadable): number {
  const floats = decodeFloat32(component.instances ?? '');
  const available = Math.floor(floats.length / SCATTER_FLOATS_PER_INSTANCE);
  const declared = Number.isFinite(component.instanceCount)
    ? Math.max(0, Math.floor(component.instanceCount!))
    : available;
  return Math.min(available, declared);
}

/** Unpacks a layer's instances. Returns an empty list for an empty or unreadable layer. */
export function unpackInstances(component: ScatterReadable): ScatterInstance[] {
  const floats = decodeFloat32(component.instances ?? '');
  const variants = decodeUint16(component.variants ?? '');
  const count = instanceCountOf(component);

  const out: ScatterInstance[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = index * SCATTER_FLOATS_PER_INSTANCE;
    out.push({
      position: [floats[at]!, floats[at + 1]!, floats[at + 2]!],
      rotation: [floats[at + 3]!, floats[at + 4]!, floats[at + 5]!, floats[at + 6]!],
      scale: floats[at + 7]!,
      // A missing variant means prototype zero, which is what a single-prototype layer wants
      // and is the only reading that cannot crash the renderer.
      prototype: variants[index] ?? 0,
    });
  }
  return out;
}
