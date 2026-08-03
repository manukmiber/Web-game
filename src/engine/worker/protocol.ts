/**
 * The wire format between the host (editor or runtime, main thread) and the simulation Worker.
 *
 * Everything here is plain, structured-cloneable data — no class instances, no functions — the
 * same discipline `Scene`/`Entity`/`Component` already keep (ARCHITECTURE.md §3). That is what
 * lets a message be validated by shape alone before anything in it is trusted.
 *
 * **Why the host validates instead of trusting the worker.** A script's sandbox is a guard
 * rail, not a security boundary (`scripting/sandbox.ts`): `({}).constructor.constructor` still
 * rebuilds `Function` from nothing, and from there a script can reach the Worker's own global
 * scope and call its *real* `postMessage` directly, bypassing this module's wrapper entirely.
 * Moving execution into a Worker does not stop that — nothing in JavaScript can. What it does
 * change is what forging a message can *reach*: the Worker's global has no `document`, no
 * `window`, no cookies, no `localStorage`, categorically (not merely shadowed, as on the main
 * thread) — so a forged message can at worst confuse this protocol, not touch the page. Every
 * inbound message is therefore checked against this shape before a single field of it is
 * applied to the live scene, and anything that fails is dropped rather than guessed at.
 */

import type { GameStateSnapshot } from '../gameplay/GameState';
import type { InputSnapshot } from '../input/InputState';
import type { SceneSnapshot } from '../loop/Engine';
import type { Component, Entity, EntityId, Vec3 } from '../scene/types';
import type { ScriptMessage } from '../scripting/ScriptSystem';

/** Namespaces every message so a stray `postMessage` (a test, another library, a forged one
 * from a script that reached the Worker's true global) is ignored rather than misparsed as
 * simulation traffic. Bumped whenever the shape below changes incompatibly. */
export const CHANNEL = 'websim-v1';

// --------------------------------------------------------------------- scene mirroring

export type SceneOp =
  | { op: 'add'; entity: Entity }
  | { op: 'remove'; id: EntityId; removedIds: EntityId[] }
  | { op: 'rename'; id: EntityId; name: string }
  | { op: 'reparent'; id: EntityId; parentId: EntityId | null }
  /** Full replacement of one entity's component array — see `sceneMirror.ts` for why a diff isn't worth it. */
  | { op: 'components'; id: EntityId; components: Component[] }
  | { op: 'asset'; asset: { id: string; type: 'texture'; name: string; src: string } };

export interface TransformUpdate {
  id: EntityId;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

/** One call a script made against `audio`, recorded by `RelayAudioEngine` for the host to replay. */
export interface AudioCommand {
  method:
    | 'play'
    | 'playMusic'
    | 'stopMusic'
    | 'stopAll'
    | 'stopVoice'
    | 'setVoiceVolume'
    | 'setVoicePosition'
    | 'setBusVolume'
    | 'setMasterVolume'
    | 'setMuted';
  /** The relay's own voice id, so a later `stopVoice`/`setVoiceVolume` resolves to the same
   * real `AudioHandle` the host created for the matching earlier `play`. Null for bus/master
   * calls, which have no voice. */
  voiceId: number | null;
  args: unknown[];
}

export interface ClockState {
  paused: boolean;
  timeScale: number;
}

export interface SimDiagnostics {
  bodies: number;
  steps: number;
  throttled: boolean;
  scriptInstances: number;
  scriptTimers: number;
}

// --------------------------------------------------------------------- host -> worker

export interface InitMessage {
  channel: typeof CHANNEL;
  type: 'init';
  scene: SceneSnapshot;
  game: GameStateSnapshot;
}

export interface InputMessage {
  channel: typeof CHANNEL;
  type: 'input';
  input: InputSnapshot;
  clock: ClockState;
}

export type HostMessage = InitMessage | InputMessage;

// --------------------------------------------------------------------- worker -> host

export interface FrameMessage {
  channel: typeof CHANNEL;
  type: 'frame';
  /** Monotonic per worker instance. Lets the host tell a stale message (from a worker it has
   * since replaced after a watchdog restart) from a current one. */
  seq: number;
  transforms: TransformUpdate[];
  ops: SceneOp[];
  console: ScriptMessage[];
  audio: AudioCommand[];
  game: GameStateSnapshot;
  clock: ClockState;
  diagnostics: SimDiagnostics;
}

/** An error that escaped the worker's own guarded tick loop — should not normally happen,
 * since `ScriptSystem`/`PhysicsSystem` already contain their own failures, but reported rather
 * than left to surface only as a silent stall. */
export interface FatalMessage {
  channel: typeof CHANNEL;
  type: 'fatal';
  message: string;
}

export type WorkerMessage = FrameMessage | FatalMessage;

// --------------------------------------------------------------------- validation

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isVec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number');
}

