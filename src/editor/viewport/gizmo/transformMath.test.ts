import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@engine/scene/types';
import {
  closestPointOnLine,
  DEG2RAD,
  eulerDegreesNear,
  intersectPlane,
  quaternionFromDegrees,
  scaleFactorsForFrame,
  signedAngle,
  snap,
  unwrapAngle,
} from './transformMath';

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

function ray(origin: Vec3, direction: Vec3): THREE.Ray {
  return new THREE.Ray(
    new THREE.Vector3(...origin),
    new THREE.Vector3(...direction).normalize(),
  );
}

describe('closestPointOnLine', () => {
  it('projects a skew ray onto the axis it is dragging', () => {
    // Ray passing above the X axis at x = 3: the closest point on the axis is (3, 0, 0).
    const point = closestPointOnLine(ray([3, 5, 0], [0, -1, 0]), new THREE.Vector3(), X);
    expect(point).not.toBeNull();
    expect(point!.x).toBeCloseTo(3, 6);
    expect(point!.y).toBeCloseTo(0, 6);
    expect(point!.z).toBeCloseTo(0, 6);
  });

  it('respects the line origin', () => {
    const point = closestPointOnLine(ray([3, 5, 2], [0, -1, 0]), new THREE.Vector3(0, 0, 2), X);
    expect(point!.toArray()).toEqual([3, 0, 2]);
  });

  it('declines a ray parallel to the axis rather than returning a wild point', () => {
    expect(closestPointOnLine(ray([0, 1, 0], [1, 0, 0]), new THREE.Vector3(), X)).toBeNull();
  });
});

describe('intersectPlane', () => {
  it('finds the hit point on a plane through the gizmo', () => {
    const hit = intersectPlane(ray([2, 5, 3], [0, -1, 0]), new THREE.Vector3(0, 1, 0), Y);
    expect(hit!.toArray()).toEqual([2, 1, 3]);
  });

  it('returns null for a ray running parallel to the plane', () => {
    expect(intersectPlane(ray([0, 5, 0], [1, 0, 0]), new THREE.Vector3(0, 1, 0), Y)).toBeNull();
  });

  it('returns the origin for a ray lying in the plane, which is where the drag started', () => {
    const hit = intersectPlane(ray([2, 1, 0], [1, 0, 0]), new THREE.Vector3(0, 1, 0), Y);
    expect(hit!.toArray()).toEqual([2, 1, 0]);
  });
});

describe('signedAngle and unwrapAngle', () => {
  it('signs the angle by the axis it is measured about', () => {
    expect(signedAngle(X, Z, Y)).toBeCloseTo(-Math.PI / 2, 6);
    expect(signedAngle(X, Z, Y.clone().negate())).toBeCloseTo(Math.PI / 2, 6);
  });

  it('carries a rotation past the ±180° seam instead of flipping it', () => {
    // A ring dragged to 190° reads as -170°; unwrapping against the previous 170° keeps it
    // going the way the pointer went.
    const wrapped = -170 * DEG2RAD;
    expect(unwrapAngle(wrapped, 170 * DEG2RAD)).toBeCloseTo(190 * DEG2RAD, 6);
  });

  it('keeps accumulating over several turns', () => {
    let previous = 0;
    for (const degrees of [170, -170, -10, 170, -170]) {
      previous = unwrapAngle(degrees * DEG2RAD, previous);
    }
    expect(previous / DEG2RAD).toBeCloseTo(550, 4);
  });
});

describe('snap', () => {
  it('quantises to the increment', () => {
    expect(snap(2.4, 1)).toBe(2);
    expect(snap(2.6, 1)).toBe(3);
    expect(snap(37, 15)).toBe(30);
  });

  it('passes the value through when snapping is off', () => {
    expect(snap(2.4, 0)).toBe(2.4);
    expect(snap(2.4, -1)).toBe(2.4);
  });
});

