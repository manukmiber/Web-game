/**
 * The wire format between a board and the engine.
 *
 * It is **line-based ASCII**, not a binary framing, and that is a deliberate trade. A packed
 * binary protocol would be a few bytes smaller per sample and completely opaque: the fastest
 * way to debug a rig that has stopped reporting is to open the Arduino IDE's own serial
 * monitor and read what the board is saying. Text costs a handful of bytes at 115200 baud —
 * which is 11,520 characters a second, roughly 190 per frame at 60 fps — and buys a protocol
 * you can type by hand into a terminal to test a servo.
 *
 * Device → engine, one message per line:
 *
 * ```
 * hello name=Cockpit protocol=1 channels=A0,A1,D2,D3   handshake; optional but recommended
 * hello name="Left Cockpit"                            quote a value that contains spaces
 * A0=512 A1=7 D2=1                                     channel values, any number per line
 * A0 512                                               the same thing, space-separated
 * #starting up                                         a log line, shown in the editor
 * !stick not calibrated                                an error, shown in red
 * bye                                                  the board is signing off
 * ```
 *
 * Engine → device:
 *
 * ```
 * D13=1        set a channel
 * servo=90     channel names are free-form; the firmware decides what they mean
 * bye=1        the editor is closing the link — zero your outputs
 * ?            identify yourself (the board should answer with `hello`)
 * ```
 *
 * Both directions use the same `channel=value` shape, so a firmware author writes one parser
 * and reuses it, and so a line captured in either direction reads the same way.
 */

/** Protocol revision reported in `hello`. Bumped only for an incompatible change. */
export const PROTOCOL_VERSION = 1;

/**
 * Longer than this and the line is dropped rather than buffered.
 *
 * A board that resets mid-line, or a baud-rate mismatch, produces an endless stream of noise
 * with no newline in it. Without a cap that stream is an unbounded string in memory; with one
 * it is a counter the panel can show.
 */
export const MAX_LINE_LENGTH = 512;

/** A channel name: a letter, then letters, digits or underscores. `A0`, `D13`, `throttle`. */
const CHANNEL = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;

export type HardwareMessage =
  | { kind: 'hello'; name: string; protocol: number; channels: string[] }
  | { kind: 'values'; values: ChannelValue[] }
  | { kind: 'log'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'bye' }
  /** A line that parsed as nothing recognisable. Surfaced verbatim rather than swallowed. */
  | { kind: 'unknown'; text: string };

export interface ChannelValue {
  channel: string;
  value: number;
}

/** Words a firmware author will reach for instead of 1 and 0. */
const WORDS: Record<string, number> = {
  on: 1,
  off: 0,
  true: 1,
  false: 0,
  high: 1,
  low: 0,
  up: 0,
  down: 1,
  open: 1,
  closed: 0,
};

export function parseValue(token: string): number | null {
  const word = WORDS[token.toLowerCase()];
  if (word !== undefined) return word;
  const number = Number(token);
  return Number.isFinite(number) ? number : null;
}

/**
 * Splits a text stream into lines.
 *
 * Serial arrives in whatever chunks the USB stack felt like delivering — half a line, three
 * lines, one character — so the split has to survive a message arriving in pieces. `\r\n` and
 * `\n` both terminate, because `Serial.println` on an Arduino sends the former and everything
 * else sends the latter.
 */
export class LineFramer {
  /** Lines dropped for exceeding MAX_LINE_LENGTH. Shown in the editor's device panel. */
  overflows = 0;

  private buffer = '';
  /** Set after an overflow: everything up to the next newline belongs to the dropped line. */
  private discarding = false;

  push(chunk: string): string[] {
    const lines: string[] = [];
    this.buffer += chunk;

    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (this.discarding) this.discarding = false;
      else if (line.length > 0) lines.push(line);
      newline = this.buffer.indexOf('\n');
    }

