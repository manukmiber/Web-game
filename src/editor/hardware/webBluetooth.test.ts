import { describe, expect, it, vi } from 'vitest';
import { WebBluetoothTransport } from './webBluetooth';

/** A fake GATT characteristic that can notify fragments and record writes. */
class FakeCharacteristic extends EventTarget {
  value: DataView | null = null;
  writes: string[] = [];
  writeValueWithoutResponse = vi.fn(async (data: BufferSource) => {
    this.writes.push(new TextDecoder().decode(data as ArrayBuffer));
  });
  writeValue = vi.fn(async (data: BufferSource) => {
    this.writes.push(new TextDecoder().decode(data as ArrayBuffer));
  });

  async startNotifications() {
    return this;
  }
  async stopNotifications() {
    return this;
  }

  /** Plays the peripheral: delivers one GATT notification of `text`. */
  notify(text: string): void {
    const bytes = new TextEncoder().encode(text);
    this.value = new DataView(bytes.buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

class FakeService {
  readonly tx = new FakeCharacteristic();
  readonly rx = new FakeCharacteristic();

  async getCharacteristic(uuid: string) {
    if (uuid.startsWith('6e400003')) return this.tx;
    if (uuid.startsWith('6e400002')) return this.rx;
    throw new Error(`unexpected characteristic ${uuid}`);
  }
}

class FakeServer {
  connected = false;
  readonly service = new FakeService();

  async connect() {
    this.connected = true;
    return this;
  }
  disconnect() {
    this.connected = false;
  }
  async getPrimaryService() {
    return this.service;
  }
}

class FakeDevice extends EventTarget {
  readonly name = 'Test Board';
  readonly gatt = new FakeServer();
}

describe('WebBluetoothTransport', () => {
  it('opens, reports its label, and moves to the open status', async () => {
    const device = new FakeDevice();
    const transport = new WebBluetoothTransport(device);
    expect(transport.label).toBe('Test Board');

    const statuses: string[] = [];
    transport.on('status', (payload) => statuses.push(payload.status));
    await transport.open();

    expect(transport.status).toBe('open');
    expect(statuses).toEqual(['opening', 'open']);
  });

  it('buffers notification fragments until a line ending arrives', async () => {
    const device = new FakeDevice();
    const transport = new WebBluetoothTransport(device);
    await transport.open();

    const lines: string[] = [];
    transport.on('data', (payload) => lines.push(payload.text));

    device.gatt.service.tx.notify('A0=5');
    device.gatt.service.tx.notify('12 D2=1\n');

    expect(lines).toEqual(['A0=512 D2=1\n']);
  });

  it('writes without response when the characteristic supports it', async () => {
    const device = new FakeDevice();
    const transport = new WebBluetoothTransport(device);
    await transport.open();

    transport.send('D13=255\n');
    await Promise.resolve();

    expect(device.gatt.service.rx.writes).toEqual(['D13=255\n']);
    expect(device.gatt.service.rx.writeValueWithoutResponse).toHaveBeenCalled();
  });

  it('drops to closed on GATT disconnect, and to error on a failed write', async () => {
    const device = new FakeDevice();
    const transport = new WebBluetoothTransport(device);
    await transport.open();

    device.dispatchEvent(new Event('gattserverdisconnected'));
    expect(transport.status).toBe('closed');
  });

  it('does nothing when closed', () => {
    const device = new FakeDevice();
    const transport = new WebBluetoothTransport(device);
    transport.send('D13=1\n');
    expect(device.gatt.service.rx.writes).toEqual([]);
  });

  it('close() disconnects and clears pending state', async () => {
    const device = new FakeDevice();
    const transport = new WebBluetoothTransport(device);
    await transport.open();
    await transport.close();

    expect(transport.status).toBe('closed');
    expect(device.gatt.connected).toBe(false);
  });
});
