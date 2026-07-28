import { beforeEach, describe, expect, it } from 'vitest';
import { HardwareBus, parseChannelRef } from './HardwareBus';
import { HardwareDevice } from './HardwareDevice';
import { LoopbackTransport } from './transport';

/** A device with an open loopback link, which is what every test here needs first. */
async function device(id: string): Promise<{ device: HardwareDevice; link: LoopbackTransport }> {
  const link = new LoopbackTransport(id);
  const created = new HardwareDevice(link, { id });
  await created.open();
  link.drain(); // the identify request sent on open
  return { device: created, link };
}

describe('HardwareDevice', () => {
  let bus: HardwareBus;

  beforeEach(() => {
    bus = new HardwareBus();
  });

  it('shows nothing until the frame is pumped', async () => {
    const { device: uno, link } = await device('uno');
    bus.add(uno);

    link.receive('A0=512\n');
    // The line has arrived, but this frame has already read its inputs.
    expect(bus.raw('A0')).toBe(0);

    bus.pump();
    expect(bus.raw('A0')).toBe(512);
  });

  it('holds a value until the device sends another one', async () => {
    const { device: uno, link } = await device('uno');
    bus.add(uno);

    link.receive('A0=300\n');
    bus.pump();
    bus.endFrame();
    bus.pump();

    expect(bus.raw('A0')).toBe(300);
  });

  it('reports edges for one frame, the way a keyboard does', async () => {
    const { device: uno, link } = await device('uno');
    bus.add(uno);

    link.receive('D2=1\n');
    bus.pump();
    expect(bus.isDown('D2')).toBe(true);
    expect(bus.wasPressed('D2')).toBe(true);

    bus.endFrame();
    bus.pump();
    expect(bus.isDown('D2')).toBe(true);
    expect(bus.wasPressed('D2')).toBe(false);

    link.receive('D2=0\n');
    bus.pump();
    expect(bus.wasReleased('D2')).toBe(true);
    expect(bus.isDown('D2')).toBe(false);
  });

  it('normalizes against the channel type when nothing calibrates it', async () => {
    const { device: uno, link } = await device('uno');
    bus.add(uno);

    link.receive('A0=1023 D4=1\n');
    bus.pump();

    expect(bus.value('A0')).toBe(1); // 10-bit ADC
    expect(bus.value('D4')).toBe(1);
  });

  it('takes a name and a channel list from the handshake', async () => {
    const { device: uno, link } = await device('uno');
    bus.add(uno);

    link.receive('hello name=Cockpit protocol=1 channels=A0,D2\n');
    bus.pump();

    expect(uno.name).toBe('Cockpit');
    // Declared but never reported: visible in the panel, reading zero.
    expect(uno.list().map((state) => state.channel)).toEqual(['A0', 'D2']);
    expect(uno.raw('A0')).toBe(0);
  });

  it('does not spend the serial budget repeating itself', async () => {
    const { device: uno, link } = await device('uno');
    bus.add(uno);

    expect(uno.write('D13', 1)).toBe(true);
    expect(uno.write('D13', 1)).toBe(false);
    expect(uno.write('D13', 0)).toBe(true);
    expect(link.drain()).toBe('D13=1\nD13=0\n');

    // Unless the caller knows the board may have missed it.
    uno.write('D13', 0, true);
    expect(link.drain()).toBe('D13=0\n');
  });

  it('writes nothing to a closed link', async () => {
    const { device: uno, link } = await device('uno');
    bus.add(uno);
    await uno.close();
    link.drain();

    expect(uno.write('D13', 1)).toBe(false);
    expect(link.drain()).toBe('');
  });
});

describe('HardwareBus', () => {
  it('splits a qualified reference', () => {
    expect(parseChannelRef('A0')).toEqual({ deviceId: null, channel: 'A0' });
    expect(parseChannelRef('uno:A0')).toEqual({ deviceId: 'uno', channel: 'A0' });
  });

  it('resolves an unqualified channel to whichever device reports it', async () => {
    const bus = new HardwareBus();
    const { device: uno, link: unoLink } = await device('uno');
    const { device: mega, link: megaLink } = await device('mega');
    bus.add(uno);
    bus.add(mega);

    unoLink.receive('A0=100\n');
    megaLink.receive('A1=900\n');
    bus.pump();

    expect(bus.raw('A0')).toBe(100);
    expect(bus.raw('A1')).toBe(900);
    expect(bus.raw('mega:A1')).toBe(900);
    // Qualified at the wrong board is a miss, not a lucky hit on the other one.
    expect(bus.raw('uno:A1')).toBe(0);
  });

  it('reads zero and writes false with nothing plugged in', () => {
    const bus = new HardwareBus();
    expect(bus.connected).toBe(false);
    expect(bus.raw('A0')).toBe(0);
    expect(bus.isDown('D2')).toBe(false);
    expect(bus.write('D13', 1)).toBe(false);
  });

  it('drops buffered lines and edges on reset but keeps the connection', async () => {
    const bus = new HardwareBus();
    const { device: uno, link } = await device('uno');
    bus.add(uno);

    link.receive('D2=1\n');
    bus.reset();
    bus.pump();

    expect(uno.connected).toBe(true);
    expect(bus.wasPressed('D2')).toBe(false);
    expect(bus.raw('D2')).toBe(0);
  });

  it('forgets what it last wrote on reset, so the next session re-sends it', async () => {
    const bus = new HardwareBus();
    const { device: uno, link } = await device('uno');
    bus.add(uno);

    uno.write('D13', 1);
    link.drain();
    bus.reset();

    expect(uno.write('D13', 1)).toBe(true);
    expect(link.drain()).toBe('D13=1\n');
  });

  it('reports device logs and errors through one place', async () => {
    const bus = new HardwareBus();
    const { device: uno, link } = await device('uno');
    const seen: string[] = [];
    bus.events.on('log', ({ level, text }) => seen.push(`${level}: ${text}`));
    bus.add(uno);

    link.receive('#calibrating\n!stick stuck\n');
    bus.pump();

    expect(seen).toContain('info: calibrating');
    expect(seen).toContain('error: stick stuck');
  });

  it('bubbles every raw line, in both directions, for a serial monitor', async () => {
    const bus = new HardwareBus();
    const { device: uno, link } = await device('uno');
    const seen: string[] = [];
    bus.events.on('line', ({ deviceId, direction, text }) => seen.push(`${deviceId} ${direction} ${text}`));
    bus.add(uno);

    link.receive('A0=512\n');
    bus.pump();
    uno.write('D13', 255);

    expect(seen).toContain('uno in A0=512');
    expect(seen).toContain('uno out D13=255\n');
  });
});
