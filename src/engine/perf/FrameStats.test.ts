import { describe, expect, it } from 'vitest';
import { FrameStats, percentile, slowestMean } from './FrameStats';

describe('percentile', () => {
  it('returns 0 for an empty set', () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it('picks the nearest rank', () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 0.5)).toBe(50);
    expect(percentile(sorted, 0.95)).toBe(100);
    expect(percentile(sorted, 0)).toBe(10);
  });
});

/** Blocks for approximately `ms` so a measured span is non-trivial. */
function spin(ms: number): void {
  if (ms <= 0) return;
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* deliberate busy wait */
  }
}

describe('FrameStats', () => {
  /**
   * One simulated frame. `busyMs` is how long the JavaScript portion should appear to take;
   * the frame time is supplied directly rather than slept through, since these tests are
   * about the statistics, not about real timing.
   */
  const frame = (stats: FrameStats, frameMs: number, busyMs = 0) => {
    stats.beginFrame();
    stats.beginSubmit();
    spin(busyMs);
    stats.endSubmit();
    stats.endFrame();
    stats.record(frameMs / 1000);
  };

  /** Blocks for approximately `ms` so the measured JS time is non-trivial. */
  const spin = (ms: number) => {
    if (ms <= 0) return;
    const until = performance.now() + ms;
    while (performance.now() < until) {
      /* deliberate busy wait */
    }
  };

  it('reports nothing before any samples', () => {
    const report = new FrameStats().report();
    expect(report.sampleCount).toBe(0);
    expect(report.fps).toBe(0);
  });

  it('computes fps from the median, not the mean', () => {
    const stats = new FrameStats();
    // Nine good frames and one terrible one: the mean would read ~24ms, the median 16.
    for (let i = 0; i < 9; i += 1) frame(stats, 16);
    frame(stats, 100);

    const report = stats.report();
    expect(report.medianMs).toBe(16);
    expect(Math.round(report.fps)).toBe(63);
  });

  it('surfaces sustained stutter in p95 where the median hides it', () => {
    const stats = new FrameStats();
    // 10% of frames spiking: invisible in the median, which is exactly the case that makes a
    // build feel broken while the fps counter looks fine.
    for (let i = 0; i < 90; i += 1) frame(stats, 16);
    for (let i = 0; i < 10; i += 1) frame(stats, 90);

    const report = stats.report();
    expect(report.medianMs).toBe(16);
    expect(report.p95Ms).toBe(90);
    expect(report.worstMs).toBe(90);
  });

  it('leaves a single outlier below p95, since one frame in twenty is the top 5%', () => {
    const stats = new FrameStats();
    for (let i = 0; i < 19; i += 1) frame(stats, 16);
    frame(stats, 90);

    const report = stats.report();
    expect(report.p95Ms).toBe(16);
    // A one-off is still visible, just not as p95.
    expect(report.worstMs).toBe(90);
  });

  it('drops absurd frames so a backgrounded tab does not poison the window', () => {
    const stats = new FrameStats();
    for (let i = 0; i < 5; i += 1) frame(stats, 16);
    frame(stats, 4000);

    const report = stats.report();
    expect(report.sampleCount).toBe(5);
    expect(report.worstMs).toBe(16);
  });

  it('keeps only the most recent window', () => {
    const stats = new FrameStats(10);
    for (let i = 0; i < 50; i += 1) frame(stats, 16);
    expect(stats.report().sampleCount).toBe(10);
  });

  it('calls a slow frame that is almost all JavaScript CPU bound', () => {
    const stats = new FrameStats();
    // 45ms of JS inside a 50ms frame: the CPU is the thing to fix.
    for (let i = 0; i < 10; i += 1) frame(stats, 50, 45);

    const report = stats.report();
    expect(report.jsShare).toBeGreaterThan(0.7);
    expect(report.bound).toBe('cpu');
  });

  it('calls a slow frame with little JavaScript GPU bound', () => {
    const stats = new FrameStats();
    // A 50ms frame with almost no JS in it is waiting on something else — the GPU.
    for (let i = 0; i < 10; i += 1) frame(stats, 50, 0);

    const report = stats.report();
    expect(report.jsShare).toBeLessThan(0.4);
    expect(report.bound).toBe('gpu');
  });

  it('gives no verdict while frames are fast, since vsync hides the headroom', () => {
    const stats = new FrameStats();
    for (let i = 0; i < 10; i += 1) frame(stats, 16, 1);

    expect(stats.report().bound).toBe('unknown');
  });

  it('clears the window on reset so a lever change starts a fresh measurement', () => {
    const stats = new FrameStats();
    for (let i = 0; i < 10; i += 1) frame(stats, 16);
    stats.reset();
    expect(stats.report().sampleCount).toBe(0);
  });
});

