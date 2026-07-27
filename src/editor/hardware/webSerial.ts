import type { HardwareTransport, TransportEvents, TransportStatus } from '@engine/hardware/transport';

/**
 * Web Serial, which is how a browser talks to an Arduino over USB.
 *
 * This lives in `editor/` rather than `engine/` because it reaches for `navigator`, and
 * `boundary.test.ts` forbids that below the editor line — see `engine/hardware/transport.ts`
 * for why that turned out to be the right shape rather than an obstacle.
 *
 * Two things about the API are worth knowing before reading the code. A port can only be
 * requested from a user gesture, and the chooser is the browser's, not ours: there is no way
 * to enumerate ports and present our own list, which is a privacy decision and not one to work
 * around. And `port.readable` is a stream that ends when the device is unplugged mid-read,
 * which is the normal way a session ends rather than an error case.
 */

// Minimal declarations. The project's `types` is `["vite/client"]` and Web Serial is not in
// TypeScript's DOM library, so the alternative is a dependency on @types/w3c-web-serial for
// four interfaces.
interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}

interface SerialLike {
  requestPort(options?: { filters?: { usbVendorId: number }[] }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}

function serial(): SerialLike | undefined {
  return (navigator as unknown as { serial?: SerialLike }).serial;
}

/** Chrome and Edge have it; Firefox and Safari do not, and say so in the panel. */
export function isWebSerialAvailable(): boolean {
  return serial() !== undefined;
}

/** The rates worth offering. 115200 is what almost every sketch opens with. */
export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 250000, 500000] as const;

/** Must be called from a click. Resolves to null if the user dismisses the chooser. */
export async function requestSerialPort(): Promise<SerialPortLike | null> {
  const api = serial();
  if (!api) return null;
  try {
    return await api.requestPort();
  } catch {
    // The spec throws on dismissal rather than resolving to null.
    return null;
  }
}

/** Ports the user has already granted this origin, so a reload can reconnect without a click. */
export async function grantedSerialPorts(): Promise<SerialPortLike[]> {
  const api = serial();
  if (!api) return [];
  try {
    return await api.getPorts();
  } catch {
    return [];
  }
}

export class SerialTransport implements HardwareTransport {
  readonly kind = 'serial';
  status: TransportStatus = 'closed';

  private readonly port: SerialPortLike;
  private readonly baudRate: number;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readonly listeners = {
    data: new Set<(payload: TransportEvents['data']) => void>(),
    status: new Set<(payload: TransportEvents['status']) => void>(),
  };
  /** Set while closing, so the read loop ending is not reported as a failure. */
  private closing = false;

  constructor(port: SerialPortLike, baudRate = 115200) {
    this.port = port;
    this.baudRate = baudRate;
  }

  get label(): string {
    const info = this.port.getInfo();
    const id =
      info.usbVendorId !== undefined
        ? `USB ${hex(info.usbVendorId)}:${hex(info.usbProductId ?? 0)}`
        : 'Serial port';
    return `${id} @ ${this.baudRate}`;
  }

  async open(): Promise<void> {
    if (this.status === 'open' || this.status === 'opening') return;
    this.setStatus('opening');
    this.closing = false;
    try {
      await this.port.open({ baudRate: this.baudRate });
      this.writer = this.port.writable?.getWriter() ?? null;
      this.setStatus('open');
      void this.readLoop();
    } catch (error) {
      this.setStatus('error', message(error));
    }
  }

  async close(): Promise<void> {
    if (this.status === 'closed') return;
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {
      // Already gone — unplugging the board is the usual way this happens.
    }
    this.reader = null;
    try {
      this.writer?.releaseLock();
      await this.port.close();
    } catch {
      // Same.
    }
    this.writer = null;
    this.setStatus('closed');
  }

  /**
   * Fire-and-forget: `write` returns a promise that resolves when the OS accepted the bytes,
   * and nothing upstream wants to await a lamp. A failure closes the link, which is the only
   * response that helps — a serial write that fails once fails for good.
   */
  send(text: string): void {
    if (!this.writer || this.status !== 'open') return;
    void this.writer.write(this.encoder.encode(text)).catch((error: unknown) => {
      this.setStatus('error', message(error));
      void this.close();
    });
  }

  on<K extends keyof TransportEvents>(
    event: K,
    listener: (payload: TransportEvents[K]) => void,
  ): () => void {
    const set = this.listeners[event] as Set<(payload: TransportEvents[K]) => void>;
    set.add(listener);
    return () => set.delete(listener);
  }

  private async readLoop(): Promise<void> {
    const stream = this.port.readable;
    if (!stream) {
      this.setStatus('error', 'port has no readable stream');
      return;
    }

    this.reader = stream.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this.emitData(this.decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      if (!this.closing) this.setStatus('error', message(error));
    } finally {
      try {
        this.reader?.releaseLock();
      } catch {
        // The lock is gone with the stream when the device was unplugged.
      }
      this.reader = null;
      // A stream that ended on its own means the board went away.
      if (!this.closing && this.status === 'open') this.setStatus('closed', 'device disconnected');
    }
  }

  private emitData(text: string): void {
    for (const listener of [...this.listeners.data]) listener({ text });
  }

  private setStatus(status: TransportStatus, detail?: string): void {
    this.status = status;
    for (const listener of [...this.listeners.status]) {
      listener(detail === undefined ? { status } : { status, detail });
    }
  }
}

function hex(value: number): string {
  return value.toString(16).padStart(4, '0');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
