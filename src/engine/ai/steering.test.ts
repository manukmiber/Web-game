import { describe, expect, it } from 'vitest';
import {
  angleDelta,
  distanceXZ,
  forwardFromYaw,
  hashSeed,
  mulberry32,
  randomPointInDisc,
  stepAngle,
  stepAway,
  stepTowards,
  wrapAngle,
  yawTowards,
} from './steering';

describe('angles', () => {
  it('wraps into (-180, 180]', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(190)).toBe(-170);
    expect(wrapAngle(-190)).toBe(170);
    expect(wrapAngle(540)).toBe(180);
  });

  it('takes the short way round', () => {
    expect(angleDelta(170, -170)).toBe(20);
    expect(angleDelta(-170, 170)).toBe(-20);
  });

  it('turns toward a target without overshooting it', () => {
    expect(stepAngle(0, 90, 30)).toBe(30);
    expect(stepAngle(0, 90, 200)).toBe(90);
    // Crossing the ±180 seam the short way is the whole point of using the delta.
    expect(stepAngle(170, -170, 5)).toBe(175);
  });
});

describe('facing', () => {
  it('points along -Z at zero yaw, matching the camera convention', () => {
    const [x, z] = forwardFromYaw(0);
    expect(x).toBeCloseTo(0);
    expect(z).toBeCloseTo(-1);
  });

  it('round-trips a direction through yaw', () => {
    for (const [dx, dz] of [
      [0, -1],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0.6, 0.8],
    ] as const) {
      const [fx, fz] = forwardFromYaw(yawTowards(dx, dz));
      expect(fx).toBeCloseTo(dx, 5);
      expect(fz).toBeCloseTo(dz, 5);
    }
  });

  it('yields a defined yaw for a zero direction rather than NaN', () => {
    expect(yawTowards(0, 0)).toBe(0);
  });
});

describe('stepTowards', () => {
  it('moves at the given speed', () => {
    const step = stepTowards(0, 0, 10, 0, 2, 0.5);
    expect(step.x).toBeCloseTo(1);
    expect(step.arrived).toBe(false);
  });

  it('lands exactly on the target instead of overshooting it', () => {
    // A whole second of travel at 100 m/s toward a point 1 m away.
    const step = stepTowards(0, 0, 1, 0, 100, 1);
    expect(step.x).toBeCloseTo(1);
    expect(step.z).toBeCloseTo(0);
    expect(step.arrived).toBe(true);
  });

  it('stops at the arrival radius, which is how an attacker keeps its distance', () => {
    const step = stepTowards(0, 0, 10, 0, 100, 1, 2);
    expect(step.x).toBeCloseTo(8);
    expect(step.arrived).toBe(true);
  });

  it('reports arrival when already inside the radius', () => {
    const step = stepTowards(0, 0, 1, 0, 5, 1, 2);
    expect(step).toEqual({ x: 0, z: 0, arrived: true });
  });
});

describe('stepAway', () => {
  it('moves directly away from the threat', () => {
    const step = stepAway(1, 0, 0, 0, 3, 1);
    expect(step.x).toBeCloseTo(4);
    expect(step.z).toBeCloseTo(0);
  });

  it('picks a direction rather than dividing by zero when standing on the threat', () => {
    const step = stepAway(2, 2, 2, 2, 3, 1);
    expect(Number.isFinite(step.x)).toBe(true);
    expect(Number.isFinite(step.z)).toBe(true);
    expect(distanceXZ([step.x, 0, step.z], [2, 0, 2])).toBeCloseTo(3);
  });
});

describe('random', () => {
  it('is deterministic for a seed, which is what makes wander testable', () => {
    const a = mulberry32(hashSeed('e42'));
    const b = mulberry32(hashSeed('e42'));
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect(first.every((n) => n >= 0 && n < 1)).toBe(true);
  });

  it('gives different sequences to different entities', () => {
    const a = mulberry32(hashSeed('e1'));
    const b = mulberry32(hashSeed('e2'));
    expect(a()).not.toBe(b());
  });

  it('samples inside the disc', () => {
    const rng = mulberry32(hashSeed('disc'));
    for (let i = 0; i < 200; i += 1) {
      const [x, z] = randomPointInDisc(rng, 5, -3, 4);
      expect(Math.hypot(x - 5, z + 3)).toBeLessThanOrEqual(4 + 1e-9);
    }
  });
});
