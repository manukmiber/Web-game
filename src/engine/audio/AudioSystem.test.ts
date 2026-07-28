import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetStore } from '../assets/AssetStore';
import { createAudioSource, type AudioSourceComponent } from '../components/AudioSource';
import { createCamera } from '../components/Camera';
import { installGameplaySystems } from '../gameplay/systems';
import { Engine } from '../loop/Engine';
import { Scene } from '../scene/Scene';
import { createTransform, type Entity } from '../scene/types';
import { AudioEngine } from './AudioEngine';

/** The same fake Web Audio surface `AudioEngine.test.ts` drives, reused so voices really start. */
class FakeParam {
  value = 0;
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
  stopped = false;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
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
  state: 'running' | 'suspended' = 'running';
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
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function speaker(id: string, position: [number, number, number], overrides = {}): Entity {
  return {
    id,
    name: id,
    parentId: null,
    transform: createTransform(position),
    components: [createAudioSource({ clip: 'clip.mp3', autoplay: true, ...overrides })],
  };
}

describe('AudioSystem', () => {
  let ctx: FakeAudioContext;
  let engine: Engine;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(4),
    })) as unknown as typeof fetch;

    ctx = new FakeAudioContext();
    engine = new Engine(new Scene(), new AssetStore(), new AudioEngine(() => ctx as unknown as AudioContext));
    installGameplaySystems(engine);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('does nothing in edit mode', () => {
    engine.scene.add(speaker('s1', [0, 0, 0]));
    engine.tick(1 / 60);
    expect(ctx.sources).toHaveLength(0);
  });

  it('autoplays a spatial AudioSource once Play starts, panned at its position', async () => {
    engine.scene.add(speaker('s1', [3, 0, 4]));
    engine.setMode('play');
    engine.tick(1 / 60);
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));

    expect(ctx.panners).toHaveLength(1);
    expect(ctx.panners[0]!.positionX.value).toBe(3);
    expect(ctx.panners[0]!.positionZ.value).toBe(4);
  });

  it('does not restart a looping autoplay source every frame', async () => {
    engine.scene.add(speaker('s1', [0, 0, 0], { loop: true }));
    engine.setMode('play');
    for (let i = 0; i < 5; i += 1) engine.tick(1 / 60);
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));

    for (let i = 0; i < 10; i += 1) engine.tick(1 / 60);
    expect(ctx.sources).toHaveLength(1);
  });

  it('a non-spatial source gets no panner', async () => {
    engine.scene.add(speaker('s1', [0, 0, 0], { spatial: false }));
    engine.setMode('play');
    engine.tick(1 / 60);
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));
    expect(ctx.panners).toHaveLength(0);
  });

  it('follows a moving spatial source', async () => {
    const entity = speaker('s1', [0, 0, 0]);
    engine.scene.add(entity);
    engine.setMode('play');
    engine.tick(1 / 60);
    await vi.waitFor(() => expect(ctx.panners).toHaveLength(1));

    entity.transform.position = [10, 0, 0];
    engine.tick(1 / 60);
    expect(ctx.panners[0]!.positionX.value).toBe(10);
  });

  it('stops the voice when the component is disabled', async () => {
    const entity = speaker('s1', [0, 0, 0], { loop: true });
    engine.scene.add(entity);
    engine.setMode('play');
    engine.tick(1 / 60);
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));

    (entity.components[0] as AudioSourceComponent).enabled = false;
    engine.tick(1 / 60);
    expect(ctx.sources[0]!.stopped).toBe(true);
  });

  it('stops the voice when the entity is removed', async () => {
    const entity = speaker('s1', [0, 0, 0], { loop: true });
    engine.scene.add(entity);
    engine.setMode('play');
    engine.tick(1 / 60);
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));

    engine.scene.remove('s1');
    engine.tick(1 / 60);
    expect(ctx.sources[0]!.stopped).toBe(true);
  });

  it('an AudioSource with no clip never plays', () => {
    engine.scene.add(speaker('s1', [0, 0, 0], { clip: '' }));
    engine.setMode('play');
    engine.tick(1 / 60);
    expect(ctx.sources).toHaveLength(0);
  });

  it('stopping Play mode kills every voice it started', async () => {
    engine.scene.add(speaker('s1', [0, 0, 0], { loop: true }));
    engine.setMode('play');
    engine.tick(1 / 60);
    await vi.waitFor(() => expect(ctx.sources).toHaveLength(1));

    engine.setMode('edit');
    expect(ctx.sources[0]!.stopped).toBe(true);
  });

  it('moves the Web Audio listener to the primary camera', () => {
    const cam: Entity = {
      id: 'cam',
      name: 'cam',
      parentId: null,
      transform: createTransform([5, 1, 2]),
      components: [createCamera({ primary: true })],
    };
    engine.scene.add(cam);
    engine.setMode('play');
    engine.tick(1 / 60);

    expect(ctx.listener.positionX.value).toBe(5);
    expect(ctx.listener.positionZ.value).toBe(2);
    // -Z forward, unrotated.
    expect(ctx.listener.forwardZ.value).toBeCloseTo(-1);
  });
});
