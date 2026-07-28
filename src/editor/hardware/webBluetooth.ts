import type { HardwareTransport, TransportEvents, TransportStatus } from '@engine/hardware/transport';

/**
 * Web Bluetooth, for a board that talks BLE instead of USB — an nRF52, an ESP32 running a BLE
 * sketch, or any board wired for the Nordic UART Service (NUS). NUS is not a standard the
 * Bluetooth SIG defines, but it is the de facto one: it is what Arduino's own BLE examples, the
 * Adafruit Bluefruit library and Nordic's own SDK all speak, so "a board that does BLE serial"
 * and "a board that does NUS" are close enough to the same board to treat as one case.
 *
 * Same reasoning as `webSerial.ts` for living in `editor/` rather than `engine/`: this reaches
 * for `navigator.bluetooth`, and `boundary.test.ts` forbids that below the editor line.
 *
 * Two things about the API shape the code below. A device can only be requested from a user
 * gesture and through the browser's own chooser — same privacy stance as Web Serial, no way to
 * enumerate nearby devices and pick silently. And GATT delivers notifications in whatever
 * chunks the peripheral's MTU allows, which for a Nordic UART TX characteristic is usually far
 * short of a full line — so, unlike the byte-stream transports, this one buffers until it sees
 * `\n` before treating a fragment as a line. `protocol.ts`'s own `LineFramer` does the same
 * buffering again above every transport for exactly this reason; buffering here too just keeps
 * partial GATT packets from being emitted as if they were complete text.
 */

// Minimal declarations. Web Bluetooth is not in TypeScript's DOM library, so the alternative is
// a dependency on @types/web-bluetooth for a handful of interfaces used nowhere else.
interface BluetoothRemoteGATTCharacteristicLike extends EventTarget {
  value: DataView | null;
  writeValueWithoutResponse?(data: BufferSource): Promise<void>;
  writeValue(data: BufferSource): Promise<void>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike>;
}

interface BluetoothRemoteGATTServiceLike {
  getCharacteristic(uuid: string): Promise<BluetoothRemoteGATTCharacteristicLike>;
}

interface BluetoothRemoteGATTServerLike {
  connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServerLike>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BluetoothRemoteGATTServiceLike>;
}

interface BluetoothDeviceLike extends EventTarget {
  readonly name?: string;
  readonly gatt?: BluetoothRemoteGATTServerLike;
}

interface BluetoothLike {
  requestDevice(options: {
    filters?: { services: string[] }[];
    optionalServices?: string[];
  }): Promise<BluetoothDeviceLike>;
}

function bluetooth(): BluetoothLike | undefined {
  return (navigator as unknown as { bluetooth?: BluetoothLike }).bluetooth;
}

/** Chrome, Edge and Android Chrome have it; Firefox, Safari and desktop Linux Chrome without a flag do not. */
export function isWebBluetoothAvailable(): boolean {
  return bluetooth() !== undefined;
}

/** Nordic UART Service — the de facto BLE-serial convention this transport speaks. */
const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
/** Board → editor. Notified. */
const NUS_TX_CHARACTERISTIC = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
/** Editor → board. Written. */
const NUS_RX_CHARACTERISTIC = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

/** Must be called from a click. Resolves to null if the user dismisses the chooser. */
export async function requestBluetoothDevice(): Promise<BluetoothDeviceLike | null> {
  const api = bluetooth();
  if (!api) return null;
  try {
    return await api.requestDevice({
      filters: [{ services: [NUS_SERVICE] }],
      optionalServices: [NUS_SERVICE],
    });
  } catch {
    // The spec throws on dismissal or "no matching device" rather than resolving to null.
    return null;
  }
}

export class WebBluetoothTransport implements HardwareTransport {
  readonly kind = 'bluetooth';
  status: TransportStatus = 'closed';

  private readonly device: BluetoothDeviceLike;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private rx: BluetoothRemoteGATTCharacteristicLike | null = null;
  /** Fragments notified before a line-ending arrives — GATT packets rarely carry a whole line. */
  private pending = '';
  private readonly listeners = {
    data: new Set<(payload: TransportEvents['data']) => void>(),
    status: new Set<(payload: TransportEvents['status']) => void>(),
  };
  private closing = false;
  private readonly onNotify = (event: Event) => this.handleNotify(event);
  private readonly onDisconnect = () => this.handleDisconnect();

  constructor(device: BluetoothDeviceLike) {
    this.device = device;
  }

  get label(): string {
    return this.device.name ?? 'Bluetooth device';
  }

  async open(): Promise<void> {
    if (this.status === 'open' || this.status === 'opening') return;
    this.setStatus('opening');
    this.closing = false;
    try {
      const gatt = this.device.gatt;
      if (!gatt) throw new Error('device has no GATT server');
      this.device.addEventListener('gattserverdisconnected', this.onDisconnect);
      const server = await gatt.connect();
      const service = await server.getPrimaryService(NUS_SERVICE);
      const tx = await service.getCharacteristic(NUS_TX_CHARACTERISTIC);
      this.rx = await service.getCharacteristic(NUS_RX_CHARACTERISTIC);
      tx.addEventListener('characteristicvaluechanged', this.onNotify);
      await tx.startNotifications();
      this.setStatus('open');
    } catch (error) {
      this.setStatus('error', message(error));
    }
  }

  async close(): Promise<void> {
    if (this.status === 'closed') return;
    this.closing = true;
    this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
    try {
      this.device.gatt?.disconnect();
    } catch {
      // Already gone — the peripheral going out of range is the usual way this happens.
    }
    this.rx = null;
    this.pending = '';
    this.setStatus('closed');
  }

  /**
   * Fire-and-forget, matching `SerialTransport.send`: nothing upstream awaits a lamp, and a
   * write that fails closes the link, which is the only response that helps.
   *
   * `writeValueWithoutResponse` when the characteristic offers it — a response round-trip per
   * line would cap the link well below what a stream of channel updates needs — falling back to
   * `writeValue` for peripherals that only support the acknowledged form.
   */
  send(text: string): void {
    if (!this.rx || this.status !== 'open') return;
    const bytes = this.encoder.encode(text);
    const write = this.rx.writeValueWithoutResponse
      ? this.rx.writeValueWithoutResponse(bytes)
      : this.rx.writeValue(bytes);
    void write.catch((error: unknown) => {
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

  private handleNotify(event: Event): void {
    const characteristic = event.target as BluetoothRemoteGATTCharacteristicLike;
    const value = characteristic.value;
    if (!value) return;
    this.pending += this.decoder.decode(value.buffer as ArrayBuffer, { stream: true });
    // Flush whatever full lines have accumulated; a trailing partial line waits for more.
    const lastBreak = this.pending.lastIndexOf('\n');
    if (lastBreak === -1) return;
    const complete = this.pending.slice(0, lastBreak + 1);
    this.pending = this.pending.slice(lastBreak + 1);
    this.emitData(complete);
  }

  private handleDisconnect(): void {
    this.rx = null;
    if (!this.closing && this.status === 'open') this.setStatus('closed', 'device disconnected');
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
