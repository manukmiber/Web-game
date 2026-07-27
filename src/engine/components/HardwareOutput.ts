import type { Component } from '../scene/types';
import { registerComponent } from './registry';

/**
 * The other direction: game state driving lamps, meters, servos and rumble.
 *
 * Entity-scoped, unlike `HardwareInput`, and that is the useful asymmetry — `health` means
 * *this* entity's health, so a component on the player lights the player's damage lamp and one
 * on a turret drives the turret's. No wiring up an id, no "which entity did you mean".
 *
 * Every binding carries a rate limit because the link is narrow: 115200 baud is about 190
 * characters per frame at 60 fps, shared by every device on the desk. A health lamp updated
 * four times a second looks identical to one updated sixty times and costs a fifteenth of the
 * budget — and unchanged values are dropped before they reach the wire at all
 * (`HardwareDevice.write`).
 */
export interface HardwareOutputComponent extends Component {
  type: 'HardwareOutput';
  enabled: boolean;
  /** Device id for unqualified channels. Empty means the only connected device. */
  device: string;
  /** One binding per line — `D13 <- health01 scale=255`. See docs/HARDWARE.md. */
  bindings: string;
  /**
   * Written once when Play stops, to leave the rig dark.
   *
   * Without it a lamp lit on the last frame of a session stays lit on the desk afterwards,
   * which is the hardware equivalent of Play mode leaking state into the scene — the one thing
   * ARCHITECTURE.md §6 promises does not happen.
   */
  resetOnStop: boolean;
}

export const DEFAULT_OUTPUT_BINDINGS = `# channel <- source        (docs/HARDWARE.md)
# A lamp that lights as the stick is pushed forward.
D13 <- axis:move scale=255 min=0 max=255 rate=8
# On the Player instead, health is the binding worth having:
# D13 <- health01 scale=255 rate=8
`;

export function createHardwareOutput(
  overrides: Partial<HardwareOutputComponent> = {},
): HardwareOutputComponent {
  return {
    type: 'HardwareOutput',
    enabled: true,
    device: '',
    bindings: DEFAULT_OUTPUT_BINDINGS,
    resetOnStop: true,
    ...overrides,
  };
}

registerComponent<HardwareOutputComponent>({
  type: 'HardwareOutput',
  label: 'Hardware Output',
  create: createHardwareOutput,
  fields() {
    return [
      { kind: 'boolean', key: 'enabled', label: 'Enabled' },
      { kind: 'string', key: 'device', label: 'Device' },
      { kind: 'text', key: 'bindings', label: 'Bindings', rows: 5, monospace: true },
      { kind: 'boolean', key: 'resetOnStop', label: 'Zero On Stop' },
    ];
  },
});