    if (this.buffer.length > MAX_LINE_LENGTH) {
      this.overflows += 1;
      this.buffer = '';
      this.discarding = true;
    }
    return lines;
  }

  reset(): void {
    this.buffer = '';
    this.discarding = false;
  }
}

/**
 * Parses one line into a message.
 *
 * Returns null only for a blank line. Anything else comes back as *some* message, including
 * `unknown` — a device saying something the engine does not understand is information, and
 * hiding it turns "my sketch prints the wrong thing" into "the editor shows nothing".
 */
export function parseLine(line: string): HardwareMessage | null {
  const text = line.trim();
  if (text.length === 0) return null;
  if (text.startsWith('#')) return { kind: 'log', text: text.slice(1).trim() };
  if (text.startsWith('!')) return { kind: 'error', text: text.slice(1).trim() };

  const tokens = text.split(/\s+/);
  const head = tokens[0]!.toLowerCase();
  if (head === 'bye') return { kind: 'bye' };
  if (head === 'hello') return parseHello(tokens.slice(1));

  const values = parseValues(tokens);
  return values.length > 0 ? { kind: 'values', values } : { kind: 'unknown', text };
}

function parseHello(tokens: string[]): HardwareMessage {
  const fields = new Map<string, string>();
  // Re-joined and re-split, because a quoted value may contain the spaces the caller split on:
  // `name="Left Cockpit"` is one field, and a board with a two-word name is not a stretch.
  const rest = tokens.join(' ');
  for (const [, key, quoted, bare] of rest.matchAll(/(\w+)=(?:"([^"]*)"|(\S*))/g)) {
    fields.set(key!.toLowerCase(), quoted ?? bare ?? '');
  }
  const protocol = Number(fields.get('protocol'));
  const channels = (fields.get('channels') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => CHANNEL.test(name));

  return {
    kind: 'hello',
    name: fields.get('name') ?? '',
    protocol: Number.isFinite(protocol) ? protocol : PROTOCOL_VERSION,
    channels,
  };
}

/**
 * Reads `A0=512` and `A0 512` from the same token stream.
 *
 * Both spellings exist because both are what someone writes by hand: `=` when the line is
 * being composed in code, spaces when it is being typed into a serial monitor. A token that
 * parses as neither is skipped rather than failing the line — one garbled reading in a burst
 * of six should not lose the other five.
 */
function parseValues(tokens: string[]): ChannelValue[] {
  const values: ChannelValue[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const split = token.indexOf('=');

    if (split > 0) {
      const channel = token.slice(0, split);
      const value = parseValue(token.slice(split + 1));
      if (CHANNEL.test(channel) && value !== null) values.push({ channel, value });
      continue;
    }

    const next = tokens[index + 1];
    if (next === undefined) continue;
    const value = parseValue(next);
    if (CHANNEL.test(token) && value !== null) {
      values.push({ channel: token, value });
      index += 1;
    }
  }
  return values;
}

/** `D13=1\n`. Numbers are trimmed rather than sent as `1.0000000001`. */
export function encodeCommand(channel: string, value: number): string {
  return `${channel}=${formatValue(value)}\n`;
}

export function formatValue(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(3)));
}

/** Asks a board to introduce itself. Sent on connect, in case it booted before we attached. */
export const IDENTIFY = '?\n';

/**
 * What a channel's raw values are assumed to span when nothing says otherwise.
 *
 * `A0`-style names are analog pins, and every AVR Arduino's ADC is 10-bit, so 0–1023 is the
 * right guess for the overwhelming majority of rigs. An ESP32 reading 12-bit, or a channel
 * that reports degrees, says so in the binding (`max=4095`) — the guess only has to be right
 * often enough that the common case needs no calibration at all.
 */
export function defaultRange(channel: string): { min: number; max: number } {
  const first = channel[0]?.toUpperCase();
  if (first === 'A') return { min: 0, max: 1023 };
  return { min: 0, max: 1 };
}

export function isChannelName(name: string): boolean {
  return CHANNEL.test(name);
}
