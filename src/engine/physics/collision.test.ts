import { describe, expect, it } from 'vitest';
import { collide } from './collision';
import { quatFromEuler } from './math';
import { resolveShape } from './shapes';
import { createCollider } from '../components/Collider';
import type { WorldShape } from './shapes';

const sphere = (center: [number, number, number], radius = 1): WorldShape => ({
  kind: 'sphere',
  center,
  radius,
});

const box = (
  center: [number, number, number],
  half: [number, number, number] = [0.5, 0.5, 0.5],
  euler: [number, number, number] = [0, 0, 0],
): WorldShape => ({
  kind: 'box',
  center,
  rotation: quatFromEuler(euler),
  halfExtents: half,
});

const capsule = (
  center: [number, number, number],
  halfBarrel = 0.5,
  radius = 0.4,
): WorldShape => ({
  kind: 'capsule',
  a: [center[0], center[1] + halfBarrel, center[2]],
  b: [center[0], center[1] - halfBarrel, center[2]],
  radius,
});

const floor: WorldShape = { kind: 'plane', normal: [0, 1, 0], constant: 0 };

describe('collide', () => {
  it('finds nothing between shapes that are apart', () => {
    expect(collide(sphere([0, 0, 0]), sphere([5, 0, 0]))).toBeNull();
    expect(collide(box([0, 0, 0]), box([3, 0, 0]))).toBeNull();
    expect(collide(sphere([0, 5, 0]), floor)).toBeNull();
  });

  it('treats exact touching as no contact, so a resting body is not woken by resting', () => {
    // Two unit spheres exactly two radii apart, and a box sitting exactly on the floor.
    expect(collide(sphere([0, 0, 0]), sphere([2, 0, 0]))).toBeNull();
    expect(collide(box([0, 0.5, 0]), floor)).toBeNull();
  });

  it('points the normal from A towards B', () => {
    const contact = collide(sphere([0, 0, 0]), sphere([1.5, 0, 0]));
    expect(contact).not.toBeNull();
    expect(contact!.normal[0]).toBeCloseTo(1);
    expect(contact!.depth).toBeCloseTo(0.5);
  });

  it('flips the normal when the pair is given the other way round', () => {
    const forward = collide(sphere([0, 0, 0]), box([0.8, 0, 0]))!;
    const backward = collide(box([0.8, 0, 0]), sphere([0, 0, 0]))!;
    expect(backward.normal[0]).toBeCloseTo(-forward.normal[0]);
    expect(backward.depth).toBeCloseTo(forward.depth);
  });

  it('reports a plane contact with the normal pointing into the plane', () => {
    const contact = collide(sphere([0, 0.75, 0]), floor)!;
    expect(contact.normal[1]).toBeCloseTo(-1);
    expect(contact.depth).toBeCloseTo(0.25);
    expect(contact.point[1]).toBeCloseTo(-0.25);
  });

  it('pushes a sphere whose centre is inside a box out through the nearest face', () => {
    // Centre 0.1 above the box centre, so the top face is nearest and the escape is upward.
    const contact = collide(sphere([0, 0.1, 0], 0.2), box([0, 0, 0]))!;
    expect(contact.normal[1]).toBeCloseTo(-1);
    // Radius plus the remaining distance to the face: 0.2 + (0.5 - 0.1).
    expect(contact.depth).toBeCloseTo(0.6);
  });

  it('picks the axis of least overlap for two boxes', () => {
    // Overlapping by 0.2 in Y and 0.8 in X, so the separation is vertical.
    const contact = collide(box([0, 0, 0]), box([0.2, 0.8, 0]))!;
    expect(Math.abs(contact.normal[1])).toBeCloseTo(1);
    expect(contact.depth).toBeCloseTo(0.2);
  });

  it('separates rotated boxes, which axis-aligned bounds alone would call overlapping', () => {
    // Two unit boxes turned 45° about Y, offset along X by more than their rotated half-width.
    const a = box([0, 0, 0], [0.5, 0.5, 0.5], [0, 45, 0]);
    const b = box([1.6, 0, 0], [0.5, 0.5, 0.5], [0, 45, 0]);
    expect(collide(a, b)).toBeNull();
    // Their world-axis bounds do overlap, which is exactly why the narrowphase has to run.
    expect(collide(a, box([1.3, 0, 0], [0.5, 0.5, 0.5], [0, 45, 0]))).not.toBeNull();
  });

  it('stands a capsule on a plane using its lower cap', () => {
    const contact = collide(capsule([0, 0.8, 0]), floor)!;
    // Lower cap centre is at 0.3, radius 0.4, so it is 0.1 through the floor.
    expect(contact.depth).toBeCloseTo(0.1);
    expect(contact.normal[1]).toBeCloseTo(-1);
  });

  it('finds the near miss between two upright capsules, the parallel-segment case', () => {
    expect(collide(capsule([0, 1, 0]), capsule([0.79, 1, 0]))).not.toBeNull();
    expect(collide(capsule([0, 1, 0]), capsule([0.81, 1, 0]))).toBeNull();
  });

  it('resolves a capsule leaning into the side of a box', () => {
    const contact = collide(capsule([0.85, 0.5, 0]), box([0, 0.5, 0]))!;
    // Capsule surface reaches 0.45; the box face is at 0.5, so they overlap by 0.05.
    expect(contact.depth).toBeCloseTo(0.05, 2);
    expect(contact.normal[0]).toBeCloseTo(-1, 2);
  });

  it('reports nothing between two planes, whatever they are doing to each other', () => {
    expect(collide(floor, { kind: 'plane', normal: [1, 0, 0], constant: 0 })).toBeNull();
  });
});

