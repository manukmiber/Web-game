/**
 * The little language that maps a rig onto a game.
 *
 * A binding list is text, one binding per line, because the alternative — an array of objects
 * with an editor for adding rows — is four times the UI for something that reads better as a
 * line you can copy from a README:
 *
 * ```
 * A0 -> axis:steer bipolar deadzone=0.06     a potentiometer steers
 * A1 -> axis:move max=1023                   a slider walks
 * D2 -> key:Space                            a button jumps
 * D3 -> key:ShiftLeft                        a switch sprints
 * uno:A2 -> key:KeyE threshold=0.8           analog channel used as a button, on one board
 * ```
 *
 * Outputs read the other way, and the arrow says which:
 *
 * ```
 * D13 <- health scale=0.0255 max=255         a lamp dims as the player is hurt
 * buzzer <- alive                            0 when dead
 * D9 <- var:alarm rate=4                     a game variable, at most four writes a second
 * ```
 *
 * Parsing never throws and never discards a list because one line is wrong. Bad lines come
 * back in `errors`, addressed by line number, and every other binding still works — a typo in
 * binding six should not silently unplug the steering.
 */

import { parseChannelRef } from './HardwareBus';
import { defaultRange, isChannelName } from './protocol';

export interface InputBinding {
  /** Channel reference as written: `A0` or `uno:A0`. */
  channel: string;
  target: { kind: 'key'; key: string } | { kind: 'axis'; name: string };
  /** Raw range this channel spans. Defaults from the channel name — see `defaultRange`. */
  min: number;
  max: number;
  /** Below this magnitude the axis reads zero, with the remainder rescaled to full travel. */
  deadzone: number;
  invert: boolean;
  /** Map to -1..1 instead of 0..1. What a centre-detented stick wants. */
  bipolar: boolean;
  /** Key bindings only: the normalized value at which the key counts as held. */
  threshold: number;
}

export type OutputSource =
  | { kind: 'health' }
  | { kind: 'health01' }
  | { kind: 'alive' }
  | { kind: 'var'; name: string }
  | { kind: 'axis'; name: string }
  | { kind: 'const'; value: number };

export interface OutputBinding {
  channel: string;
  source: OutputSource;
  scale: number;
  min: number;
  max: number;
  /** Decimal places sent. Zero, because `analogWrite` takes an integer. */
  decimals: number;
  /** Writes per second. Serial is a 190-characters-per-frame budget; a lamp does not need 60. */
  rateHz: number;
}

export interface ParsedBindings<T> {
  bindings: T[];
  /** "line 3: unknown target 'axes:steer'" — written to be shown as-is. */
  errors: string[];
}

const DEFAULTS = {
  deadzone: 0,
  threshold: 0.5,
  scale: 1,
  decimals: 0,
  rateHz: 20,
};

