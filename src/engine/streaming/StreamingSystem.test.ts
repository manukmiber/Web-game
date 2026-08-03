import { describe, expect, it } from 'vitest';
import { chunkKeyFor } from '../scene/types';
import { StreamingSystem, chunkKey, finestExpFor, parseChunkKey } from './StreamingSystem';

describe('finestExpFor', () => {
  it('rounds a power of two to its exact exponent', () => {
    expect(finestExpFor(256)).toBe(8);
    expect(finestExpFor(1024)).toBe(10);
  });

  it('rounds a non-power-of-two chunk size to the nearest tier', () => {
    expect(finestExpFor(250)).toBe(8);
    expect(finestExpFor(300)).toBe(8);
  });
});

describe('chunkKey / parseChunkKey', () => {
  it('round-trips', () => {
    expect(parseChunkKey(chunkKey(-3, 7))).toEqual([-3, 7]);
  });
});

describe('StreamingSystem construction', () => {
  it('derives an exact power-of-two chunk size from the default 256', () => {
    const streaming = new StreamingSystem(256);
    expect(streaming.chunkSize).toBe(256);
    expect(streaming.ladder.finestExp).toBe(8);
  });

  it('agrees with the save format\'s chunkKeyFor for a power-of-two chunk size', () => {
    const streaming = new StreamingSystem(256);
    const cases: [number, number, number][] = [
      [0, 0, 0],
      [300, 0, -5],
      [-1, 0, -1],
      [-300, 0, 12345],
    ];
    for (const [x, y, z] of cases) {
      expect(streaming.chunkKeyAt(x, z)).toBe(chunkKeyFor([x, y, z], 256));
    }
  });
});

describe('StreamingSystem.update — chunk load/unload', () => {
  it('reports the initial in-range chunks as entered', () => {
    const streaming = new StreamingSystem(256, { loadRadius: 300 });
    const frame = streaming.update(0, 0, 0);
    expect(frame.chunks.entered.length).toBeGreaterThan(0);
    expect(frame.chunks.exited).toEqual([]);
    expect(streaming.isLoaded(streaming.chunkKeyAt(0, 0))).toBe(true);
  });

  it('keeps a chunk loaded past the load radius until the hysteresis boundary — no thrash', () => {
    const streaming = new StreamingSystem(256, { loadRadius: 256, unloadHysteresis: 256 });
    streaming.update(0, 0, 0);
    const originKey = streaming.chunkKeyAt(0, 0);

    // Past the 256 m load radius but short of the 512 m unload radius: still loaded, and not
    // reported as exited — that hysteresis is Origo's ActiveSet, exercised through this wrapper.
    const frame = streaming.update(400, 0, 0);
    expect(streaming.isLoaded(originKey)).toBe(true);
    expect(frame.chunks.exited).not.toContain(originKey);
  });

  it('reports a chunk exited once the camera passes the unload radius', () => {
    const streaming = new StreamingSystem(256, { loadRadius: 256, unloadHysteresis: 256 });
    streaming.update(0, 0, 0);
    const originKey = streaming.chunkKeyAt(0, 0);

    const frame = streaming.update(5000, 0, 0);
    expect(frame.chunks.exited).toContain(originKey);
    expect(streaming.isLoaded(originKey)).toBe(false);
  });

  it('is a pure function of camera position for a parked camera — no thrash', () => {
    const streaming = new StreamingSystem(256, { loadRadius: 500 });
    streaming.update(123, 0, 456);
    const frame = streaming.update(123, 0, 456);
    expect(frame.chunks.entered).toEqual([]);
    expect(frame.chunks.exited).toEqual([]);
  });
});

describe('StreamingSystem.update — LOD bands', () => {
  it('bands the near chunk 0 and a farther loaded chunk higher', () => {
    const streaming = new StreamingSystem(256, {
      loadRadius: 2000,
      lodRadii: [500],
    });
    const frame = streaming.update(0, 0, 0);
    const nearKey = streaming.chunkKeyAt(0, 0);
    const farKey = streaming.chunkKeyAt(1800, 0);

    expect(frame.lod.get(nearKey)).toBe(0);
    expect(frame.lod.get(farKey)).toBe(1);
  });

  it('every currently loaded chunk gets a band, every unloaded chunk gets none', () => {
    const streaming = new StreamingSystem(256, { loadRadius: 600, lodRadii: [300] });
    const frame = streaming.update(0, 0, 0);
    for (const key of frame.chunks.entered) expect(frame.lod.has(key)).toBe(true);
    expect(frame.lod.has(streaming.chunkKeyAt(50_000, 50_000))).toBe(false);
  });
});

describe('StreamingSystem.update — origin rebase', () => {
  it('does not rebase until the camera crosses the threshold', () => {
    const streaming = new StreamingSystem(256, { originThreshold: 1000 });
    // The origin starts at (0, 0, 0), so a camera that starts there triggers no rebase either.
    expect(streaming.update(0, 0, 0).originShift).toBeNull();
    expect(streaming.update(10, 0, 10).originShift).toBeNull();
  });

  it('rebases once the camera travels far enough, snapped to the grid', () => {
    const streaming = new StreamingSystem(256, { originThreshold: 1000 });
    streaming.update(0, 0, 0);
    const frame = streaming.update(5000, 0, 0);
    expect(frame.originShift).not.toBeNull();
    expect(streaming.origin.x).toBe(streaming.ladder.cellOrigin(5000, streaming.origin.snapExp));
  });
});
