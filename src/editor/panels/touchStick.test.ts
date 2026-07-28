import { describe, expect, it } from 'vitest';
import { InputState } from '@engine/input/InputState';
import {
  LOOK_SENSITIVITY,
  STICK_DEAD_ZONE,
  STICK_RANGE_PX,
  lookAxis,
  stickAxis,
} from './touchStick';

describe('stickAxis', () => {
  it('reads a resting thumb as centred', () => {
    expect(stickAxis(0)).toBe(0);
    // Inside the dead zone: glass registers movement a finger has not deliberately made.
    expect(stickAxis(STICK_RANGE_PX * STICK_DEAD_ZONE * 0.9)).toBe(0);
    expect(stickAxis(-STICK_RANGE_PX * STICK_DEAD_ZONE * 0.9)).toBe(0);
  });

  it('reaches full deflection at the end of its travel, and no further', () => {
    expect(stickAxis(STICK_RANGE_PX)).toBeCloseTo(1, 6);
    expect(stickAxis(-STICK_RANGE_PX)).toBeCloseTo(-1, 6);
    // A thumb that overshoots the pad is still just "forward".
    expect(stickAxis(STICK_RANGE_PX * 5)).toBeCloseTo(1, 6);
    expect(stickAxis(-STICK_RANGE_PX * 5)).toBeCloseTo(-1, 6);
  });

  it('leaves the dead zone from zero rather than jumping to it', () => {
    // Rescaled, not clipped: clipping would start the character at 18% speed the instant the
    // thumb crossed the threshold, which reads as a loose stick.
    const justOutside = STICK_RANGE_PX * (STICK_DEAD_ZONE + 0.001);
    expect(stickAxis(justOutside)).toBeLessThan(0.02);
    expect(stickAxis(justOutside)).toBeGreaterThan(0);
  });

  it('rises monotonically, so pushing further never slows the character down', () => {
    let previous = -1;
    for (let pixels = 0; pixels <= STICK_RANGE_PX; pixels += 2) {
      const value = stickAxis(pixels);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('is symmetric, so backwards is exactly as fast as forwards', () => {
    for (const pixels of [10, 25, 40, 64, 200]) {
      expect(stickAxis(-pixels)).toBeCloseTo(-stickAxis(pixels), 9);
    }
  });
});

describe('lookAxis', () => {
  it('turns right for travel to the right', () => {
    expect(lookAxis(45)).toBeCloseTo(45 * LOOK_SENSITIVITY, 6);
    expect(lookAxis(-45)).toBeCloseTo(-45 * LOOK_SENSITIVITY, 6);
  });

  it('clamps, so a swipe across the whole screen is not a hundred turns', () => {
    expect(lookAxis(5000)).toBe(1);
    expect(lookAxis(-5000)).toBe(-1);
  });
});

/**
 * The pads exist to reach `CharacterSystem` through the axes it already reads. This pins the
 * signs against the input model rather than against the component, because getting one of them
 * backwards is invisible in a unit test of the maths and very obvious with a thumb on a phone.
 */
describe('the axes the pads drive', () => {
  it('feeds the same named axes a stick or a script would', () => {
    const input = new InputState();
    input.setAxis('move', stickAxis(STICK_RANGE_PX));
    input.setAxis('strafe', stickAxis(STICK_RANGE_PX / 2));
    input.setAxis('turn', lookAxis(90));

    expect(input.getAxis('move')).toBeCloseTo(1, 6);
    expect(input.getAxis('strafe')).toBeGreaterThan(0);
    expect(input.getAxis('turn')).toBeCloseTo(1, 6);
  });

  it('combines with the keyboard rather than replacing it', () => {
    const input = new InputState();
    input.setKey('KeyW', true);
    input.setAxis('move', stickAxis(STICK_RANGE_PX));
    // Both at once still means "forward", not "twice forward" — a touch laptop has both.
    expect(input.combinedAxis('KeyS', 'KeyW', 'move')).toBe(1);
  });

  it('survives the clear that leaving Play mode performs', () => {
    const input = new InputState();
    input.setAxis('move', 1);
    input.setKey('ShiftLeft', true);
    input.clear();
    expect(input.getAxis('move')).toBe(0);
    expect(input.isDown('ShiftLeft')).toBe(false);
  });
});
