import { HardwareDevice } from '@engine/hardware/HardwareDevice';
import { PROTOCOL_VERSION, parseLine } from '@engine/hardware/protocol';
import { LoopbackTransport } from '@engine/hardware/transport';

/**
 * A shape of virtual board: which channels it offers and how wide its ADC is.
 *
 * Real rigs are not all the same board. An AVR Uno's ADC is 10-bit; an ESP32's is 12-bit; a
 * board with no analog pins wired up is all buttons. Modelling that here — rather than hardcoding
 * one four-channel fake board — is what makes the simulator useful for more than the tutorial
 * rig: a binding written `A0 -> axis:turn max=4095` can be built and tested with nothing plugged
 * in, against a virtual board whose ADC actually goes that high.
 */
export interface BoardProfile {
  readonly id: string;
  readonly label: string;
  /** Analog channel names, `A0`-style. */
  readonly analog: readonly string[];
  /** Digital/button channel names, `D2`-style. */
  readonly digital: readonly string[];
  /** The ADC's top reading — 1023 for a 10-bit converter, 4095 for a 12-bit one. */
  readonly adcMax: number;
}

export const BOARD_PROFILES: readonly BoardProfile[] = [
  {
    id: 'uno',
    label: 'Uno (10-bit)',
    analog: ['A0', 'A1'],
    digital: ['D2', 'D3'],
    adcMax: 1023,
  },
  {
    id: 'esp32',
    label: 'ESP32 (12-bit)',
    analog: ['A0', 'A1', 'A2'],
    digital: ['D2', 'D3', 'D4'],
    adcMax: 4095,
  },
  {
    id: 'buttons',
    label: 'Buttons only',
    analog: [],
    digital: ['D2', 'D3', 'D4', 'D5'],
    adcMax: 1023,
  },
];

export const DEFAULT_BOARD_PROFILE: BoardProfile = BOARD_PROFILES[0]!;

export function findBoardProfile(id: string): BoardProfile {
  return BOARD_PROFILES.find((profile) => profile.id === id) ?? DEFAULT_BOARD_PROFILE;
}

function channelsOf(profile: BoardProfile): string[] {
  return [...profile.analog, ...profile.digital];
}

/** Kept for callers that assumed the original fixed board — the default profile's channels. */
export const SIMULATED_CHANNELS = channelsOf(DEFAULT_BOARD_PROFILE);

/**
 * Where a channel sits when nothing is touching it: mid-scale for a stick, 0 for a button.
 *
 * Not a detail. The default bindings are `bipolar`, which maps mid-scale to zero and **0 to
 * full deflection** — so a simulated board that idled at 0 would spin the character on the spot
 * the moment Play was pressed, and the first thing anyone saw of this feature would be a bug
 * that is not one. A real centre-detented stick reads ~512; the fake one should too, and a wider
 * ADC's mid-scale is wider too.
 */
export function simulatedRest(channel: string, profile: BoardProfile = DEFAULT_BOARD_PROFILE): number {
  return channel.startsWith('A') ? Math.round(profile.adcMax / 2) : 0;
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
  readonly transport: LoopbackTransport;
  readonly device: HardwareDevice;
  readonly profile: BoardProfile;
  /** The channels this rig's board offers — `[...profile.analog, ...profile.digital]`. */
  readonly channels: readonly string[];
  /** The last value the engine wrote to each channel — the board's side of the link. */
  readonly outputs = new Map<string, number>();

  constructor(id = 'sim', profile: BoardProfile = DEFAULT_BOARD_PROFILE) {
    this.profile = profile;
    this.channels = channelsOf(profile);
    this.transport = new LoopbackTransport(`Simulated ${profile.label}`);
    this.device = new HardwareDevice(this.transport, { id, name: `Simulated ${profile.label}` });
  }

  async start(): Promise<void> {
    await this.device.open();
    this.transport.receive(
      `hello name="Simulated ${this.profile.label}" protocol=${PROTOCOL_VERSION} channels=${this.channels.join(',')}\n`,
    );
    for (const channel of this.channels) this.set(channel, simulatedRest(channel, this.profile));
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
