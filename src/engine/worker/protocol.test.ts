import { describe, expect, it } from 'vitest';
import { CHANNEL, parseHostMessage, parseWorkerMessage, type FrameMessage } from './protocol';

function validFrame(): FrameMessage {
  return {
    channel: CHANNEL,
    type: 'frame',
    seq: 1,
    transforms: [{ id: 'e1', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }],
    ops: [{ op: 'rename', id: 'e1', name: 'Box' }],
    console: [{ level: 'log', text: 'hi', entityId: 'e1', source: 'Script', at: 1 }],
    audio: [{ method: 'play', voiceId: 1, args: ['sfx.mp3', {}] }],
    game: { actors: [], vars: [] },
    clock: { paused: false, timeScale: 1 },
    diagnostics: { bodies: 0, steps: 1, throttled: false, scriptInstances: 0, scriptTimers: 0 },
  };
}

describe('parseWorkerMessage', () => {
  it('accepts a well-formed frame', () => {
    expect(parseWorkerMessage(validFrame())).toEqual(validFrame());
  });

  it('rejects a message on the wrong channel', () => {
    expect(parseWorkerMessage({ ...validFrame(), channel: 'something-else' })).toBeNull();
  });

  it('rejects an unknown message type — a forged message from a script that reached postMessage', () => {
    expect(parseWorkerMessage({ channel: CHANNEL, type: 'evil', seq: 1 })).toBeNull();
  });

  it('rejects non-object payloads outright', () => {
    expect(parseWorkerMessage(null)).toBeNull();
    expect(parseWorkerMessage('frame')).toBeNull();
    expect(parseWorkerMessage(42)).toBeNull();
  });

  it('drops individually malformed ops/console/audio entries without discarding the frame', () => {
    const frame = validFrame();
    const parsed = parseWorkerMessage({
      ...frame,
      ops: [...frame.ops, { op: 'add' /* missing entity */ }, { op: 'not-a-real-op' }],
      console: [...frame.console, { level: 'catastrophic', text: 'nope' }],
      audio: [...frame.audio, { method: 'deleteEverything', args: [] }],
    });
    expect(parsed).not.toBeNull();
    if (parsed?.type !== 'frame') throw new Error('expected a frame message');
    expect(parsed.transforms).toEqual(frame.transforms);
    expect(parsed.ops).toEqual(frame.ops);
    expect(parsed.console).toEqual(frame.console);
    expect(parsed.audio).toEqual(frame.audio);
  });

  it('rejects a frame missing required scalar fields', () => {
    const frame = validFrame() as unknown as Record<string, unknown>;
    delete frame.seq;
    expect(parseWorkerMessage(frame)).toBeNull();
  });

  it('accepts a fatal message and rejects a malformed one', () => {
    expect(parseWorkerMessage({ channel: CHANNEL, type: 'fatal', message: 'boom' })).toEqual({
      channel: CHANNEL,
      type: 'fatal',
      message: 'boom',
    });
    expect(parseWorkerMessage({ channel: CHANNEL, type: 'fatal' })).toBeNull();
  });
});

describe('parseHostMessage', () => {
  it('accepts a well-formed init message', () => {
    const message = {
      channel: CHANNEL,
      type: 'init' as const,
      scene: { name: 'Scene', world: { chunkSize: 256 }, entities: [], assets: [] },
      game: { actors: [], vars: [] },
    };
    expect(parseHostMessage(message)).toEqual(message);
  });

  it('accepts a well-formed input message', () => {
    const message = {
      channel: CHANNEL,
      type: 'input' as const,
      input: {
        down: ['KeyW'],
        axes: [['move', 1]] as [string, number][],
        pointerX: 0,
        pointerY: 0,
        pointerDeltaX: 0,
        pointerDeltaY: 0,
        wheelDelta: 0,
        buttons: 0,
      },
      clock: { paused: false, timeScale: 1 },
    };
    expect(parseHostMessage(message)).toEqual(message);
  });

  it('rejects an init message whose scene entities are malformed', () => {
    const message = {
      channel: CHANNEL,
      type: 'init',
      scene: { name: 'Scene', world: { chunkSize: 256 }, entities: [{ id: 'e1' }], assets: [] },
      game: { actors: [], vars: [] },
    };
    expect(parseHostMessage(message)).toBeNull();
  });

  it('rejects a message on the wrong channel', () => {
    expect(parseHostMessage({ channel: 'other', type: 'init' })).toBeNull();
  });
});
