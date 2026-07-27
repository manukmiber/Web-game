import { describe, expect, it } from 'vitest';
import {
  normalizeInput,
  parseInputBindings,
  parseOutputBindings,
  shapeOutput,
  type InputBinding,
} from './bindings';

function binding(overrides: Partial<InputBinding> = {}): InputBinding {
  return {
    channel: 'A0',
    target: { kind: 'axis', name: 'move' },
    min: 0,
    max: 1023,
    deadzone: 0,
    invert: false,
    bipolar: false,
    threshold: 0.5,
    ...overrides,
  };
}

describe('parseInputBindings', () => {
  it('reads the shape a README shows', () => {
    const { bindings, errors } = parseInputBindings(`
      A0 -> axis:turn bipolar deadzone=0.08
      D2 -> key:Space
    `);

    expect(errors).toEqual([]);
    expect(bindings).toHaveLength(2);
    expect(bindings[0]).toMatchObject({
      channel: 'A0',
      target: { kind: 'axis', name: 'turn' },
      bipolar: true,
      deadzone: 0.08,
      // Range came from the channel name, so a stick on an analog pin needs no calibration.
      min: 0,
      max: 1023,
    });
    expect(bindings[1]).toMatchObject({ channel: 'D2', target: { kind: 'key', key: 'Space' } });
  });

  it('keeps every good line when one is wrong, and says which', () => {
    const { bindings, errors } = parseInputBindings('A0 -> axis:move\nA1 => axis:turn\nD2 -> key:Q');

    expect(bindings.map((b) => b.channel)).toEqual(['A0', 'D2']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('line 2');
  });

  it('rejects a target it does not understand rather than binding nothing', () => {
    const { bindings, errors } = parseInputBindings('A0 -> axes:move');
    expect(bindings).toEqual([]);
    expect(errors[0]).toContain('axes:move');
  });

  it('takes comments and device-qualified channels', () => {
    const { bindings, errors } = parseInputBindings(`
      # the left board
      uno:A0 -> axis:move   // a slider
    `);
    expect(errors).toEqual([]);
    expect(bindings[0]?.channel).toBe('uno:A0');
  });

  it('accepts several bindings on one line', () => {
    const { bindings } = parseInputBindings('D2 -> key:Space, D3 -> key:ShiftLeft');
    expect(bindings).toHaveLength(2);
  });
});

describe('normalizeInput', () => {
  it('maps a 10-bit reading onto 0..1', () => {
    expect(normalizeInput(0, binding())).toBe(0);
    expect(normalizeInput(1023, binding())).toBe(1);
    expect(normalizeInput(511.5, binding())).toBeCloseTo(0.5, 5);
  });

  it('centres a bipolar stick', () => {
    const stick = binding({ bipolar: true });
    expect(normalizeInput(511.5, stick)).toBeCloseTo(0, 5);
    expect(normalizeInput(0, stick)).toBe(-1);
    expect(normalizeInput(1023, stick)).toBe(1);
  });

  it('clamps a reading outside the calibrated range', () => {
    const short = binding({ min: 100, max: 900 });
    expect(normalizeInput(50, short)).toBe(0);
    expect(normalizeInput(1000, short)).toBe(1);
  });

  it('inverts after ranging, so a backwards pot is one flag', () => {
    expect(normalizeInput(0, binding({ invert: true }))).toBe(1);
    expect(normalizeInput(0, binding({ bipolar: true, invert: true }))).toBe(1);
  });

  /**
   * The point of rescaling: a deadzone must not cost top speed, or every rig with a noisy
   * stick quietly walks slower than the keyboard.
   */
  it('zeroes inside the deadzone and still reaches full travel outside it', () => {
    const stick = binding({ bipolar: true, deadzone: 0.2 });
    expect(normalizeInput(511.5, stick)).toBe(0);
    expect(normalizeInput(1023, stick)).toBe(1);
    expect(normalizeInput(0, stick)).toBe(-1);
    // Just past the edge of the deadzone is a small value, not a jump to 0.2.
    expect(normalizeInput(1023 * 0.62, stick)).toBeGreaterThan(0);
    expect(normalizeInput(1023 * 0.62, stick)).toBeLessThan(0.1);
  });
});

describe('parseOutputBindings', () => {
  it('reads sources and their options', () => {
    const { bindings, errors } = parseOutputBindings(`
      D13 <- health01 scale=255 rate=8
      buzzer <- alive
      D9 <- var:alarm
      D5 <- const:1
    `);

    expect(errors).toEqual([]);
    expect(bindings[0]).toMatchObject({
      channel: 'D13',
      source: { kind: 'health01' },
      scale: 255,
      rateHz: 8,
    });
    expect(bindings[1]?.source).toEqual({ kind: 'alive' });
    expect(bindings[2]?.source).toEqual({ kind: 'var', name: 'alarm' });
    expect(bindings[3]?.source).toEqual({ kind: 'const', value: 1 });
  });

  it('rejects an arrow pointing the wrong way', () => {
    const { bindings, errors } = parseOutputBindings('D13 -> health');
    expect(bindings).toEqual([]);
    expect(errors[0]).toContain('channel <- source');
  });

  it('scales, clamps and rounds to what a pin can take', () => {
    const [led] = parseOutputBindings('D9 <- health01 scale=255 max=255').bindings;
    expect(shapeOutput(0.5, led!)).toBe(128);
    expect(shapeOutput(2, led!)).toBe(255);
    expect(shapeOutput(-1, led!)).toBe(-255);
  });

  it('keeps decimals when a servo needs them', () => {
    const [servo] = parseOutputBindings('servo <- var:angle decimals=2').bindings;
    expect(shapeOutput(12.3456, servo!)).toBe(12.35);
  });
});
