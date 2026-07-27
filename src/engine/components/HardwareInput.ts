import type { Component } from '../scene/types';
import { registerComponent } from './registry';

/**
 * Physical controls, mapped onto the input the game already reads.
 *
 * The whole point of routing through `InputState` rather than exposing a second input path is
 * that nothing downstream has to know. `CharacterSystem` reads `KeyW` and the `move` axis; it
 * cannot tell whether they came from a keyboard, a potentiometer or a test. A scene built with
 * a keyboard therefore works with a rig plugged in, and a scene built for a rig degrades to the
 * keyboard when it is unplugged — neither needs a second code path, and the bindings can be
 * changed while the game runs.
 *
 * It sits on an entity because everything in a scene does, and its effect is global rather than
 * entity-local — the same shape as `Environment`. One on the player, or one on an empty called
 * "Hardware Rig", is the intended use; several are summed, so a two-board cockpit can keep its
 * bindings next to the thing each board drives.
 */
export interface HardwareInputComponent extends Component {
  type: 'HardwareInput';
  enabled: boolean;
  /** Device id for unqualified channels. Empty means "whichever device has the channel". */
  device: string;
  /** One binding per line — see docs/HARDWARE.md. `A0 -> axis:move`, `D2 -> key:Space`. */
  bindings: string;
  /**
   * Exponential smoothing for axes, 0–0.95.
   *
   * A 10-bit ADC on a breadboard jitters by a couple of counts, which is invisible on a lamp
   * and very visible on a camera that will not sit still. Buttons are deliberately not
   * smoothed: a delayed edge is worse than a noisy one.
   */
  smoothing: number;
}

export const DEFAULT_INPUT_BINDINGS = `# channel -> target        (docs/HARDWARE.md)
A0 -> axis:turn bipolar deadzone=0.08
A1 -> axis:move bipolar deadzone=0.08
D2 -> key:Space
D3 -> key:ShiftLeft
`;

export function createHardwareInput(
  overrides: Partial<HardwareInputComponent> = {},
): HardwareInputComponent {
  return {
    type: 'HardwareInput',
    enabled: true,
    device: '',
    bindings: DEFAULT_INPUT_BINDINGS,
    smoothing: 0.25,
    ...overrides,
  };
}

registerComponent<HardwareInputComponent>({
  type: 'HardwareInput',
  label: 'Hardware Input',
  create: createHardwareInput,
  fields() {
    return [
      { kind: 'boolean', key: 'enabled', label: 'Enabled' },
      { kind: 'string', key: 'device', label: 'Device' },
      { kind: 'text', key: 'bindings', label: 'Bindings', rows: 6, monospace: true },
      { kind: 'number', key: 'smoothing', label: 'Smoothing', min: 0, max: 0.95, step: 0.05 },
    ];
  },
});
