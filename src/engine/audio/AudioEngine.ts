import { Emitter } from '../core/Emitter';
import type { Vec3 } from '../scene/types';

/**
 * The three things a sound can be, each with its own fader.
 *
 * Not "master" — master is `setMasterVolume`/`setMuted`, a single knob above all three buses
 * rather than a fourth bus, because "mute everything" and "mute music" are different gestures
 * and conflating them means a muted master that forgets it was muted the moment someone touches
 * the music slider.
 */
export type AudioBus = 'music' | 'sfx' | 'ambient';

export const AUDIO_BUSES: readonly AudioBus[] = ['music', 'sfx', 'ambient'];

const DEFAULT_BUS_VOLUME: Record<AudioBus, number> = { music: 0.8, sfx: 1, ambient: 0.7 };

export interface PlayOptions {
  bus?: AudioBus;
  volume?: number;
  loop?: boolean;
  /**
   * World position for a spatial sound, panned and attenuated by distance from the listener.
   * Omitted for a 2D sound — UI clicks, a damage grunt that should read the same regardless of
   * where the player is standing.
   */
  position?: Vec3;
  /** Metres at which the sound is at full volume. Defaults to 1. */
  refDistance?: number;
  /** Metres beyond which the sound has faded to nothing. Defaults to 40. */
  maxDistance?: number;
  /** How sharply it falls off between them. Defaults to 1. */
  rolloffFactor?: number;
}

export interface MusicOptions {
  volume?: number;
  loop?: boolean;
  /** Crossfade length. The outgoing track fades out over the same span as the incoming fades in. */
  fadeSeconds?: number;
}

/**
 * A reading of the whole engine, for the mixer panel.
 *
 * `state` distinguishes three things that all sound like "no audio" from the outside and want
 * completely different responses: `idle` means nothing has asked for a context yet and the first
 * `play` will make one, `suspended` means the browser is waiting for a user gesture and the
 * panel should offer one, and `unavailable` means there is no Web Audio here at all and no
 * amount of clicking will change that.
 */
export interface AudioSnapshot {
  voices: number;
  musicPlaying: boolean;
  clipsLoaded: number;
  clipsLoading: number;
  masterVolume: number;
  muted: boolean;
  busVolumes: Record<AudioBus, number>;
  state: 'idle' | 'running' | 'suspended' | 'closed' | 'unavailable';
}

export interface AudioEngineEvents {
  /** A clip failed to fetch or decode. Scripts and the console both want to know, nothing throws. */
  loadError: { url: string; message: string };
}

/**
 * A voice, which spends its first moments as an intention rather than a sound.
 *
 * `play()` returns before the clip has decoded, so everything the caller says in the meantime —
 * a volume, a fade, a new position — has to be *held* rather than applied, and applied when the
 * nodes finally exist. `volume` was always held that way; `fadeIn` and `position` are here
 * because they were not, and the resulting bug was invisible on the second play of any clip and
 * present on the first.
 */
interface Voice {
  id: number;
  clipId: string;
  bus: AudioBus;
  loop: boolean;
  volume: number;
  /** Seconds to ramp up from silence when the voice starts. 0 for a hard start. */
  fadeIn: number;
  /**
   * Where the sound is, or null for a 2D one.
   *
   * Null is a *kind*, not a missing value: a voice started without a position has no panner and
   * never gains one, so `setPosition` on it stays the documented no-op rather than quietly
   * turning a UI blip into a spatial sound halfway through.
   */
  position: Vec3 | null;
  spatial: Omit<PlayOptions, 'position' | 'bus' | 'volume' | 'loop'>;
  /** Set once `stop()` is called before the clip finished decoding, so it never starts at all. */
  cancelled: boolean;
  source: AudioBufferSourceNode | null;
  gain: GainNode | null;
  panner: PannerNode | null;
}

