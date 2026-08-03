import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../audio/AudioEngine';
import { applyAudioCommands, RelayAudioEngine } from './RelayAudioEngine';

/** A fake AudioContext, the same seam `AudioEngine.test.ts` uses — just enough for `ensureContext`
 * to succeed so the real `AudioEngine` on the "host" side of these tests actually creates voices. */
function fakeAudioContext() {
  const node = () => ({
    connect: () => {},
    gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} },
  });
  return {
    createGain: () => node(),
    createBufferSource: () => ({
      connect: () => {},
      start: () => {},
      stop: () => {},
      loop: false,
      buffer: null,
      onended: null,
    }),
    createPanner: () => ({ ...node(), connect: () => {} }),
    destination: {},
    listener: {},
    currentTime: 0,
    state: 'running',
  } as unknown as AudioContext;
}

describe('RelayAudioEngine', () => {
  it('never touches a real AudioContext — play() stays silent locally but is still "playing"', () => {
    const relay = new RelayAudioEngine();
    const handle = relay.play('sfx/hit.mp3', { volume: 0.5 });
    expect(handle.playing).toBe(true);
    expect(relay.drain()).toEqual([
      { method: 'play', voiceId: 1, args: ['sfx/hit.mp3', { volume: 0.5 }] },
    ]);
  });

  it('correlates a handle across stop/setVolume back to the same voice id', () => {
    const relay = new RelayAudioEngine();
    const handle = relay.play('sfx/hit.mp3');
    relay.drain();

    handle.setVolume(0.2);
    handle.stop(1.5);
    expect(handle.playing).toBe(false);

    expect(relay.drain()).toEqual([
      { method: 'setVoiceVolume', voiceId: 1, args: [0.2] },
      { method: 'stopVoice', voiceId: 1, args: [1.5] },
    ]);
  });

  it('drains empty once everything has been read', () => {
    const relay = new RelayAudioEngine();
    relay.play('a.mp3');
    relay.drain();
    expect(relay.drain()).toEqual([]);
  });

  it('records bus/master/mute changes and still answers reads locally', () => {
    const relay = new RelayAudioEngine();
    relay.setBusVolume('sfx', 0.3);
    relay.setMasterVolume(0.7);
    relay.setMuted(true);

    expect(relay.getBusVolume('sfx')).toBeCloseTo(0.3);
    expect(relay.getMasterVolume()).toBeCloseTo(0.7);
    expect(relay.isMuted()).toBe(true);
    expect(relay.drain().map((c) => c.method)).toEqual(['setBusVolume', 'setMasterVolume', 'setMuted']);
  });
});

describe('applyAudioCommands', () => {
  it('replays a play/setVolume/stop sequence against a real AudioEngine', () => {
    const relay = new RelayAudioEngine();
    const handle = relay.play('sfx/hit.mp3', { volume: 1 });
    handle.setVolume(0.4);
    handle.stop();
    const commands = relay.drain();

    const audio = new AudioEngine(() => fakeAudioContext());
    const voices = new Map();
    applyAudioCommands(audio, commands, voices);

    // The voice was started then immediately stopped, so nothing should still be playing.
    expect(audio.snapshot().voices).toBe(0);
  });

  it('drops a malformed command without breaking the rest of the batch', () => {
    const audio = new AudioEngine(() => fakeAudioContext());
    const voices = new Map();
    expect(() =>
      applyAudioCommands(
        audio,
        [
          { method: 'setBusVolume', voiceId: null, args: ['not-a-bus', 'not-a-number'] as never },
          { method: 'setMasterVolume', voiceId: null, args: [0.9] },
        ],
        voices,
      ),
    ).not.toThrow();
    expect(audio.getMasterVolume()).toBeCloseTo(0.9);
  });

  it('a stop/volume command for an unknown voice id is a harmless no-op', () => {
    const audio = new AudioEngine(() => fakeAudioContext());
    const voices = new Map();
    expect(() =>
      applyAudioCommands(
        audio,
        [
          { method: 'stopVoice', voiceId: 999, args: [0] },
          { method: 'setVoiceVolume', voiceId: 999, args: [0.5] },
        ],
        voices,
      ),
    ).not.toThrow();
  });
});