function isEntityIdArray(value: unknown): value is EntityId[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isClockState(value: unknown): value is ClockState {
  return (
    isRecord(value) &&
    typeof value.paused === 'boolean' &&
    typeof value.timeScale === 'number' &&
    Number.isFinite(value.timeScale)
  );
}

function isEntity(value: unknown): value is Entity {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || typeof value.name !== 'string') return false;
  if (value.parentId !== null && typeof value.parentId !== 'string') return false;
  if (!Array.isArray(value.components)) return false;
  if (!value.components.every((c) => isRecord(c) && typeof c.type === 'string')) return false;
  const transform = value.transform;
  if (!isRecord(transform)) return false;
  return (
    isVec3(transform.position) && isVec3(transform.rotation) && isVec3(transform.scale)
  );
}

function isSceneOp(value: unknown): value is SceneOp {
  if (!isRecord(value) || typeof value.op !== 'string') return false;
  switch (value.op) {
    case 'add':
      return isEntity(value.entity);
    case 'remove':
      return typeof value.id === 'string' && isEntityIdArray(value.removedIds);
    case 'rename':
      return typeof value.id === 'string' && typeof value.name === 'string';
    case 'reparent':
      return (
        typeof value.id === 'string' &&
        (value.parentId === null || typeof value.parentId === 'string')
      );
    case 'components':
      return (
        typeof value.id === 'string' &&
        Array.isArray(value.components) &&
        value.components.every((c) => isRecord(c) && typeof c.type === 'string')
      );
    case 'asset': {
      const asset = value.asset;
      return (
        isRecord(asset) &&
        typeof asset.id === 'string' &&
        asset.type === 'texture' &&
        typeof asset.name === 'string' &&
        typeof asset.src === 'string'
      );
    }
    default:
      return false;
  }
}

function isTransformUpdate(value: unknown): value is TransformUpdate {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isVec3(value.position) &&
    isVec3(value.rotation) &&
    isVec3(value.scale)
  );
}

function isScriptMessage(value: unknown): value is ScriptMessage {
  return (
    isRecord(value) &&
    (value.level === 'log' || value.level === 'warn' || value.level === 'error') &&
    typeof value.text === 'string' &&
    (value.entityId === null || typeof value.entityId === 'string') &&
    typeof value.source === 'string' &&
    typeof value.at === 'number'
  );
}

const AUDIO_METHODS = new Set<AudioCommand['method']>([
  'play',
  'playMusic',
  'stopMusic',
  'stopAll',
  'stopVoice',
  'setVoiceVolume',
  'setVoicePosition',
  'setBusVolume',
  'setMasterVolume',
  'setMuted',
]);

function isAudioCommand(value: unknown): value is AudioCommand {
  return (
    isRecord(value) &&
    typeof value.method === 'string' &&
    AUDIO_METHODS.has(value.method as AudioCommand['method']) &&
    (value.voiceId === null || typeof value.voiceId === 'number') &&
    Array.isArray(value.args)
  );
}