/**
 * A playing (or about-to-play) sound, handed back by `play`/`playMusic`.
 *
 * Thin and id-based, the same shape `BodyHandle`/`EntityHandle` use in `ScriptApi` — it survives
 * the sound finishing or being stopped from elsewhere (`stopAll`), it just stops doing anything.
 */
export class AudioHandle {
  constructor(
    private readonly engine: AudioEngine,
    readonly id: number,
    readonly clipId: string,
  ) {}

  get playing(): boolean {
    return this.engine.isPlaying(this.id);
  }

  stop(fadeSeconds = 0): void {
    this.engine.stopVoice(this.id, fadeSeconds);
  }

  setVolume(volume: number): void {
    this.engine.setVoiceVolume(this.id, volume);
  }

  /** Moves a spatial sound. A no-op on one that was not started with a position. */
  setPosition(position: Vec3): void {
    this.engine.setVoicePosition(this.id, position);
  }
}

/**
 * Web Audio, kept behind a seam Play mode can reset and a test can drive without a browser.
 *
 * The `AudioContext` is created lazily, on the first call that needs one, rather than in the
 * constructor. Two reasons: browsers refuse to run a context until a user gesture has reached
 * the page, so building one at `new Engine()` produces a context stuck in `suspended` for no
 * benefit, and `AudioContext` does not exist in Vitest's Node environment at all — constructing
 * it eagerly would make importing this module fail every test that touches the engine, not just
 * the ones about audio.
 *
 * `contextFactory` is the same dependency-injection seam `HardwareTransport` and
 * `ScenePersistence` use elsewhere: production takes the default and gets a real
 * `AudioContext`, and a test hands in a fake that implements only the handful of calls this file
 * makes.
 */
export class AudioEngine {
  readonly events = new Emitter<AudioEngineEvents>();

  private readonly contextFactory: () => AudioContext;
  private context: AudioContext | null = null;
  /** Set once context creation has thrown, so every later call fails the same cheap way. */
  private unavailable = false;

  private masterGain: GainNode | null = null;
  private busGains: Partial<Record<AudioBus, GainNode>> = {};
  private busVolumes: Record<AudioBus, number> = { ...DEFAULT_BUS_VOLUME };
  private masterVolume = 1;
  private muted = false;

  private buffers = new Map<string, AudioBuffer>();
  private pendingLoads = new Map<string, Promise<AudioBuffer | null>>();

  private voices = new Map<number, Voice>();
  private nextVoiceId = 1;
  private musicVoiceId: number | null = null;

  constructor(contextFactory: () => AudioContext = () => new AudioContext()) {
    this.contextFactory = contextFactory;
  }

  /**
   * Unlocks the context on a user gesture. Safe to call every time — a running context resolves
   * immediately, and an environment with no Web Audio at all resolves too, doing nothing.
   */
  async resume(): Promise<void> {
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  }

  /** True once a real `AudioContext` exists and construction has not failed. */
  get available(): boolean {
    return this.ensureContext() !== null;
  }

  // ------------------------------------------------------------------- clips

  /**
   * Fetches and decodes a clip, caching it by URL. Never throws — a missing or unreadable sound
   * file should not be able to crash a script or stop a scene from playing; it reports through
   * `events` and every `play()` for that URL quietly does nothing.
   */
  async loadClip(url: string): Promise<boolean> {
    if (this.buffers.has(url)) return true;
    const pending = this.pendingLoads.get(url);
    if (pending) return (await pending) !== null;

    const promise = this.decode(url);
    this.pendingLoads.set(url, promise);
    const buffer = await promise;
    this.pendingLoads.delete(url);
    return buffer !== null;
  }