describe('eulerDegreesNear', () => {
  const sameOrientation = (degrees: Vec3, quaternion: THREE.Quaternion) => {
    const rebuilt = quaternionFromDegrees(degrees, new THREE.Quaternion());
    // Quaternions are double covers, so q and -q are the same orientation.
    expect(Math.abs(rebuilt.dot(quaternion))).toBeCloseTo(1, 5);
  };

  it('reads back a plain rotation unchanged', () => {
    const q = quaternionFromDegrees([0, 45, 0], new THREE.Quaternion());
    expect(eulerDegreesNear(q, [0, 0, 0])).toEqual([0, 45, 0].map((n) => expect.closeTo(n, 5)));
  });

  it('keeps a Y rotation past 90° readable instead of returning (-180, 86, -180)', () => {
    // This is the exact regression: dragging the Y ring ~94° used to land the Inspector on
    // (-180, 86.2, -180) — correct, unreadable, and a bad starting point for the next drag.
    const q = quaternionFromDegrees([0, 94, 0], new THREE.Quaternion());
    const bare = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    expect(Math.abs(bare.x)).toBeGreaterThan(3); // ~±180° — what the naive read gives

    const result = eulerDegreesNear(q, [0, 45, 0]);
    expect(result[0]).toBeCloseTo(0, 4);
    expect(result[1]).toBeCloseTo(94, 4);
    expect(result[2]).toBeCloseTo(0, 4);
    sameOrientation(result, q);
  });

  it('lets angles run continuously past 180° rather than flipping sign', () => {
    let previous: Vec3 = [0, 0, 0];
    const readings: number[] = [];
    for (let degrees = 0; degrees <= 360; degrees += 30) {
      const q = quaternionFromDegrees([0, degrees, 0], new THREE.Quaternion());
      previous = eulerDegreesNear(q, previous);
      readings.push(previous[1]);
    }
    // Monotonically increasing all the way round, no wrap to -180.
    for (let i = 1; i < readings.length; i += 1) {
      expect(readings[i]!).toBeGreaterThan(readings[i - 1]!);
    }
    expect(readings[readings.length - 1]!).toBeCloseTo(360, 3);
  });

  it('always returns a triple that rebuilds the orientation it was given', () => {
    for (const source of [
      [10, 20, 30],
      [120, 45, -80],
      [-170, 89, 12],
      [0, 90, 0],
      [45, 91, 45],
    ] as Vec3[]) {
      const q = quaternionFromDegrees(source, new THREE.Quaternion());
      sameOrientation(eulerDegreesNear(q, [0, 0, 0]), q);
      sameOrientation(eulerDegreesNear(q, source), q);
    }
  });
});

describe('scaleFactorsForFrame', () => {
  const identity = new THREE.Quaternion();

  it('applies the factor to the matching axis when the frames line up', () => {
    expect(scaleFactorsForFrame([2, 1, 1], identity, identity)).toEqual([2, 1, 1]);
  });

  it('permutes factors onto the axes an axis-aligned rotation maps them to', () => {
    // 90° about Y maps the object's local +X onto the gizmo's -Z.
    const rotated = quaternionFromDegrees([0, 90, 0], new THREE.Quaternion());
    expect(scaleFactorsForFrame([1, 1, 3], identity, rotated)).toEqual([3, 1, 1]);
  });

  it('falls back to a uniform factor rather than shearing a 45°-rotated object', () => {
    // The old gizmo built the sheared matrix and let decompose() absorb the shear into the
    // rotation, which moved a 45° box to 42.7° just for dragging its X scale handle.
    const rotated = quaternionFromDegrees([0, 45, 0], new THREE.Quaternion());
    const result = scaleFactorsForFrame([2, 1, 1], identity, rotated);
    expect(result[0]).toBeCloseTo(Math.cbrt(2), 6);
    expect(result[0]).toBe(result[1]);
    expect(result[1]).toBe(result[2]);
  });

  it('leaves a uniform factor uniform whatever the rotation', () => {
    const rotated = quaternionFromDegrees([13, 47, -22], new THREE.Quaternion());
    const result = scaleFactorsForFrame([2, 2, 2], identity, rotated);
    for (const factor of result) expect(factor).toBeCloseTo(2, 6);
  });
});
