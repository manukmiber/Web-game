import { describe, expect, it } from 'vitest';
import {
  LineFramer,
  MAX_LINE_LENGTH,
  defaultRange,
  encodeCommand,
  formatValue,
  parseLine,
  parseValue,
} from './protocol';

describe('LineFramer', () => {
  it('reassembles a message split across chunks', () => {
    const framer = new LineFramer();
    expect(framer.push('A0=5')).toEqual([]);
    expect(framer.push('12\n')).toEqual(['A0=512']);
  });

  it('splits several lines out of one chunk and keeps the remainder', () => {
    const framer = new LineFramer();
    expect(framer.push('a=1\nb=2\nc=')).toEqual(['a=1', 'b=2']);
    expect(framer.push('3\n')).toEqual(['c=3']);
  });

  it('accepts both CRLF and LF, because Serial.println sends the first', () => {
    const framer = new LineFramer();
    expect(framer.push('A0=1\r\nA0=2\n')).toEqual(['A0=1', 'A0=2']);
  });

  it('drops a line with no newline in sight rather than buffering forever', () => {
    const framer = new LineFramer();
    framer.push('x'.repeat(MAX_LINE_LENGTH + 10));
    expect(framer.overflows).toBe(1);
    // The tail of the dropped line belongs to it, not to the next message.
    expect(framer.push('garbage\nA0=7\n')).toEqual(['A0=7']);
  });
});

describe('parseLine', () => {
  it('reads channel=value and channel value from the same line', () => {
    expect(parseLine('A0=512 A1 7')).toEqual({
      kind: 'values',
      values: [
        { channel: 'A0', value: 512 },
        { channel: 'A1', value: 7 },
      ],
    });
  });

  it('reads the words a firmware author writes instead of 1 and 0', () => {
    expect(parseValue('on')).toBe(1);
    expect(parseValue('LOW')).toBe(0);
    expect(parseValue('-12.5')).toBe(-12.5);
    expect(parseValue('banana')).toBeNull();
  });

  it('keeps the readings it understood when one token is garbled', () => {
    const message = parseLine('A0=512 A1=NaN A2=3');
    expect(message).toEqual({
      kind: 'values',
      values: [
        { channel: 'A0', value: 512 },
        { channel: 'A2', value: 3 },
      ],
    });
  });

  it('parses a handshake', () => {
    expect(parseLine('hello name=Cockpit protocol=1 channels=A0,A1,D2')).toEqual({
      kind: 'hello',
      name: 'Cockpit',
      protocol: 1,
      channels: ['A0', 'A1', 'D2'],
    });
  });

  it('takes a quoted name, because a rig can be called two words', () => {
    expect(parseLine('hello name="Left Cockpit" protocol=1 channels=A0')).toEqual({
      kind: 'hello',
      name: 'Left Cockpit',
      protocol: 1,
      channels: ['A0'],
    });
  });

  it('separates logs, errors and sign-off from data', () => {
    expect(parseLine('#booted')).toEqual({ kind: 'log', text: 'booted' });
    expect(parseLine('!stick not calibrated')).toEqual({
      kind: 'error',
      text: 'stick not calibrated',
    });
    expect(parseLine('bye')).toEqual({ kind: 'bye' });
  });

  it('surfaces a line it cannot read rather than swallowing it', () => {
    expect(parseLine('what is happening')).toEqual({ kind: 'unknown', text: 'what is happening' });
    expect(parseLine('   ')).toBeNull();
  });
});

describe('encoding', () => {
  it('round-trips a command back through the parser', () => {
    const line = encodeCommand('D13', 1);
    expect(line).toBe('D13=1\n');
    expect(parseLine(line.trim())).toEqual({ kind: 'values', values: [{ channel: 'D13', value: 1 }] });
  });

  it('does not send floating-point noise down a serial link', () => {
    expect(formatValue(0.1 + 0.2)).toBe('0.3');
    expect(formatValue(90)).toBe('90');
    expect(formatValue(Number.NaN)).toBe('0');
  });

  it('assumes a 10-bit ADC for analog pins and 0/1 for everything else', () => {
    expect(defaultRange('A0')).toEqual({ min: 0, max: 1023 });
    expect(defaultRange('D13')).toEqual({ min: 0, max: 1 });
    expect(defaultRange('throttle')).toEqual({ min: 0, max: 1 });
  });
});