describe('resolveShape', () => {
  it('scales a box on all three axes and a sphere on the largest', () => {
    const transform = {
      position: [1, 2, 3] as [number, number, number],
      rotation: quatFromEuler([0, 0, 0]),
      scale: [2, 3, 4] as [number, number, number],
    };

    const asBox = resolveShape(createCollider({ shape: 'Box', size: [1, 1, 1] }), transform);
    expect(asBox.kind).toBe('box');
    if (asBox.kind === 'box') expect(asBox.halfExtents).toEqual([1, 1.5, 2]);

    // One radius cannot express three scales, so the collider stays enclosing rather than
    // slipping inside the mesh — see `maxScale`.
    const asSphere = resolveShape(createCollider({ shape: 'Sphere', radius: 1 }), transform);
    if (asSphere.kind === 'sphere') expect(asSphere.radius).toBe(4);
  });

  it('collapses a capsule shorter than its own diameter into a sphere', () => {
    const shape = resolveShape(
      createCollider({ shape: 'Capsule', radius: 0.5, height: 0.5 }),
      { position: [0, 0, 0], rotation: quatFromEuler([0, 0, 0]), scale: [1, 1, 1] },
    );
    expect(shape.kind).toBe('capsule');
    if (shape.kind === 'capsule') expect(shape.a).toEqual(shape.b);
  });

  it('faces a Plane collider along its local +Y, so an unrotated one is a floor', () => {
    const shape = resolveShape(createCollider({ shape: 'Plane' }), {
      position: [0, 3, 0],
      rotation: quatFromEuler([0, 0, 0]),
      scale: [1, 1, 1],
    });
    expect(shape.kind).toBe('plane');
    if (shape.kind === 'plane') {
      expect(shape.normal[1]).toBeCloseTo(1);
      expect(shape.constant).toBeCloseTo(3);
    }
  });

  it('carries a collider centre through the entity rotation', () => {
    // A collider offset 1 along local X, on an entity turned 90° about Y, lands at -Z.
    const shape = resolveShape(createCollider({ shape: 'Sphere', center: [1, 0, 0] }), {
      position: [0, 0, 0],
      rotation: quatFromEuler([0, 90, 0]),
      scale: [1, 1, 1],
    });
    if (shape.kind === 'sphere') {
      expect(shape.center[0]).toBeCloseTo(0);
      expect(shape.center[2]).toBeCloseTo(-1);
    }
  });
});
