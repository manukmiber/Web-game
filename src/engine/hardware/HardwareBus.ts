import { Emitter } from '../core/Emitter';
import type { HardwareDevice } from './HardwareDevice';
import type { TransportStatus } from './transport';

/**
 * A channel reference, as written in a binding or passed to a script.
 *
 * `A0` means "A0 on whichever device has it", `uno:A0` means that device and no other. The
 * unqualified form is the one people write, and it is right until a rig has two boards — at
 * which point the qualified form is available without rewriting anything else.
 */
export interface ChannelRef {
  deviceId: string | null;
  channel: string;
}

export function parseChannelRef(ref: string): ChannelRef {
  const split = ref.indexOf(':');
  if (split === -1) return { deviceId: null, channel: ref.trim() };
  return {
    deviceId: ref.slice(0, split).trim() || null,
    channel: ref.slice(split + 1).trim(),
  };
}

export interface BusEvents {
  deviceAdded: { device: HardwareDevice };
  deviceRemoved: { deviceId: string };
  status: { deviceId: string; status: TransportStatus; detail?: string };
  log: { deviceId: string; level: 'info' | 'warn' | 'error'; text: string };
}

/**
 * Every attached device, and one place to read them from.
 *
 * Lives on the `Engine` beside `input` and `game`, and for the same reason: a system, a script
 * and a panel all need it, and none of them should own it. What it is *not* is scene data —
 * which board is plugged in is a property of the desk, not of the level, so nothing here is
 * serialized. Scenes reference channels by name and work on any rig that provides them.
 *
 * The unqualified lookup (`A0` with no device) resolves to the first device that has reported
 * that channel, falling back to the first device that declared it in `hello`. Two boards both
 * offering `A0` is genuinely ambiguous, and the answer is to qualify the reference rather than
 * to guess more cleverly.
 */
export class HardwareBus {
  readonly events = new Emitter<BusEvents>();

  private readonly devices = new Map<string, HardwareDevice>();
  private readonly unsubscribes = new Map<string, (() => void)[]>();

  add(device: HardwareDevice): HardwareDevice {
    if (this.devices.has(device.id)) this.remove(device.id);
    this.devices.set(device.id, device);
    this.unsubscribes.set(device.id, [
      device.events.on('status', ({ status, detail }) =>
        this.events.emit('status', {
          deviceId: device.id,
          status,
          ...(detail !== undefined ? { detail } : {}),
        }),
      ),
      device.events.on('log', ({ level, text }) =>
        this.events.emit('log', { deviceId: device.id, level, text }),
      ),
    ]);
    this.events.emit('deviceAdded', { device });
    return device;
  }

  remove(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    for (const off of this.unsubscribes.get(deviceId) ?? []) off();
    this.unsubscribes.delete(deviceId);
    this.devices.delete(deviceId);
    device.dispose();
    this.events.emit('deviceRemoved', { deviceId });
  }

  get(deviceId: string): HardwareDevice | undefined {
    return this.devices.get(deviceId);
  }

  list(): HardwareDevice[] {
    return [...this.devices.values()];
  }

  get size(): number {
    return this.devices.size;
  }

  /** True while at least one device has an open link. What a script's `hardware.connected` reads. */
  get connected(): boolean {
    for (const device of this.devices.values()) if (device.connected) return true;
    return false;
  }

  /** The device a reference resolves to right now, or undefined if nothing provides it. */
  resolve(ref: string | ChannelRef): HardwareDevice | undefined {
    const { deviceId, channel } = typeof ref === 'string' ? parseChannelRef(ref) : ref;
    if (deviceId) return this.devices.get(deviceId);
    for (const device of this.devices.values()) if (device.has(channel)) return device;
    return undefined;
  }

  raw(ref: string): number {
    const { channel } = parseChannelRef(ref);
    return this.resolve(ref)?.raw(channel) ?? 0;
  }

  value(ref: string): number {
    const { channel } = parseChannelRef(ref);
    return this.resolve(ref)?.value(channel) ?? 0;
  }

  isDown(ref: string): boolean {
    const { channel } = parseChannelRef(ref);
    return this.resolve(ref)?.isDown(channel) ?? false;
  }

  wasPressed(ref: string): boolean {
    const { channel } = parseChannelRef(ref);
    return this.resolve(ref)?.wasPressed(channel) ?? false;
  }

  wasReleased(ref: string): boolean {
    const { channel } = parseChannelRef(ref);
    return this.resolve(ref)?.wasReleased(channel) ?? false;
  }

  /**
   * Writes an output. Returns false when nothing took it — no such device, link closed, or the
   * value is already what the device was last told.
   *
   * An unqualified reference to a channel no device has *reported* still needs a home: an
   * output pin is written before it is ever read back, so a lone connected device takes it.
   */
  write(ref: string, value: number, force = false): boolean {
    const parsed = parseChannelRef(ref);
    const device = this.resolve(parsed) ?? (parsed.deviceId ? undefined : this.onlyConnected());
    return device?.write(parsed.channel, value, force) ?? false;
  }

  /** Raw line to a named device, or to the only connected one. */
  send(line: string, deviceId?: string): boolean {
    const device = deviceId ? this.devices.get(deviceId) : this.onlyConnected();
    if (!device) return false;
    device.send(line);
    return true;
  }

  // --------------------------------------------------------------- lifecycle

  pump(): void {
    for (const device of this.devices.values()) device.pump();
  }

  endFrame(): void {
    for (const device of this.devices.values()) device.endFrame();
  }

  /** Per-frame and per-session state, not the connections. See `HardwareDevice.reset`. */
  reset(): void {
    for (const device of this.devices.values()) device.reset();
  }

  dispose(): void {
    for (const deviceId of [...this.devices.keys()]) this.remove(deviceId);
    this.events.clear();
  }

  private onlyConnected(): HardwareDevice | undefined {
    for (const device of this.devices.values()) if (device.connected) return device;
    return undefined;
  }
}
