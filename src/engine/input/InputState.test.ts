import { describe, expect, it } from 'vitest';
import { InputState, MOUSE_LEFT, MOUSE_RIGHT, normalizeKey } from './InputState';

describe('normalizeKey', () => {
  it('accepts the shorthand a script author will type', () => {
    expect(normalizeKey('w')).toBe('KeyW');
    expect(normalizeKey('W')).toBe('KeyW');
    expect(normalizeKey('3')).toBe('Digit3');
    expect(normalizeKey('space')).toBe('Space');
    expect(normalizeKey('left')).toBe('ArrowLeft');
    expect(normalizeKey('shift')).toBe('ShiftLeft');
  });

  it('passes DOM key codes through unchanged', () => {
    expect(normalizeKey('KeyW')).toBe('KeyW');
    expect(normalizeKey('ArrowUp')).toBe('ArrowUp');
    expect(normalizeKey('F8')).toBe('F8');
  });
});

describe('InputState', () => {
  it('reports held keys through either spelling', () => {
    const input = new InputState();
    input.setKey('KeyW', true);
    expect(input.isDown('w')).toBe(true);
    expect(input.isDown('KeyW')).toBe(true);
    input.setKey('KeyW', false);
    expect(input.isDown('w')).toBe(false);
  });

  it('treats left and right modifiers as one key', () => {
    const input = new InputState();
    input.setKey('ShiftRight', true);
    expect(input.isDown('shift')).toBe(true);
    expect(input.isDown('ShiftLeft')).toBe(true);
  });

  it('clears edges at the end of the frame but keeps the held state', () => {
    const input = new InputState();
    input.setKey('Space', true);
    expect(input.wasPressed('space')).toBe(true);

    input.endFrame();
    expect(input.wasPressed('space')).toBe(false);
    expect(input.isDown('space')).toBe(true);

    input.setKey('Space', false);
    expect(input.wasReleased('space')).toBe(true);
    input.endFrame();
    expect(input.wasReleased('space')).toBe(false);
  });

  it('does not re-fire the press edge on keyboard auto-repeat', () => {
    const input = new InputState();
    input.setKey('KeyA', true);
    input.endFrame();
    // The browser keeps sending keydown while a key is held.
    input.setKey('KeyA', true);
    expect(input.wasPressed('a')).toBe(false);
    expect(input.isDown('a')).toBe(true);
  });

  it('reduces opposed keys to a single axis', () => {
    const input = new InputState();
    expect(input.axis('KeyS', 'KeyW')).toBe(0);
    input.setKey('KeyW', true);
    expect(input.axis('KeyS', 'KeyW')).toBe(1);
    input.setKey('KeyS', true);
    expect(input.axis('KeyS', 'KeyW')).toBe(0);
    input.setKey('KeyW', false);
    expect(input.axis('KeyS', 'KeyW')).toBe(-1);
  });

  it('accumulates pointer and wheel deltas within a frame', () => {
    const input = new InputState();
    input.setPointer(0.5, -0.5, 4, 2);
    input.setPointer(0.6, -0.4, 3, 1);
    expect(input.pointerX).toBeCloseTo(0.6);
    expect(input.pointerDeltaX).toBe(7);
    expect(input.pointerDeltaY).toBe(3);

    input.addWheel(120);
    input.addWheel(-20);
    expect(input.wheelDelta).toBe(100);

    input.endFrame();
    expect(input.pointerDeltaX).toBe(0);
    expect(input.wheelDelta).toBe(0);
    // Position is state, not an edge, so it survives.
    expect(input.pointerX).toBeCloseTo(0.6);
  });

  it('reads mouse buttons as a bitmask', () => {
    const input = new InputState();
    input.setButtons(MOUSE_LEFT | MOUSE_RIGHT);
    expect(input.isMouseDown()).toBe(true);
    expect(input.isMouseDown(MOUSE_RIGHT)).toBe(true);
    input.setButtons(0);
    expect(input.isMouseDown()).toBe(false);
  });

  it('drops held keys on clear, since a blurred window never sends keyup', () => {
    const input = new InputState();
    input.setKey('KeyW', true);
    input.clear();
    expect(input.isDown('w')).toBe(false);
  });

  describe('snapshot / applySnapshot', () => {
    it('reproduces held keys, axes and pointer state on the far side', () => {
      const source = new InputState();
      source.setKey('KeyW', true);
      source.setAxis('move', 0.5);
      source.setPointer(0.2, -0.3, 5, 6);
      source.setButtons(MOUSE_LEFT);
      source.addWheel(10);

      const mirror = new InputState();
      mirror.applySnapshot(source.toSnapshot());

      expect(mirror.isDown('w')).toBe(true);
      expect(mirror.getAxis('move')).toBeCloseTo(0.5);
      expect(mirror.pointerX).toBeCloseTo(0.2);
      expect(mirror.pointerDeltaX).toBe(5);
      expect(mirror.isMouseDown()).toBe(true);
      expect(mirror.wheelDelta).toBe(10);
    });

    it('derives press/release edges from consecutive snapshots, not from level state', () => {
      const mirror = new InputState();

      mirror.applySnapshot({ down: [], axes: [], pointerX: 0, pointerY: 0, pointerDeltaX: 0, pointerDeltaY: 0, wheelDelta: 0, buttons: 0 });
      expect(mirror.wasPressed('space')).toBe(false);

      mirror.applySnapshot({ down: ['Space'], axes: [], pointerX: 0, pointerY: 0, pointerDeltaX: 0, pointerDeltaY: 0, wheelDelta: 0, buttons: 0 });
      expect(mirror.wasPressed('space')).toBe(true);
      expect(mirror.isDown('space')).toBe(true);

      mirror.endFrame();
      // Still held: a second snapshot with the same key must not re-fire the press edge, the
      // same auto-repeat guard `setKey` already gives a real keyboard.
      mirror.applySnapshot({ down: ['Space'], axes: [], pointerX: 0, pointerY: 0, pointerDeltaX: 0, pointerDeltaY: 0, wheelDelta: 0, buttons: 0 });
      expect(mirror.wasPressed('space')).toBe(false);
      expect(mirror.isDown('space')).toBe(true);

      mirror.applySnapshot({ down: [], axes: [], pointerX: 0, pointerY: 0, pointerDeltaX: 0, pointerDeltaY: 0, wheelDelta: 0, buttons: 0 });
      expect(mirror.wasReleased('space')).toBe(true);
      expect(mirror.isDown('space')).toBe(false);
    });
  });
});
