import { describe, expect, it } from 'vitest';
import { Clock, MAX_FRAME_DELTA } from './Clock';

describe('Clock', () => {
  it('reports zero on the anchoring frame', () => {
    const clock = new Clock();
    expect(clock.tick(1000)).toBe(0);
  });

  it('reports elapsed seconds between two timestamps', () => {
    const clock = new Clock();
    clock.tick(1000);
    expect(clock.tick(1016)).toBeCloseTo(0.016, 5);
  });

  it('clamps a huge gap, such as a backgrounded tab', () => {
    const clock = new Clock();
    clock.tick(0);
    expect(clock.tick(5000)).toBe(MAX_FRAME_DELTA);
  });

  it('honours a custom max delta', () => {
    const clock = new Clock({ maxDelta: 0.05 });
    clock.tick(0);
    expect(clock.tick(1000)).toBe(0.05);
  });

  it('never reports a negative dt for an out-of-order timestamp', () => {
    const clock = new Clock();
    clock.tick(1000);
    expect(clock.tick(900)).toBe(0);
  });

  it('reports zero dt while paused, and resumes without a spike', () => {
    const clock = new Clock();
    clock.tick(0);
    clock.pause();
    expect(clock.tick(1000)).toBe(0);
    expect(clock.isPaused).toBe(true);

    clock.resume(2000);
    expect(clock.isPaused).toBe(false);
    // The paused interval is discarded, not reported as elapsed time on resume.
    expect(clock.tick(2016)).toBeCloseTo(0.016, 5);
  });

  it('scales dt by timeScale', () => {
    const clock = new Clock();
    clock.tick(0);
    clock.timeScale = 0.5;
    expect(clock.tick(100)).toBeCloseTo(0.05, 5);
  });

  it('smooths jitter without changing the returned dt', () => {
    const clock = new Clock({ smoothing: 0.9 });
    clock.tick(0);
    const dt = clock.tick(10);
    expect(dt).toBeCloseTo(0.01, 5);
    expect(clock.smoothDelta).toBeCloseTo(0.01, 5);

    const dt2 = clock.tick(50);
    // The returned dt is the true elapsed time, unsmoothed...
    expect(dt2).toBeCloseTo(0.04, 5);
    // ...while the smoothed reading moves toward it more slowly.
    expect(clock.smoothDelta).toBeGreaterThan(0.01);
    expect(clock.smoothDelta).toBeLessThan(dt2);
  });

  it('reset re-anchors with no elapsed time on the next tick', () => {
    const clock = new Clock();
    clock.tick(0);
    clock.tick(500);
    clock.reset(9000);
    expect(clock.tick(9010)).toBeCloseTo(0.01, 5);
  });
});
