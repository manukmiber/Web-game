/**
 * The pipe a device is reached over, as an interface the engine can hold without knowing what
 * is on the other end.
 *
 * This is the same split ARCHITECTURE.md §9.5 forces on input: the engine describes what it
 * needs and the host supplies it. Web Serial is `navigator.serial`, and `navigator` is exactly
 * what `boundary.test.ts` forbids in here — so the concrete transports live in
 * `editor/hardware/`, the engine holds this interface, and a headless runtime can drive a real
 * device over a Node serial port with no change to anything below this line.
 *
 * Text rather than bytes, for the reason `protocol.ts` explains: the wire format is lines of
 * ASCII, and a transport that hands over strings is a transport you can implement in four
 * lines over a WebSocket.
 */

export type TransportStatus = 'closed' | 'opening' | 'open' | 'error';

export interface TransportEvents {
  data: { text: string };
  status: { status: TransportStatus; detail?: string };
}

export interface HardwareTransport {
  /** `serial`, `websocket`, `loopback` — shown in the device list. */
  readonly kind: string;
  /** Human-readable: "COM4 @ 115200", "ws://esp32.local/ws". */
  readonly label: string;
  readonly status: TransportStatus;
  open(): Promise<void>;
  close(): Promise<void>;
  /** Queues text for the device. Never throws — a dead link reports through `status`. */
  send(text: string): void;
  on<K extends keyof TransportEvents>(
    event: K,
    listener: (payload: TransportEvents[K]) => void,
  ): () => void;
}

/**
 * A transport with nothing on the other end, which is more useful than it sounds.
 *
 * It is what the tests drive (no board, no permissions prompt, no timing), and it is what the
 * editor's **simulated device** is built on, so the whole binding and calibration path can be
 * exercised — and demonstrated — by someone who has not bought an Arduino yet. `receive()`
 * plays the part of the board; `sent` records what the engine wrote to it.
 */
export class LoopbackTransport implements HardwareTransport {
  readonly kind = 'loopback';
  readonly label: string;
  status: TransportStatus = 'closed';

  /** Everything the engine has written, in order. Assertions read this. */
  readonly sent: string[] = [];

  private readonly listeners = {
    data: new Set<(payload: TransportEvents['data']) => void>(),
    status: new Set<(payload: TransportEvents['status']) => void>(),
  };

  constructor(label = 'Simulated device') {
    this.label = label;
  }

  async open(): Promise<void> {
    this.setStatus('open');
  }

  async close(): Promise<void> {
    this.setStatus('closed');
  }

  send(text: string): void {
    this.sent.push(text);
  }

  /** Plays the board: hands `text` to the device as if it had arrived over the wire. */
  receive(text: string): void {
    for (const listener of [...this.listeners.data]) listener({ text });
  }

  /** Everything written since the last call, joined. The simulated device's echo channel. */
  drain(): string {
    const text = this.sent.join('');
    this.sent.length = 0;
    return text;
  }

  on<K extends keyof TransportEvents>(
    event: K,
    listener: (payload: TransportEvents[K]) => void,
  ): () => void {
    const set = this.listeners[event] as Set<(payload: TransportEvents[K]) => void>;
    set.add(listener);
    return () => set.delete(listener);
  }

  private setStatus(status: TransportStatus, detail?: string): void {
    this.status = status;
    for (const listener of [...this.listeners.status]) listener({ status, detail });
  }
}
