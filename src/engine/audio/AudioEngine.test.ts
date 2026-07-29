import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from './AudioEngine';

/**
 * Just enough of the Web Audio API for `AudioEngine` to drive, since `AudioContext` does not
 * exist in Vitest's Node environment. See the design note on `AudioEngine`'s constructor.
 */
class FakeParam {
  value = 0;
  setValueAtTime = vi.fn((value: number) => {
    this.value = value;
  });
  linearRampToValueAtTime = vi.fn((value: number) => {
    this.value = value;
  });
}

class FakeGainNode {
  gain = new FakeParam();
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakePannerNode {
  positionX = new FakeParam();
  positionY = new FakeParam();
  positionZ = new FakeParam();
  panningModel = '';
  distanceModel = '';
  refDistance = 1;
  maxDistance = 40;
  rolloffFactor = 1;
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeBufferSourceNode {
  buffer: unknown = null;
  loop = false;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn(() => {
    this.started = true;
  });
  stop = vi.fn(() => {
    if (this.stopped) throw new Error('already stopped');
    this.stopped = true;
  });
}

class FakeListener {
  positionX = new FakeParam();
  positionY = new FakeParam();
  positionZ = new FakeParam();
  forwardX = new FakeParam();
  forwardY = new FakeParam();
  forwardZ = new FakeParam();
  upX = new FakeParam();
  upY = new FakeParam();
  upZ = new FakeParam();
}

class FakeAudioContext {
  currentTime = 0;
  state: 'running' | 'suspended' | 'closed' = 'running';
  destination = {};
  listener = new FakeListener();
  gains: FakeGainNode[] = [];
  sources: FakeBufferSourceNode[] = [];
  panners: FakePannerNode[] = [];

  createGain(): FakeGainNode {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }

  createBufferSource(): FakeBufferSourceNode {
    const node = new FakeBufferSourceNode();
    this.sources.push(node);
    return node;
  }

  createPanner(): FakePannerNode {
    const node = new FakePannerNode();
    this.panners.push(node);
    return node;
  }

  decodeAudioData(): Promise<{ duration: number }> {
    return Promise.resolve({ duration: 1 });
  }

  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
}

function engineWithFakeContext(): { engine: AudioEngine; ctx: FakeAudioContext } {
  const ctx = new FakeAudioContext();
  const engine = new AudioEngine(() => ctx as unknown as AudioContext);
  return { engine, ctx };
}

describe('AudioEngine', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(4),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('is safe to use with no AudioContext at all', async () => {
    const engine = new AudioEngine(() => {
      throw new Error('no Web Audio here');
    });
    expect(engine.available).toBe(false);
    const handle = engine.play('missing.mp3');
    expect(handle.playing).toBe(false);
    await expect(engine.loadClip('missing.mp3')).resolves.toBe(false);
    engine.setBusVolume('sfx', 0.5); // must not throw
    engine.dispose();
  });

  it('plays a preloaded clip synchronously, wired through its bus', async () => {
    const { engine, ctx } = engineWithFakeContext();
    await engine.loadClip('boom.mp3');
    expect(engine.isLoaded('boom.mp3')).toBe(true);

    const handle = engine.play('boom.mp3', { bus: 'sfx', volume: 0.6 });
    expect(handle.playing).toBe(true);
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]!.started).toBe(true);
    expect(ctx.gains.some((g) => g.gain.value === 0.6)).toBe(true);
  });

