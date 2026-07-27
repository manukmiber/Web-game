import type { HardwareTransport, TransportEvents, TransportStatus } from '@engine/hardware/transport';

/**
 * The same line protocol over a WebSocket.
 *
 * Two cases need it, and neither is exotic. A board with wifi — an ESP32, a Pi Pico W —
 * already speaks WebSocket and never touches USB, so there is nothing to plug in and the rig
 * can be across the room. And Firefox and Safari have no Web Serial and no plans to add it, so
 * on those browsers a small bridge process next to the board is the only route to a USB
 * device; anything that relays a serial port to a WebSocket works, because the contract is
 * just "the same lines, in both directions".
 *
 * Reconnection is deliberate rather than automatic: a board that is being flashed drops the
 * socket, and a transport that dials back every second turns a flash cycle into a log full of
 * failures. The panel has a button.
 */
export class WebSocketTransport implements HardwareTransport {
  readonly kind = 'websocket';
  readonly label: string;
  status: TransportStatus = 'closed';

  private readonly url: string;
  private socket: WebSocket | null = null;
  /** Text written before the socket finished opening, flushed on open. */
  private queue: string[] = [];
  private readonly listeners = {
    data: new Set<(payload: TransportEvents['data']) => void>(),
    status: new Set<(payload: TransportEvents['status']) => void>(),
  };
  private closing = false;

  constructor(url: string) {
    this.url = url;
    this.label = url;
  }

  open(): Promise<void> {
    if (this.status === 'open' || this.status === 'opening') return Promise.resolve();
    this.closing = false;
    this.setStatus('opening');

    return new Promise((resolve) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url);
      } catch (error) {
        this.setStatus('error', message(error));
        resolve();
        return;
      }
      this.socket = socket;
      socket.binaryType = 'arraybuffer';

      socket.onopen = () => {
        this.setStatus('open');
        for (const text of this.queue.splice(0)) socket.send(text);
        resolve();
      };
      socket.onmessage = (event: MessageEvent) => {
        const { data } = event;
        if (typeof data === 'string') this.emitData(data);
        else if (data instanceof ArrayBuffer) this.emitData(new TextDecoder().decode(data));
        else if (data instanceof Blob) void data.text().then((text) => this.emitData(text));
      };
      socket.onerror = () => {
        // The event carries no detail by design (it would leak cross-origin information), so
        // there is nothing more useful to report than that it failed.
        if (!this.closing) this.setStatus('error', 'connection failed');
        resolve();
      };
      socket.onclose = () => {
        this.socket = null;
        if (this.status !== 'error') this.setStatus('closed');
        resolve();
      };
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.queue = [];
    this.socket?.close();
    this.socket = null;
    this.setStatus('closed');
  }

  send(text: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(text);
    else if (this.status === 'opening') this.queue.push(text);
  }

  on<K extends keyof TransportEvents>(
    event: K,
    listener: (payload: TransportEvents[K]) => void,
  ): () => void {
    const set = this.listeners[event] as Set<(payload: TransportEvents[K]) => void>;
    set.add(listener);
    return () => set.delete(listener);
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