describe('FrameStats, the advanced readouts', () => {
  const frame = (stats: FrameStats, frameMs: number) => {
    stats.beginFrame();
    stats.endFrame();
    stats.record(frameMs / 1000);
  };

  it('reports a 1% low well below the average when a run is spiky', () => {
    const stats = new FrameStats();
    for (let i = 0; i < 99; i += 1) frame(stats, 16);
    frame(stats, 100);

    const report = stats.report();
    // The average barely notices one bad frame in a hundred; the 1% low is that frame.
    expect(Math.round(report.averageFps)).toBe(59);
    expect(Math.round(report.low1Fps)).toBe(10);
    expect(Math.round(report.fps)).toBe(63);
  });

  it('agrees with itself on a perfectly steady run', () => {
    const stats = new FrameStats();
    for (let i = 0; i < 100; i += 1) frame(stats, 20);

    const report = stats.report();
    expect(report.fps).toBeCloseTo(50);
    expect(report.averageFps).toBeCloseTo(50);
    expect(report.low1Fps).toBeCloseTo(50);
    expect(report.minFps).toBeCloseTo(50);
    expect(report.stutterCount).toBe(0);
  });

  it('counts hitches, with an absolute floor so a fast machine is not slandered', () => {
    const stats = new FrameStats();
    // 7ms frames with occasional 13ms ones: nearly double the median, but nobody feels 13ms.
    for (let i = 0; i < 90; i += 1) frame(stats, 7);
    for (let i = 0; i < 10; i += 1) frame(stats, 13);
    expect(stats.report().stutterCount).toBe(0);

    const slow = new FrameStats();
    for (let i = 0; i < 90; i += 1) frame(slow, 16);
    for (let i = 0; i < 10; i += 1) frame(slow, 90);
    expect(slow.report().stutterCount).toBe(10);
    expect(slow.report().stutterShare).toBeCloseTo(0.1);
  });

  it('hands back the history the graph plots, oldest first', () => {
    const stats = new FrameStats(4);
    for (const ms of [10, 20, 30, 40, 50]) frame(stats, ms);
    expect(stats.report().history).toEqual([20, 30, 40, 50]);
  });

  it('counts every frame recorded, not just the ones still in the window', () => {
    const stats = new FrameStats(10);
    for (let i = 0; i < 50; i += 1) frame(stats, 16);
    const report = stats.report();
    expect(report.sampleCount).toBe(10);
    expect(report.totalFrames).toBe(50);
  });

  it('attributes time to named sections, worst first', () => {
    const stats = new FrameStats();
    for (let i = 0; i < 10; i += 1) {
      stats.beginFrame();
      stats.beginSection('PhysicsSystem');
      spin(2);
      stats.endSection('PhysicsSystem');
      stats.beginSection('ScriptSystem');
      stats.endSection('ScriptSystem');
      stats.endFrame();
      stats.record(0.016);
    }

    const sections = stats.report().sections;
    expect(sections.map((s) => s.name)).toEqual(['PhysicsSystem', 'ScriptSystem']);
    expect(sections[0]!.medianMs).toBeGreaterThan(1);
    expect(sections[0]!.share).toBeGreaterThan(0);
    expect(sections[1]!.medianMs).toBeLessThan(1);
  });

  it('records a zero for a section that stopped running, rather than its last value', () => {
    const stats = new FrameStats();
    for (let i = 0; i < 5; i += 1) {
      stats.beginFrame();
      stats.beginSection('NpcSystem');
      spin(2);
      stats.endSection('NpcSystem');
      stats.endFrame();
      stats.record(0.016);
    }
    // The system stops ticking — because Play mode ended, say.
    for (let i = 0; i < 20; i += 1) {
      stats.beginFrame();
      stats.endFrame();
      stats.record(0.016);
    }

    expect(stats.report().sections[0]!.medianMs).toBe(0);
  });

  it('ignores an unbalanced endSection rather than recording a bogus span', () => {
    const stats = new FrameStats();
    stats.beginFrame();
    stats.endSection('NeverStarted');
    stats.endFrame();
    stats.record(0.016);
    expect(stats.report().sections).toEqual([]);
  });

  it('drops section history on reset along with everything else', () => {
    const stats = new FrameStats();
    stats.beginFrame();
    stats.beginSection('A');
    stats.endSection('A');
    stats.endFrame();
    stats.record(0.016);
    expect(stats.report().sections).toHaveLength(1);

    stats.reset();
    expect(stats.report().sections).toEqual([]);
    expect(stats.report().totalFrames).toBe(0);
  });
});

describe('slowestMean', () => {
  it('averages the tail rather than picking one frame out of it', () => {
    const sorted = [10, 10, 10, 10, 10, 10, 10, 10, 40, 60];
    // The slowest 20% is the last two: (40 + 60) / 2.
    expect(slowestMean(sorted, 0.2)).toBe(50);
  });

  it('always takes at least one sample, however small the fraction', () => {
    expect(slowestMean([1, 2, 3], 0.0001)).toBe(3);
  });

  it('is zero for an empty set', () => {
    expect(slowestMean([], 0.5)).toBe(0);
  });
});