function isGameStateSnapshot(value: unknown): value is GameStateSnapshot {
  if (!isRecord(value) || !Array.isArray(value.actors) || !Array.isArray(value.vars)) return false;
  // Each entry has to actually be the `[key, value]` pair `GameState.replace` destructures —
  // an unchecked element here (an object, a bare number) throws inside that destructure with
  // nothing upstream to catch it, which is exactly the kind of gap this validator exists to
  // close before `game` is trusted at all.
  if (!value.vars.every((v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string')) {
    return false;
  }
  return value.actors.every(
    (a) =>
      isRecord(a) &&
      typeof a.id === 'string' &&
      typeof a.faction === 'string' &&
      typeof a.health === 'number' &&
      typeof a.maxHealth === 'number' &&
      typeof a.alive === 'boolean',
  );
}

function isDiagnostics(value: unknown): value is SimDiagnostics {
  return (
    isRecord(value) &&
    typeof value.bodies === 'number' &&
    typeof value.steps === 'number' &&
    typeof value.throttled === 'boolean' &&
    typeof value.scriptInstances === 'number' &&
    typeof value.scriptTimers === 'number'
  );
}

/**
 * Validates and narrows an incoming worker->host message. Returns `null` for anything that
 * does not match the protocol exactly — a wrong `channel`, an unknown `type`, a missing or
 * mistyped field — rather than throwing, so one bad message cannot take down the bridge that
 * is, among other things, the thing meant to survive a bad script.
 *
 * Malformed *elements* inside `ops`/`console`/`audio` are dropped individually rather than
 * failing the whole frame: a script tripping validation on one queued command should not also
 * discard this frame's transform updates.
 */
export function parseWorkerMessage(data: unknown): WorkerMessage | null {
  if (!isRecord(data) || data.channel !== CHANNEL) return null;
  if (data.type === 'fatal') {
    return typeof data.message === 'string' ? { channel: CHANNEL, type: 'fatal', message: data.message } : null;
  }
  if (data.type !== 'frame') return null;
  if (typeof data.seq !== 'number') return null;
  if (!Array.isArray(data.transforms) || !Array.isArray(data.ops)) return null;
  if (!Array.isArray(data.console) || !Array.isArray(data.audio)) return null;
  if (!isGameStateSnapshot(data.game) || !isClockState(data.clock) || !isDiagnostics(data.diagnostics)) {
    return null;
  }

  return {
    channel: CHANNEL,
    type: 'frame',
    seq: data.seq,
    transforms: data.transforms.filter(isTransformUpdate),
    ops: data.ops.filter(isSceneOp),
    console: data.console.filter(isScriptMessage),
    audio: data.audio.filter(isAudioCommand),
    game: data.game,
    clock: data.clock,
    diagnostics: data.diagnostics,
  };
}

/** The worker's side of the same check, against messages the host sends it. */
export function parseHostMessage(data: unknown): HostMessage | null {
  if (!isRecord(data) || data.channel !== CHANNEL) return null;
  if (data.type === 'init') {
    if (!isRecord(data.scene) || !Array.isArray(data.scene.entities)) return null;
    if (typeof data.scene.name !== 'string' || !isRecord(data.scene.world)) return null;
    if (!Array.isArray(data.scene.assets)) return null;
    if (!data.scene.entities.every(isEntity)) return null;
    if (!isGameStateSnapshot(data.game)) return null;
    return {
      channel: CHANNEL,
      type: 'init',
      scene: data.scene as unknown as SceneSnapshot,
      game: data.game,
    };
  }
  if (data.type === 'input') {
    const input = data.input;
    if (
      !isRecord(input) ||
      !isEntityIdArray(input.down) ||
      !Array.isArray(input.axes) ||
      typeof input.pointerX !== 'number' ||
      typeof input.pointerY !== 'number' ||
      typeof input.pointerDeltaX !== 'number' ||
      typeof input.pointerDeltaY !== 'number' ||
      typeof input.wheelDelta !== 'number' ||
      typeof input.buttons !== 'number'
    ) {
      return null;
    }
    if (!isClockState(data.clock)) return null;
    return {
      channel: CHANNEL,
      type: 'input',
      input: input as unknown as InputSnapshot,
      clock: data.clock,
    };
  }
  return null;
}
