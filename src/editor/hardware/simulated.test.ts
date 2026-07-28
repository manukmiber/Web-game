import { describe, expect, it } from 'vitest';
import {
  BOARD_PROFILES,
  DEFAULT_BOARD_PROFILE,
  SIMULATED_CHANNELS,
  SimulatedRig,
  findBoardProfile,
  simulatedRest,
} from './simulated';

describe('board profiles', () => {
  it('defaults to the Uno profile, matching the original fixed channel set', () => {
    expect(DEFAULT_BOARD_PROFILE.id).toBe('uno');
    expect(SIMULATED_CHANNELS).toEqual(['A0', 'A1', 'D2', 'D3']);
  });

  it('falls back to the default for an unknown id', () => {
    expect(findBoardProfile('nonexistent')).toBe(DEFAULT_BOARD_PROFILE);
  });

  it('rests an analog channel at the ADC midpoint for its profile', () => {
    const esp32 = findBoardProfile('esp32');
    expect(simulatedRest('A0', esp32)).toBe(Math.round(esp32.adcMax / 2));
    expect(simulatedRest('D2', esp32)).toBe(0);
  });

  it('every profile has a unique id', () => {
    const ids = BOARD_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('SimulatedRig', () => {
  it('announces itself with the profile channel list and rests them', async () => {
    const esp32 = findBoardProfile('esp32');
    const rig = new SimulatedRig('sim', esp32);
    await rig.start();
    rig.device.pump();

    expect(rig.channels).toEqual(['A0', 'A1', 'A2', 'D2', 'D3', 'D4']);
    for (const channel of rig.channels) {
      expect(rig.device.raw(channel)).toBe(simulatedRest(channel, esp32));
    }
  });

  it('a buttons-only board has no analog channels', async () => {
    const buttons = findBoardProfile('buttons');
    const rig = new SimulatedRig('sim', buttons);
    await rig.start();

    expect(rig.channels).toEqual(['D2', 'D3', 'D4', 'D5']);
  });

  it('records what the engine writes back, regardless of profile', async () => {
    const rig = new SimulatedRig('sim', findBoardProfile('uno'));
    await rig.start();

    rig.device.write('D13', 255);
    rig.poll();

    expect(rig.outputs.get('D13')).toBe(255);
  });
});
