/**
 * The scene data model. Pure data, no classes, no Three.js — this is what gets serialised,
 * what the editor mutates through commands, and what the future runtime loads.
 */

export type EntityId = string;

/** World coordinates are float64 (plain JS numbers) — see ARCHITECTURE.md §9.1. */
export type Vec3 = [number, number, number];

export interface Transform {
  position: Vec3;
  /** Euler angles in **degrees**, XYZ order. Degrees because that is what the Inspector shows. */
  rotation: Vec3;
  scale: Vec3;
}

/**
 * Components are an open set resolved through the registry, discriminated by `type`.
 * Unknown types are preserved verbatim on load so a scene saved by a newer build never
 * loses data in an older one.
 */
export interface Component {
  type: string;
  [key: string]: unknown;
}

export interface Entity {
  id: EntityId;
  name: string;
  parentId: EntityId | null;
  transform: Transform;
  components: Component[];
}

export interface WorldSettings {
  /** Chunk edge length in metres. A 25 km world at 256 m is ~98x98 chunks. §9.2 */
  chunkSize: number;
}

export interface AssetRecord {
  id: string;
  type: 'texture';
  name: string;
  /** Data URL for local assets; an object key once the Cloudflare adapter lands. */
  src: string;
}

export const DEFAULT_CHUNK_SIZE = 256;

export function createTransform(
  position: Vec3 = [0, 0, 0],
  rotation: Vec3 = [0, 0, 0],
  scale: Vec3 = [1, 1, 1],
): Transform {
  return { position: [...position], rotation: [...rotation], scale: [...scale] };
}

export function cloneTransform(t: Transform): Transform {
  return createTransform(t.position, t.rotation, t.scale);
}

export function cloneComponent<T extends Component>(c: T): T {
  return structuredClone(c);
}

/** Chunk key for a world position. Derived, never authored. §9.2 */
export function chunkKeyFor(position: Vec3, chunkSize: number): string {
  const cx = Math.floor(position[0] / chunkSize);
  const cz = Math.floor(position[2] / chunkSize);
  return `${cx},${cz}`;
}
