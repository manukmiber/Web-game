import { describe, expect, it } from 'vitest';
import {
  CLICK_SLOP_PX,
  TOUCH_CLICK_SLOP_PX,
  isSelectionClick,
  type Press,
} from './pointerGesture';

const mouse: Press = { x: 100, y: 100, touch: false };
const finger: Press = { x: 100, y: 100, touch: true };
const at = (x: number, y: number) => ({ x, y });

describe('isSelectionClick', () => {
  it('treats a still press as a click', () => {
    expect(isSelectionClick(mouse, at(100, 100), false)).toBe(true);
  });

  it('allows a mouse the slop it needs and no more', () => {
    expect(isSelectionClick(mouse, at(100 + CLICK_SLOP_PX, 100), false)).toBe(true);
    expect(isSelectionClick(mouse, at(100 + CLICK_SLOP_PX + 1, 100), false)).toBe(false);
  });

  it('gives a finger a wider threshold, because a tap on glass rolls', () => {
    const rolled = at(100 + CLICK_SLOP_PX + 4, 100);
    expect(isSelectionClick(mouse, rolled, false)).toBe(false);
    expect(isSelectionClick(finger, rolled, false)).toBe(true);
    expect(isSelectionClick(finger, at(100 + TOUCH_CLICK_SLOP_PX + 1, 100), false)).toBe(false);
  });

  it('measures travel in both axes at once', () => {
    // 3-4-5: five pixels of travel, over the mouse slop even though neither axis is.
    expect(isSelectionClick(mouse, at(103, 104), false)).toBe(false);
  });

  /**
   * The regression this module exists for. A press the gizmo took is a handle drag, and a handle
   * drag must never fall through to picking — a nudge of a pixel or two used to clear the
   * selection, which took the gizmo away with it.
   */
  it('never treats a press the gizmo claimed as a click, however short', () => {
    expect(isSelectionClick(mouse, at(100, 100), true)).toBe(false);
    expect(isSelectionClick(mouse, at(101, 100), true)).toBe(false);
    expect(isSelectionClick(finger, at(100, 100), true)).toBe(false);
    expect(isSelectionClick(finger, at(105, 103), true)).toBe(false);
  });
});
