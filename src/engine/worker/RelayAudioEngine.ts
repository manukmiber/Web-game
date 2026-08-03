import { AudioEngine, AudioHandle, type AudioBus, type MusicOptions, type PlayOptions } from '../audio/AudioEngine';
import type { Vec3 } from '../scene/types';
import type { AudioCommand } from './protocol';

/**
 * Stands in for `AudioEngine` inside the simulation worker, where there is no `AudioContext` to
 * be had — a Worker's global scope does not expose Web Audio at all, which is exactly the "no
 * Web Audio support" case `AudioEngine.ensureContext` already degrades to gracefully (§18.1).
 * Left at that, every `audio.play(...)` a script calls would go silent with no error the moment
 * it happens to be running in the worker rather than on the main thread — a regression, not a
 * documented limitation. So instead of just inheriting the no-op, this overrides the handful of
 * public methods `ScriptAudio` reaches and records what was asked for as a command, for the host
 * to replay on its own real `AudioEngine`.
 *
 * Subclassing rather than duck-typing the shape is what makes this small: `AudioHandle` calls
 * back into `isPlaying`/`stopVoice`/`setVoiceVolume`/`setVoicePosition`, and those are public
 * methods on `AudioEngine` — overriding just those four plus the two that create voices means
 * the real `AudioHandle` class works completely unmodified, with nothing in `AudioEngine`
 * itself needing to change (or even know this class exists) to make it possible.
 */
export class RelayAudioEngine extends AudioEngine {
  private nextRelayVoiceId = 1;
  private readonly playing = new Set<number>();
  private pending: AudioCommand[] = [];

  constructor() {
    super(() => {
      throw new Error('AudioContext is not available inside a simulation worker');
    });
  }

  /** Everything recorded since the last call, in call order. Clears the queue. */
  drain(): AudioCommand[] {
    if (this.pending.length === 0) return [];
    const commands = this.pending;
    this.pending = [];
    return commands;
  }

  override play(url: string, options: PlayOptions = {}): AudioHandle {
    const id = this.nextRelayVoiceId++;
    this.playing.add(id);
    this.pending.push({ method: 'play', voiceId: id, args: [url, options] });
    return new AudioHandle(this, id, url);
  }

  override playMusic(url: string, options: MusicOptions = {}): AudioHandle {
    const id = this.nextRelayVoiceId++;
    this.playing.add(id);
    this.pending.push({ method: 'playMusic', voiceId: id, args: [url, options] });
    return new AudioHandle(this, id, url);
  }

  override stopMusic(fadeSeconds = 0): void {
    this.pending.push({ method: 'stopMusic', voiceId: null, args: [fadeSeconds] });
  }

  override stopAll(): void {
    this.playing.clear();
    this.pending.push({ method: 'stopAll', voiceId: null, args: [] });
  }

  override isPlaying(id: number): boolean {
    return this.playing.has(id);
  }

  override stopVoice(id: number, fadeSeconds: number): void {
    if (!this.playing.delete(id)) return;
    this.pending.push({ method: 'stopVoice', voiceId: id, args: [fadeSeconds] });
  }

  override setVoiceVolume(id: number, volume: number): void {
    if (!this.playing.has(id)) return;
    this.pending.push({ method: 'setVoiceVolume', voiceId: id, args: [volume] });
  }

  override setVoicePosition(id: number, position: Vec3): void {
    if (!this.playing.has(id)) return;
    this.pending.push({ method: 'setVoicePosition', voiceId: id, args: [[...position]] });
  }

  override setBusVolume(bus: AudioBus, volume: number): void {
    super.setBusVolume(bus, volume);
    this.pending.push({ method: 'setBusVolume', voiceId: null, args: [bus, volume] });
  }

  override setMasterVolume(volume: number): void {
    super.setMasterVolume(volume);
    this.pending.push({ method: 'setMasterVolume', voiceId: null, args: [volume] });
  }

  override setMuted(muted: boolean): void {
    super.setMuted(muted);
    this.pending.push({ method: 'setMuted', voiceId: null, args: [muted] });
  }
}

/**
 * Host-side counterpart: replays a worker's recorded `AudioCommand`s against a real
 * `AudioEngine`, so sound a script started inside the worker is actually heard.
 *
 * `voices` correlates the relay's local voice ids with the real `AudioHandle`s this produces,
 * so a later `stopVoice`/`setVoiceVolume`/`setVoicePosition` for the same id reaches the same
 * sound. It is owned by the caller (`SimulationHost`) rather than kept here because it has to
 * survive across many calls to this function, one per frame, for the lifetime of a play session.
 *
 * Each command runs in its own `try`/`catch` for the same reason `sceneMirror.applySceneOps`
 * does: a command's `args` are whatever a script passed to `audio.play(...)`, unvalidated past
 * "it is an array", and one bad call must not stop the rest of the batch — or the frame it runs
 * in — from applying.
 */
export function applyAudioCommands(
  audio: AudioEngine,
  commands: readonly AudioCommand[],
  voices: Map<number, AudioHandle>,
): void {
  for (const command of commands) {
    try {
      applyOne(audio, command, voices);
    } catch (error) {
      console.warn('[SimulationWorker] dropped an audio command it could not replay:', command.method, error);
    }
  }
}

function applyOne(audio: AudioEngine, command: AudioCommand, voices: Map<number, AudioHandle>): void {
  const handle = command.voiceId !== null ? voices.get(command.voiceId) : undefined;
  switch (command.method) {
    case 'play': {
      const [url, options] = command.args as [string, PlayOptions | undefined];
      const created = audio.play(url, options);
      if (command.voiceId !== null) voices.set(command.voiceId, created);
      return;
    }
    case 'playMusic': {
      const [url, options] = command.args as [string, MusicOptions | undefined];
      const created = audio.playMusic(url, options);
      if (command.voiceId !== null) voices.set(command.voiceId, created);
      return;
    }
    case 'stopMusic':
      audio.stopMusic(command.args[0] as number | undefined);
      return;
    case 'stopAll':
      audio.stopAll();
      voices.clear();
      return;
    case 'stopVoice':
      handle?.stop(command.args[0] as number | undefined);
      if (command.voiceId !== null) voices.delete(command.voiceId);
      return;
    case 'setVoiceVolume':
      handle?.setVolume(command.args[0] as number);
      return;
    case 'setVoicePosition':
      handle?.setPosition(command.args[0] as Vec3);
      return;
    case 'setBusVolume':
      audio.setBusVolume(command.args[0] as AudioBus, command.args[1] as number);
      return;
    case 'setMasterVolume':
      audio.setMasterVolume(command.args[0] as number);
      return;
    case 'setMuted':
      audio.setMuted(command.args[0] as boolean);
      return;
  }
}