/** Splits on newlines, commas and semicolons, and strips `#` / `//` comments. */
function lines(text: string): { text: string; line: number }[] {
  return (text ?? '')
    .split('\n')
    .flatMap((raw, index) =>
      raw
        .replace(/(^|\s)(#|\/\/).*$/, '')
        .split(/[,;]/)
        .map((part) => ({ text: part.trim(), line: index + 1 })),
    )
    .filter((entry) => entry.text.length > 0);
}

interface Options {
  flags: Set<string>;
  numbers: Map<string, number>;
  unknown: string[];
}

function readOptions(tokens: string[]): Options {
  const flags = new Set<string>();
  const numbers = new Map<string, number>();
  const unknown: string[] = [];

  for (const token of tokens) {
    const split = token.indexOf('=');
    if (split === -1) {
      flags.add(token.toLowerCase());
      continue;
    }
    const key = token.slice(0, split).toLowerCase();
    const value = Number(token.slice(split + 1));
    if (Number.isFinite(value)) numbers.set(key, value);
    else unknown.push(token);
  }
  return { flags, numbers, unknown };
}

export function parseInputBindings(text: string): ParsedBindings<InputBinding> {
  const bindings: InputBinding[] = [];
  const errors: string[] = [];

  for (const entry of lines(text)) {
    const [left, right] = splitOnce(entry.text, '->');
    if (right === null) {
      errors.push(`line ${entry.line}: expected "channel -> key:Name" or "channel -> axis:name"`);
      continue;
    }

    const channel = left.trim();
    if (!validChannel(channel)) {
      errors.push(`line ${entry.line}: "${channel}" is not a channel name`);
      continue;
    }

    const tokens = right.trim().split(/\s+/);
    const target = parseTarget(tokens[0] ?? '');
    if (!target) {
      errors.push(`line ${entry.line}: unknown target "${tokens[0] ?? ''}" — use key:Name or axis:name`);
      continue;
    }

    const options = readOptions(tokens.slice(1));
    for (const bad of options.unknown) errors.push(`line ${entry.line}: "${bad}" is not a number`);

    const range = defaultRange(parseChannelRef(channel).channel);
    bindings.push({
      channel,
      target,
      min: options.numbers.get('min') ?? range.min,
      max: options.numbers.get('max') ?? range.max,
      deadzone: clamp(options.numbers.get('deadzone') ?? DEFAULTS.deadzone, 0, 0.9),
      invert: options.flags.has('invert'),
      bipolar: options.flags.has('bipolar'),
      threshold: options.numbers.get('threshold') ?? DEFAULTS.threshold,
    });
  }

  return { bindings, errors };
}

export function parseOutputBindings(text: string): ParsedBindings<OutputBinding> {
  const bindings: OutputBinding[] = [];
  const errors: string[] = [];

  for (const entry of lines(text)) {
    const [left, right] = splitOnce(entry.text, '<-');
    if (right === null) {
      errors.push(`line ${entry.line}: expected "channel <- source"`);
      continue;
    }

    const channel = left.trim();
    if (!validChannel(channel)) {
      errors.push(`line ${entry.line}: "${channel}" is not a channel name`);
      continue;
    }

    const tokens = right.trim().split(/\s+/);
    const source = parseSource(tokens[0] ?? '');
    if (!source) {
      errors.push(
        `line ${entry.line}: unknown source "${tokens[0] ?? ''}" — use health, health01, alive, var:name, axis:name or const:n`,
      );
      continue;
    }

    const options = readOptions(tokens.slice(1));
    for (const bad of options.unknown) errors.push(`line ${entry.line}: "${bad}" is not a number`);

    bindings.push({
      channel,
      source,
      scale: options.numbers.get('scale') ?? DEFAULTS.scale,
      min: options.numbers.get('min') ?? -Infinity,
      max: options.numbers.get('max') ?? Infinity,
      decimals: clamp(Math.round(options.numbers.get('decimals') ?? DEFAULTS.decimals), 0, 4),
      rateHz: clamp(options.numbers.get('rate') ?? DEFAULTS.rateHz, 0.1, 120),
    });
  }

  return { bindings, errors };
}

function parseTarget(token: string): InputBinding['target'] | null {
  const [kind, name] = splitOnce(token, ':');
  if (name === null || name.trim().length === 0) return null;
  if (kind.toLowerCase() === 'key') return { kind: 'key', key: name.trim() };
  if (kind.toLowerCase() === 'axis') return { kind: 'axis', name: name.trim() };
  return null;
}

function parseSource(token: string): OutputSource | null {
  const [kind, argument] = splitOnce(token, ':');
  const name = (argument ?? '').trim();
  switch (kind.toLowerCase()) {
    case 'health':
      return { kind: 'health' };
    case 'health01':
      return { kind: 'health01' };
    case 'alive':
      return { kind: 'alive' };
    case 'var':
      return name ? { kind: 'var', name } : null;
    case 'axis':
      return name ? { kind: 'axis', name } : null;
    case 'const': {
      const value = Number(name);
      return Number.isFinite(value) ? { kind: 'const', value } : null;
    }
    default:
      return null;
  }
}

/**
 * Raw device reading → the value a game system sees.
 *
 * Range, then polarity, then deadzone, in that order: a deadzone is a statement about the
 * *stick*, so it has to be applied after the reading has been turned into stick travel and
 * after inversion has decided which way is which. Applying it to the raw ADC count instead is
 * the classic bug where a centred stick has a dead spot on one side only.
 *
 * The remainder is rescaled to full travel, so a 6 % deadzone does not cost 6 % of top speed.
 */
export function normalizeInput(raw: number, binding: InputBinding): number {
  const span = binding.max - binding.min;
  const unit = span === 0 ? 0 : clamp((raw - binding.min) / span, 0, 1);

  let value = binding.bipolar ? unit * 2 - 1 : unit;
  if (binding.invert) value = binding.bipolar ? -value : 1 - value;

  if (binding.deadzone > 0) {
    const magnitude = Math.abs(value);
    if (magnitude <= binding.deadzone) return 0;
    const scaled = (magnitude - binding.deadzone) / (1 - binding.deadzone);
    value = Math.sign(value) * Math.min(1, scaled);
  }
  return value;
}

/** Applies scale and clamp, then rounds to what the wire will carry. */
export function shapeOutput(value: number, binding: OutputBinding): number {
  const scaled = clamp(value * binding.scale, binding.min, binding.max);
  if (!Number.isFinite(scaled)) return 0;
  const factor = 10 ** binding.decimals;
  return Math.round(scaled * factor) / factor;
}

function splitOnce(text: string, separator: string): [string, string | null] {
  const index = text.indexOf(separator);
  if (index === -1) return [text, null];
  return [text.slice(0, index), text.slice(index + separator.length)];
}

function validChannel(reference: string): boolean {
  const { deviceId, channel } = parseChannelRef(reference);
  if (deviceId !== null && deviceId.length === 0) return false;
  return isChannelName(channel);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
