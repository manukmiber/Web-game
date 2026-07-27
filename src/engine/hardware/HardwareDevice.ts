import { Emitter } from '../core/Emitter';
import {
  IDENTIFY,
  LineFramer,
  PROTOCOL_VERSION,
  defaultRange,
  encodeCommand,
  parseLine,
  type HardwareMessage,
} from './protocol';
import type { HardwareTransport, TransportStatus } from './transport';

/** What one channel is currently reporting. */
export interface ChannelState {
  channel: string;
  /** Exactly what the device sent — 512, not 0.5. Calibration happens in the binding. */
  raw: number;
  /** `raw >= 0.5`, which is the right reading for a digital pin and the only one a device can make. */
  down: boolean;
  /** Values received since the device opened. Zero means "wired but never reported". */
  updates: number;
}

export interface DeviceEvents {
  status: { status: TransportStatus; detail?: string };
  /** Log and error lines from the board, and the device's own connection notes. */
  log: { level: 'info' | 'warn' | 'error'; text: string };
  hello: { name: string; protocol: number; channels: string[] };
}

export interface DeviceOptions {
  /** Stable id used by bindings (`uno:A0`). Defaults to a slug of the transport label. */
  id?: string;
  name?: string;
}

/**
 * One board, and everything the engine knows about it.
 *
 * The important design point is *when* inbound data becomes visible. Serial arrives on the
 * transport's own schedule — three lines between two frames, none for the next four — and a
 * system that read it as it landed would see a different world halfway through a tick than at
 * the start of it. So lines are queued as they arrive and applied in `pump()`, which the
 * Engine calls once at the top of every frame. A frame therefore sees one consistent snapshot
 * of the rig, and `wasPressed` means "since the last frame" rather than "since some point in
 * the last 16 ms".
 *
 * That is the same contract `InputState` keeps for the keyboard, for the same reason.
 */
export class HardwareDevice {
  readonly id: string;
  readonly transport: HardwareTransport;
  readonly events = new Emitter<DeviceEvents>();

  /** From `hello`, falling back to the transport label. */
  name: string;
  /** Set once a board has introduced itself; null for one that just streams values. */
  protocol: number | null = null;
  error: string | null = null;

  /** Lines in, lines out, and lines the framer dropped. Shown in the device panel. */
  readonly stats = { linesIn: 0, linesOut: 0, unknown: 0 };

  private readonly framer = new LineFramer();
  private readonly channels = new Map<string, ChannelState>();
  private readonly pressed = new Set<string>();
  private readonly released = new Set<string>();
  /** Inbound lines waiting for the next `pump()`. */
  private pending: string[] = [];
  /** Last value written per channel, so an unchanged output costs no bytes. */
  private readonly lastWritten = new Map<string, number>();
  private readonly offTransport: (() => void)[] = [];

  constructor(transport: HardwareTransport, options: DeviceOptions = {}) {
    this.transport = transport;
    this.id = options.id ?? slug(transport.label);
    this.name = options.name ?? transport.label;

    this.offTransport.push(
      transport.on('data', ({ text }) => {
        for (const line of this.framer.push(text)) this.pending.push(line);
      }),
      transport.on('status', ({ status, detail }) => {
        this.error = status === 'error' ? (detail ?? 'link failed') : null;
        if (status === 'open') {
          // A board that booted before we attached has already sent its hello to nobody.
          this.transport.send(IDENTIFY);
        }
        if (status === 'closed' || status === 'error') this.framer.reset();
        this.events.emit('status', { status, ...(detail !== undefined ? { detail } : {}) });
        this.events.emit('log', {
          level: status === 'error' ? 'error' : 'info',
          text: detail ? `${status}: ${detail}` : status,
        });
      }),
    );
  }

  get status(): TransportStatus {
    return this.transport.status;
  }

  get connected(): boolean {
    return this.transport.status === 'open';
  }

  get label(): string {
    return this.transport.label;
  }

  async open(): Promise<void> {
    await this.transport.open();
  }

  async close(): Promise<void> {
    this.transport.send(encodeCommand('bye', 1));
    await this.transport.close();
  }

  // ------------------------------------------------------------------- reads

  list(): ChannelState[] {
    return [...this.channels.values()];
  }

  has(channel: string): boolean {
    return this.channels.has(channel);
  }

  state(channel: string): ChannelState | undefined {
    return this.channels.get(channel);
  }

  raw(channel: string): number {
    return this.channels.get(channel)?.raw ?? 0;
  }

