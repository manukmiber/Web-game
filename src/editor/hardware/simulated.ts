import { HardwareDevice } from '@engine/hardware/HardwareDevice';
import { PROTOCOL_VERSION, parseLine } from '@engine/hardware/protocol';
import { LoopbackTransport } from '@engine/hardware/transport';

/** What the simulated board offers: two analog channels and two buttons. */
export const SIMULATED_CHANNELS = ['A0', 'A1', 'D2', 'D3'] as const;

/**
 * Where a channel sits when nothing is touching it: mid-scale for a stick, 0 for a button.
 *
 * Not a detail. The default bindings are `bipolar`, which maps mid-scale to zero and **0 to
 * full deflection** — so a simulated board that idled at 0 would spin the character on the spot
 * the moment Play was pressed, and the first thing anyone saw of this feature would be a bug
 * that is not one. A real centre-detented stick reads ~512; the fake one should too.
 */
export function simulatedRest(channel: string): number {
  return channel.startsWith('A') ? 512 : 0;
}

/**
 * A board made of sliders.
 *
 * Every part of this feature except the wire is testable without hardware — bindings,
 * calibration, deadzones, outputs, the lot — and a rig you cannot try until the post arrives
 * is a rig nobody will have configured correctly when it does. So the panel ships with a fake
 * one: the same `HardwareDevice`, the same protocol, the same bindings, driven by sliders
 * instead of by a potentiometer.
 *
 * It is also how the output side becomes visible at all. A real `D13=255` lights a real LED
 * somewhere; here it lands in `outputs` and the panel draws it, which is the difference
 * between "the binding is wrong" and "the lamp is not wired up".
 */
export class SimulatedRig {
  readonly transport = new LoopbackTransport('Simulated rig');
  readonly device: HardwareDevice;
  /** The last value the engine wrote to each channel — the board's side of the link. */
  readonly outputs = new Map<string, number>();

  constructor(id = 'sim') {
    this.device = new HardwareDevice(this.transport, { id, name: 'Simulated rig' });
  }

  async start(): Promise<void> {
    await this.device.open();
    this.transport.receive(
      `hello name="Simulated rig" protocol=${PROTOCOL_VERSION} channels=${SIMULATED_CHANNELS.join(',')}\n`,
    );
    for (const channel of SIMULATED_CHANNELS) this.set(channel, simulatedRest(channel));
  }

  /** Plays the board: reports a reading, exactly as a real one would. */
  set(channel: string, value: number): void {
    this.transport.receive(`${channel}=${value}\n`);
  }

  /**
   * Reads what the engine has written since the last call.
   *
   * Called from the panel's frame subscription rather than on a timer of its own: the values
   * only change when the engine ticks, and a second clock would show them at a different rate
   * than everything else in the panel.
   */
  poll(): void {
    const text = this.transport.drain();
    if (text.length === 0) return;
    for (const line of text.split('\n')) {
      const message = parseLine(line);
      if (message?.kind !== 'values') continue;
      for (const { channel, value } of message.values) this.outputs.set(channel, value);
    }
  }
}