  it('starts playback once a clip that was not yet loaded finishes decoding', async () => {
    const { engine, ctx } = engineWithFakeContext();
    const handle = engine.play('lazy.mp3');
    // Not decoded yet — nothing has been asked to start.
    expect(ctx.sources).toHaveLength(0);

    await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));
    expect(handle.playing).toBe(true);
  });

  it('cancels a pending play if stopped before the clip finishes decoding', async () => {
    const { engine, ctx } = engineWithFakeContext();
    const handle = engine.play('lazy.mp3');
    handle.stop();
    expect(handle.playing).toBe(false);

    // Give the in-flight decode a turn; it must not start a source for a cancelled voice.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.sources).toHaveLength(0);
  });

  it('reports a failed fetch through events rather than throwing', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    const { engine } = engineWithFakeContext();
    const errors: string[] = [];
    engine.events.on('loadError', ({ url }) => errors.push(url));

    const ok = await engine.loadClip('gone.mp3');
    expect(ok).toBe(false);
    expect(errors).toEqual(['gone.mp3']);
  });

  it('routes a spatial sound through a panner positioned in world space', async () => {
    const { engine, ctx } = engineWithFakeContext();
    await engine.loadClip('foot.mp3');
    const handle = engine.play('foot.mp3', { position: [1, 2, 3] });
    expect(ctx.panners).toHaveLength(1);
    expect(ctx.panners[0]!.positionX.value).toBe(1);
    expect(ctx.panners[0]!.positionZ.value).toBe(3);

    handle.setPosition([4, 5, 6]);
    expect(ctx.panners[0]!.positionY.value).toBe(5);
  });

  it('a non-spatial sound gets no panner', async () => {
    const { engine, ctx } = engineWithFakeContext();
    await engine.loadClip('ui.mp3');
    engine.play('ui.mp3');
    expect(ctx.panners).toHaveLength(0);
  });

  it('replacing the music track stops the previous one', async () => {
    const { engine, ctx } = engineWithFakeContext();
    await engine.loadClip('a.mp3');
    await engine.loadClip('b.mp3');

    const first = engine.playMusic('a.mp3');
    expect(first.playing).toBe(true);
    const second = engine.playMusic('b.mp3');
    expect(first.playing).toBe(false);
    expect(second.playing).toBe(true);
    expect(ctx.sources[0]!.stopped).toBe(true);
  });

  it('stopAll drops every voice, playing or still pending', async () => {
    const { engine, ctx } = engineWithFakeContext();
    await engine.loadClip('ready.mp3');
    const started = engine.play('ready.mp3');
    const pending = engine.play('never-loaded.mp3');

    engine.stopAll();
    expect(started.playing).toBe(false);
    expect(pending.playing).toBe(false);
    expect(ctx.sources[0]!.stopped).toBe(true);
  });

  it('bus and master volume affect the mixer graph, and mute overrides master', async () => {
    const { engine } = engineWithFakeContext();
    engine.setBusVolume('music', 0.4);
    expect(engine.getBusVolume('music')).toBe(0.4);

    engine.setMasterVolume(0.5);
    expect(engine.getMasterVolume()).toBe(0.5);

    engine.setMuted(true);
    expect(engine.isMuted()).toBe(true);
    engine.setMuted(false);
    expect(engine.isMuted()).toBe(false);
  });

  it('setBusVolume before the context exists is remembered once it is created', () => {
    const { engine, ctx } = engineWithFakeContext();
    engine.setBusVolume('sfx', 0.3);
    // Touch `available` to force lazy context creation.
    expect(engine.available).toBe(true);
    expect(ctx.gains.some((g) => g.gain.value === 0.3)).toBe(true);
  });

  it('resume is a no-op when nothing is suspended', async () => {
    const { engine } = engineWithFakeContext();
    await expect(engine.resume()).resolves.toBeUndefined();
  });

  /**
   * Everything a caller says between `play` returning and the clip decoding has to survive the
   * gap. It did for volume and not for the other two, which made both bugs invisible on any
   * clip that had been played once already — the worst possible failure mode for a fade.
   */
  describe('state held across the decode gap', () => {
    it('crossfades a music track that has never been played before', async () => {
      const { engine, ctx } = engineWithFakeContext();
      engine.playMusic('theme.mp3', { fadeSeconds: 2, volume: 0.8 });

      await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));
      // The fade is a ramp scheduled on the voice's own gain, from silence up to its volume.
      const faded = ctx.gains.find((g) => g.gain.linearRampToValueAtTime.mock.calls.length > 0);
      expect(faded).toBeDefined();
      expect(faded!.gain.setValueAtTime).toHaveBeenCalledWith(0, 0);
      expect(faded!.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.8, 2);
    });

    it('still crossfades on a second play, when the clip is already decoded', async () => {
      const { engine, ctx } = engineWithFakeContext();
      await engine.loadClip('theme.mp3');
      engine.playMusic('theme.mp3', { fadeSeconds: 1.5 });

      const faded = ctx.gains.find((g) => g.gain.linearRampToValueAtTime.mock.calls.length > 0);
      expect(faded!.gain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 1.5);
    });

    it('honours a position set before the clip finishes decoding', async () => {
      const { engine, ctx } = engineWithFakeContext();
      const handle = engine.play('step.mp3', { position: [0, 0, 0] });
      handle.setPosition([4, 1, -2]);

      await vi.waitFor(() => expect(ctx.panners).toHaveLength(1));
      const panner = ctx.panners[0]!;
      expect([panner.positionX.value, panner.positionY.value, panner.positionZ.value]).toEqual([
        4, 1, -2,
      ]);
    });

    it('leaves a 2D sound 2D, however many times it is told to move', async () => {
      const { engine, ctx } = engineWithFakeContext();
      const handle = engine.play('blip.mp3');
      handle.setPosition([9, 9, 9]);

      await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));
      expect(ctx.panners).toHaveLength(0);
    });

    it('holds a volume set before decoding, as it always did', async () => {
      const { engine, ctx } = engineWithFakeContext();
      const handle = engine.play('lazy.mp3');
      handle.setVolume(0.25);

      await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));
      expect(ctx.gains.some((g) => g.gain.value === 0.25)).toBe(true);
    });
  });

  it('reports a snapshot the mixer can render', async () => {
    const { engine } = engineWithFakeContext();
    expect(engine.snapshot().state).toBe('idle');

    await engine.loadClip('theme.mp3');
    engine.playMusic('theme.mp3');
    engine.setBusVolume('ambient', 0.3);
    engine.setMuted(true);

    const snapshot = engine.snapshot();
    expect(snapshot).toMatchObject({
      voices: 1,
      musicPlaying: true,
      clipsLoaded: 1,
      muted: true,
      state: 'running',
    });
    expect(snapshot.busVolumes.ambient).toBe(0.3);
  });

  it('reports unavailable rather than idle when there is no Web Audio', () => {
    const engine = new AudioEngine(() => {
      throw new Error('no Web Audio here');
    });
    expect(engine.available).toBe(false);
    expect(engine.snapshot().state).toBe('unavailable');
  });
});