  /** Raw scaled into 0..1 by the channel's assumed range. Bindings do the calibrated version. */
  value(channel: string): number {
    const { min, max } = defaultRange(channel);
    const span = max - min;
    if (span === 0) return 0;
    return clamp01((this.raw(channel) - min) / span);
  }

  isDown(channel: string): boolean {
    return this.channels.get(channel)?.down ?? false;
  }

  wasPressed(channel: string): boolean {
    return this.pressed.has(channel);
  }

  wasReleased(channel: string): boolean {
    return this.released.has(channel);
  }

  // ------------------------------------------------------------------ writes

  /**
   * Sets an output channel.
   *
   * Repeats are dropped: at 115200 baud a frame's budget is about 190 characters, and a rig
   * with six lamps rewriting an unchanged value every frame would spend all of it saying
   * nothing. `force` exists for the case where the board may have missed it — after a reset,
   * or on connect.
   */
  write(channel: string, value: number, force = false): boolean {
    if (!this.connected) return false;
    if (!force && this.lastWritten.get(channel) === value) return false;
    this.lastWritten.set(channel, value);
    this.transport.send(encodeCommand(channel, value));
    this.stats.linesOut += 1;
    return true;
  }

  /** Raw line out, for firmware commands this protocol does not model. Newline added if absent. */
  send(line: string): void {
    if (!this.connected) return;
    this.transport.send(line.endsWith('\n') ? line : `${line}\n`);
    this.stats.linesOut += 1;
  }

  // --------------------------------------------------------------- lifecycle

  /** Applies everything the board said since the last frame. Called by `Engine.tick`. */
  pump(): void {
    if (this.pending.length === 0) return;
    const lines = this.pending;
    this.pending = [];

    for (const line of lines) {
      this.stats.linesIn += 1;
      const message = parseLine(line);
      if (message) this.apply(message);
    }
  }

  /** Drops edges. Called by `Engine.tick` after systems have run. */
  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
  }

  /**
   * Drops per-frame state and the record of what has been written, but not the connection.
   *
   * Called on every Play/Stop transition. A board is not scene state — pressing Stop should
   * not close a serial port the user opened by hand — but the *outputs* are: a lamp lit by a
   * play session must not stay lit, and the next session must not skip re-sending a value
   * because this one already sent it.
   */
  reset(): void {
    this.pending = [];
    this.pressed.clear();
    this.released.clear();
    this.lastWritten.clear();
    this.framer.reset();
  }

  dispose(): void {
    for (const off of this.offTransport) off();
    this.offTransport.length = 0;
    this.events.clear();
    void this.transport.close();
  }

  // ---------------------------------------------------------------- internal

  private apply(message: HardwareMessage): void {
    switch (message.kind) {
      case 'values':
        for (const { channel, value } of message.values) this.setChannel(channel, value);
        return;
      case 'hello': {
        this.protocol = message.protocol;
        if (message.name) this.name = message.name;
        // Declared channels appear in the panel before they have ever reported, which is what
        // makes a rig's wiring visible while it sits idle.
        for (const channel of message.channels) this.ensure(channel);
        this.events.emit('hello', message);
        if (message.protocol !== PROTOCOL_VERSION) {
          this.events.emit('log', {
            level: 'warn',
            text: `speaks protocol ${message.protocol}, this build speaks ${PROTOCOL_VERSION}`,
          });
        }
        return;
      }
      case 'log':
        this.events.emit('log', { level: 'info', text: message.text });
        return;
      case 'error':
        this.events.emit('log', { level: 'error', text: message.text });
        return;
      case 'bye':
        this.events.emit('log', { level: 'info', text: 'device signed off' });
        void this.transport.close();
        return;
      case 'unknown':
        this.stats.unknown += 1;
        this.events.emit('log', { level: 'warn', text: `unparsed: ${message.text}` });
        return;
    }
  }

  private ensure(channel: string): ChannelState {
    let state = this.channels.get(channel);
    if (!state) {
      state = { channel, raw: 0, down: false, updates: 0 };
      this.channels.set(channel, state);
    }
    return state;
  }

  private setChannel(channel: string, raw: number): void {
    const state = this.ensure(channel);
    state.raw = raw;
    state.updates += 1;

    const down = raw >= 0.5;
    if (down !== state.down) {
      state.down = down;
      (down ? this.pressed : this.released).add(channel);
    }
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** `COM4 @ 115200` → `com4-115200`. Stable enough to name a device in a binding. */
function slug(label: string): string {
  const cleaned = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'device';
}
