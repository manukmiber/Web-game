import { ActiveSet, Ladder, Origin, type OriginShift } from 'origo';

/**
 * Grid-chunk streaming and distance LOD, built on Origo's ladder.
 *
 * Pure coordinate math: a camera position goes in, a chunk load/unload diff and an origin
 * rebase come out. It knows nothing about entities, meshes or the Scene — `RenderBridge` is
 * what turns a chunk key into "which objects react." That split is why this is unit-tested
 * exactly like Origo itself, with no DOM, no Three, no Scene.
 *
 * The chunk grid sits at Origo's finest ladder tier, sized from `WorldSettings.chunkSize`
 * (`scene/types.ts`) — the save format's existing chunk-addressable bucket becomes the same
 * grid the renderer streams against, rather than a second, disagreeing notion of "chunk."
 */

export interface StreamingOptions {
  /**
   * World bound, as a ladder exponent. Default `24` (±8,388 km) — tiers above whatever a
   * scene actually reaches are bounds arithmetic and cost nothing (Origo ARCHITECTURE.md §3.1),
   * so there is no reason to size this down for a small scene.
   */
  worldExp?: number;
  /** Vertical half-bound, as a ladder exponent. Default `24`, Origo's own default. */
  verticalExp?: number;
  /** Metres a chunk stays loaded within. Default: four chunks. */
  loadRadius?: number;
  /** Extra distance beyond `loadRadius` before a chunk unloads. Default: one chunk (hysteresis). */
  unloadHysteresis?: number;
  /**
   * Ascending distance thresholds (metres), inside `loadRadius`, marking coarser LOD bands.
   * Band 0 is nearer than `lodRadii[0]`; a loaded chunk beyond every threshold gets the last
   * band. Default: a single split at half the load radius, i.e. two bands.
   */
  lodRadii?: number[];
  /** Render-root anchor tier for `Origin`. Default: Origo's own default, `min(13, worldExp)`. */
  anchorExp?: number;
  /** Camera travel before a rebase is considered. Default `1024`, Origo's own default. */
  originThreshold?: number;
}

export interface ChunkDiff {
  entered: string[];
  exited: string[];
}

export interface StreamingFrame {
  /** Set when the render origin moved this frame — apply it, don't recompute it. */
  originShift: OriginShift | null;
  chunks: ChunkDiff;
  /**
   * Every currently loaded chunk's LOD band, band 0 nearest. Recomputed in full each frame:
   * the active set is bounded by the load radius, not the world, so this stays cheap regardless
   * of how large the scene is.
   */
  lod: ReadonlyMap<string, number>;
}

/** The finest materialised ladder tier whose size a `chunkSize` in metres rounds to. */
export function finestExpFor(chunkSize: number): number {
  return Math.max(0, Math.round(Math.log2(Math.max(1, chunkSize))));
}

export function chunkKey(ix: number, iz: number): string {
  return `${ix},${iz}`;
}

export function parseChunkKey(key: string): [number, number] {
  const [ix, iz] = key.split(',').map(Number);
  return [ix ?? 0, iz ?? 0];
}

export class StreamingSystem {
  readonly ladder: Ladder;
  readonly origin: Origin;
  /**
   * The grid's effective chunk size — `2 ** finestExp`, metres. Equal to the requested
   * `chunkSize` whenever that was already a power of two (the default, 256, is); otherwise the
   * nearest one, because Origo's ladder is power-of-two by construction (ARCHITECTURE.md §3).
   */
  readonly chunkSize: number;

  private readonly loadSet: ActiveSet;
  private readonly lodRadii: number[];

  constructor(chunkSize: number, opts: StreamingOptions = {}) {
    const worldExp = opts.worldExp ?? 24;
    const finestExp = Math.min(worldExp, finestExpFor(chunkSize));
    this.ladder = new Ladder({ worldExp, finestExp, verticalExp: opts.verticalExp ?? 24 });
    this.chunkSize = this.ladder.sizeOf(finestExp);

    const loadRadius = opts.loadRadius ?? this.chunkSize * 4;
    this.loadSet = new ActiveSet(this.ladder, {
      exp: finestExp,
      radius: loadRadius,
      hysteresis: opts.unloadHysteresis ?? this.chunkSize,
    });
    this.lodRadii = [...(opts.lodRadii ?? [loadRadius / 2])].sort((a, b) => a - b);

    const originOpts: { anchorExp?: number; threshold?: number } = {};
    if (opts.anchorExp !== undefined) originOpts.anchorExp = opts.anchorExp;
    if (opts.originThreshold !== undefined) originOpts.threshold = opts.originThreshold;
    this.origin = new Origin(this.ladder, originOpts);
  }

  /**
   * Base-grid chunk key a world position falls in. Matches `scene/types.ts#chunkKeyFor`'s
   * `"cx,cz"` format exactly when `chunkSize` is already a power of two — both floor-divide by
   * the same cell size.
   */
  chunkKeyAt(x: number, z: number): string {
    const exp = this.ladder.finestExp;
    return chunkKey(this.ladder.indexAt(x, exp), this.ladder.indexAt(z, exp));
  }

  /** Is this chunk currently within the load radius? */
  isLoaded(key: string): boolean {
    const [ix, iz] = parseChunkKey(key);
    return this.loadSet.has(ix, iz);
  }

  /** One frame: camera position in, origin rebase and chunk diff out. */
  update(camX: number, camY: number, camZ: number): StreamingFrame {
    const originShift = this.origin.consider(camX, camY, camZ);
    const diff = this.loadSet.update(camX, camY, camZ);

    const entered: string[] = [];
    for (let i = 0; i < diff.enteredCount; i++) {
      entered.push(chunkKey(diff.entered[i * 2]!, diff.entered[i * 2 + 1]!));
    }
    const exited: string[] = [];
    for (let i = 0; i < diff.exitedCount; i++) {
      exited.push(chunkKey(diff.exited[i * 2]!, diff.exited[i * 2 + 1]!));
    }

    const lod = new Map<string, number>();
    for (let i = 0; i < this.loadSet.size; i++) {
      const ix = this.loadSet.ixAt(i);
      const iz = this.loadSet.izAt(i);
      lod.set(chunkKey(ix, iz), this.bandFor(ix, iz, camX, camZ));
    }

    return { originShift, chunks: { entered, exited }, lod };
  }

  /** LOD band for an arbitrary chunk, independent of whether it is currently loaded. */
  bandFor(ix: number, iz: number, camX: number, camZ: number): number {
    const size = this.chunkSize;
    const x0 = ix * size;
    const x1 = x0 + size;
    const z0 = iz * size;
    const z1 = z0 + size;
    const dx = camX < x0 ? x0 - camX : camX > x1 ? camX - x1 : 0;
    const dz = camZ < z0 ? z0 - camZ : camZ > z1 ? camZ - z1 : 0;
    const d2 = dx * dx + dz * dz;
    for (let band = 0; band < this.lodRadii.length; band++) {
      if (d2 <= this.lodRadii[band]! * this.lodRadii[band]!) return band;
    }
    return this.lodRadii.length;
  }
}