  private async decode(url: string): Promise<AudioBuffer | null> {
    const ctx = this.ensureContext();
    if (!ctx) return null;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.arrayBuffer();
      const buffer = await ctx.decodeAudioData(data);
      this.buffers.set(url, buffer);
      return buffer;
    } catch (error) {
      this.events.emit('loadError', { url, message: (error as Error).message });
      return null;
    }
  }

  /** Whether a clip is decoded and ready to play instantly. */
  isLoaded(url: string): boolean {
    return this.buffers.has(url);
  }

  // ------------------------------------------------------------------ playback

  /**
   * Plays a clip, fetching and decoding it first if it has not been loaded yet.
   *
   * Always returns a handle, even for a clip that has not finished decoding — the same
   * "resolves when it's ready" contract `AssetStore` gives textures (v0.7.6 fixed the one place
   * that forgot it). The handle is valid immediately: `stop()` before the decode finishes just
   * cancels the pending start, and volume/position set on it are held until then.
   */
  play(url: string, options: PlayOptions = {}): AudioHandle {
    const id = this.nextVoiceId++;
    // No Web Audio at all (headless, or construction failed) — an inert handle rather than a
    // voice nothing will ever start, so `stop`/`setVolume` on it stay harmless no-ops.
    if (!this.available) return new AudioHandle(this, id, url);

    const voice: Voice = {
      id,
      clipId: url,
      bus: options.bus ?? 'sfx',
      loop: options.loop ?? false,
      volume: options.volume ?? 1,
      fadeIn: 0,
      position: options.position ? [...options.position] : null,
      spatial: {
        refDistance: options.refDistance,
        maxDistance: options.maxDistance,
        rolloffFactor: options.rolloffFactor,
      },
      cancelled: false,
      source: null,
      gain: null,
      panner: null,
    };
    this.voices.set(id, voice);

    const cached = this.buffers.get(url);
    if (cached) {
      this.start(voice, cached);
    } else {
      void this.loadClip(url).then(() => {
        if (voice.cancelled) return;
        const buffer = this.buffers.get(url);
        if (buffer) this.start(voice, buffer);
        else this.voices.delete(id);
      });
    }

    return new AudioHandle(this, id, url);
  }

  /**
   * The music bus is a single slot, not a stack — starting a track stops whatever was playing
   * there. `fadeSeconds` crossfades: the old track ramps to silence over the same span the new
   * one ramps up from it, so a wave transition doesn't cut the score off mid-bar.
   */
  playMusic(url: string, options: MusicOptions = {}): AudioHandle {
    const fade = Math.max(0, options.fadeSeconds ?? 0);
    if (this.musicVoiceId !== null) this.stopVoice(this.musicVoiceId, fade);

    const handle = this.play(url, {
      bus: 'music',
      loop: options.loop ?? true,
      volume: options.volume ?? 1,
    });
    this.musicVoiceId = handle.id;

    const voice = this.voices.get(handle.id);
    // Requested rather than performed. A track being played for the first time has not decoded
    // yet, so there is no gain node to ramp — and the old code, which reached straight for one,
    // silently skipped the fade on exactly that play and honoured it on every play afterwards.
    // A crossfade that works only once the file is warm is worse than none: it is a bug you
    // cannot reproduce, because reproducing it means reloading the page.
    if (voice && fade > 0) this.requestFadeIn(voice, fade);
    return handle;
  }

  stopMusic(fadeSeconds = 0): void {
    if (this.musicVoiceId === null) return;
    this.stopVoice(this.musicVoiceId, fadeSeconds);
    this.musicVoiceId = null;
  }

  /** Every playing and pending voice, dropped in one pass — what Play mode calls on every mode change. */
  stopAll(): void {
    for (const id of [...this.voices.keys()]) this.stopVoice(id, 0);
    this.musicVoiceId = null;
  }

  isPlaying(id: number): boolean {
    const voice = this.voices.get(id);
    return voice !== undefined && !voice.cancelled;
  }

  /** Package-internal: called by `AudioHandle`. */
  stopVoice(id: number, fadeSeconds: number): void {
    const voice = this.voices.get(id);
    if (!voice) return;
    voice.cancelled = true;
    if (id === this.musicVoiceId) this.musicVoiceId = null;

    if (!voice.source) {
      // Still decoding — nothing to stop, and the pending `.then` above checks `cancelled`.
      this.voices.delete(id);
      return;
    }
    const ctx = this.context;
    if (fadeSeconds > 0 && voice.gain && ctx) {
      this.fadeVoiceOut(voice, fadeSeconds);
      const source = voice.source;
      setTimeout(
        () => {
          try {
            source.stop();
          } catch {
            // Already stopped — `onended` beat the timer, which is fine, that's what it's for.
          }
        },
        fadeSeconds * 1000 + 20,
      );
    } else {
      try {
        voice.source.stop();
      } catch {
        // A source that already finished throws on a second `stop()`.
      }
    }
    this.voices.delete(id);
  }

  setVoiceVolume(id: number, volume: number): void {
    const voice = this.voices.get(id);
    if (!voice) return;
    voice.volume = volume;
    if (voice.gain) voice.gain.gain.value = volume;
  }

  setVoicePosition(id: number, position: Vec3): void {
    const voice = this.voices.get(id);
    // `position === null` means the caller asked for a 2D sound, and moving one is meaningless.
    // A voice that is merely still decoding is a different case, and the one that used to be
    // dropped here: a script that plays a footstep and places it in the next statement had its
    // placement thrown away, and heard the sound at wherever the entity stood when `play` ran.
    if (!voice || voice.position === null) return;
    voice.position = [...position];
    if (voice.panner) this.applyPannerPosition(voice.panner, position);
  }

  // --------------------------------------------------------------------- buses

  setBusVolume(bus: AudioBus, volume: number): void {
    this.busVolumes[bus] = volume;
    const gain = this.busGains[bus];
    if (gain) gain.gain.value = volume;
  }

  getBusVolume(bus: AudioBus): number {
    return this.busVolumes[bus];
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = volume;
    if (this.masterGain && !this.muted) this.masterGain.gain.value = volume;
  }

  getMasterVolume(): number {
    return this.masterVolume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain) this.masterGain.gain.value = muted ? 0 : this.masterVolume;
  }

  isMuted(): boolean {
    return this.muted;
  }

  // ------------------------------------------------------------------ readouts

  /**
   * What the mixer shows: voices in flight, clips decoded, and what the context is doing.
   *
   * One call rather than four getters because a panel polling on a timer wants a consistent
   * picture — reading `activeVoices` and `contextState` a frame apart is how a readout comes to
   * say "0 voices, running" about a scene that is audibly playing something.
   */
  snapshot(): AudioSnapshot {
    return {
      /** Pending voices included: one that is still decoding is a sound the session is making. */
      voices: this.voices.size,
      musicPlaying: this.musicVoiceId !== null,
      clipsLoaded: this.buffers.size,
      clipsLoading: this.pendingLoads.size,
      masterVolume: this.masterVolume,
      muted: this.muted,
      busVolumes: { ...this.busVolumes },
      state: this.unavailable
        ? 'unavailable'
        : this.context === null
          ? 'idle'
          : (this.context.state as AudioSnapshot['state']),
    };
  }

  // ------------------------------------------------------------------- listener

  /**
   * Where the player is and which way they are facing, for spatial sounds. `AudioSystem` calls
   * this once a frame from the primary camera's world transform — the same source `RenderHost`
   * renders through, so what you hear matches what you see.
   */
  setListenerTransform(position: Vec3, forward: Vec3, up: Vec3): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const listener = ctx.listener;
    if (listener.positionX) {
      listener.positionX.value = position[0];
      listener.positionY.value = position[1];
      listener.positionZ.value = position[2];
      listener.forwardX.value = forward[0];
      listener.forwardY.value = forward[1];
      listener.forwardZ.value = forward[2];
      listener.upX.value = up[0];
      listener.upY.value = up[1];
      listener.upZ.value = up[2];
    } else {
      // Safari shipped without the AudioParam listener for years; the method form still works.
      listener.setPosition(position[0], position[1], position[2]);
      listener.setOrientation(forward[0], forward[1], forward[2], up[0], up[1], up[2]);
    }
  }

  dispose(): void {
    this.stopAll();
    this.events.clear();
    this.buffers.clear();
    this.pendingLoads.clear();
    if (this.context) void this.context.close().catch(() => {});
    this.context = null;
    this.masterGain = null;
    this.busGains = {};
  }

  // -------------------------------------------------------------------- internals

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    if (this.unavailable) return null;
    try {
      const ctx = this.contextFactory();
      this.context = ctx;
      this.masterGain = ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : this.masterVolume;
      this.masterGain.connect(ctx.destination);
      for (const bus of AUDIO_BUSES) {
        const gain = ctx.createGain();
        gain.gain.value = this.busVolumes[bus];
        gain.connect(this.masterGain);
        this.busGains[bus] = gain;
      }
      return ctx;
    } catch {
      this.unavailable = true;
      return null;
    }
  }

  /**
   * Builds the node graph for a voice and starts it.
   *
   * Reads everything from the voice rather than from the original `PlayOptions`, which is what
   * makes the held values above take effect: by the time a clip has decoded, the volume, the
   * position and the fade may all have been changed by a caller holding the handle, and the
   * options object records only what was true the instant `play` was called.
   */
  private start(voice: Voice, buffer: AudioBuffer): void {
    const ctx = this.ensureContext();
    const busGain = ctx ? this.busGains[voice.bus] : undefined;
    if (!ctx || !busGain) {
      this.voices.delete(voice.id);
      return;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = voice.loop;

    const gain = ctx.createGain();
    gain.gain.value = voice.volume;

    let panner: PannerNode | null = null;
    if (voice.position) {
      panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = voice.spatial.refDistance ?? 1;
      panner.maxDistance = Math.max(panner.refDistance, voice.spatial.maxDistance ?? 40);
      panner.rolloffFactor = voice.spatial.rolloffFactor ?? 1;
      this.applyPannerPosition(panner, voice.position);
      source.connect(gain);
      gain.connect(panner);
      panner.connect(busGain);
    } else {
      source.connect(gain);
      gain.connect(busGain);
    }

    voice.source = source;
    voice.gain = gain;
    voice.panner = panner;

    source.onended = () => {
      // A looping source never ends on its own; this only fires for a one-shot finishing, or a
      // loop that was stopped and already removed itself from `voices` in `stopVoice`.
      if (this.voices.get(voice.id) === voice) this.voices.delete(voice.id);
    };

    // Scheduled before the source runs, so the ramp starts from silence rather than from
    // whatever fraction of the fade had already played by the time it was applied.
    if (voice.fadeIn > 0) this.fadeVoiceIn(voice, voice.fadeIn);
    source.start();
  }

  /**
   * Asks a voice to come up from silence over `seconds`, whether or not it has started yet.
   *
   * The pending half is the point: a voice that is still decoding records the request and
   * honours it in `start`, which is the difference between a crossfade that works and one that
   * works on the second try.
   */
  private requestFadeIn(voice: Voice, seconds: number): void {
    voice.fadeIn = seconds;
    if (voice.gain) this.fadeVoiceIn(voice, seconds);
  }

  private applyPannerPosition(panner: PannerNode, position: Vec3): void {
    if (panner.positionX) {
      panner.positionX.value = position[0];
      panner.positionY.value = position[1];
      panner.positionZ.value = position[2];
    } else {
      panner.setPosition(position[0], position[1], position[2]);
    }
  }

  private fadeVoiceIn(voice: Voice, seconds: number): void {
    const ctx = this.context;
    if (!ctx || !voice.gain) return;
    const target = voice.volume;
    voice.gain.gain.setValueAtTime(0, ctx.currentTime);
    voice.gain.gain.linearRampToValueAtTime(target, ctx.currentTime + seconds);
  }

  private fadeVoiceOut(voice: Voice, seconds: number): void {
    const ctx = this.context;
    if (!ctx || !voice.gain) return;
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, ctx.currentTime);
    voice.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + seconds);
  }
}
