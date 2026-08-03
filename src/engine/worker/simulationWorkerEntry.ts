/**
 * Runs inside the simulation Worker itself — the file `SimulationHost` points `new Worker(...)`
 * at. Everything that can be tested without a real Worker lives in `SimulationEngine`; this file
 * is deliberately thin wiring around it, because the one thing it does that cannot be unit
 * tested (talk to a real global scope) is also the one thing worth keeping as small as possible.
 *
 * A locally-scoped `declare const self` shadows the ambient one for this file only, rather than
 * adding `"webworker"` to `tsconfig.json`'s `lib`. The rest of the project targets `"DOM"`, and
 * `webworker` declares an incompatible shape for the same global names (`self`, `postMessage`,
 * `close`) — the two cannot both apply program-wide. Stating exactly the handful of worker calls
 * this file makes avoids the conflict entirely.
 */
import { CHANNEL, parseHostMessage } from './protocol';
import { SimulationEngine } from './SimulationEngine';

declare const self: {
  postMessage(data: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  requestAnimationFrame: (callback: (time: number) => void) => number;
  cancelAnimationFrame: (handle: number) => void;
};

/**
 * `Engine.start()` (unmodified — see `loop/Engine.ts`) drives itself with
 * `requestAnimationFrame`, the one piece of the frame loop ARCHITECTURE.md §9.5 already called
 * out as inherently main-thread: not because the *work* can't move, but because the clock that
 * ticks it has no Worker equivalent. A Worker has no display to sync a frame to, so there is
 * nothing to be faithful to here — a fixed ~60 Hz timer is what "as fast as the main thread
 * would ask for a frame" means without one. Polyfilling the two functions, rather than teaching
 * `Engine` a second driving mechanism, is what lets `SimulationEngine` reuse
 * `start`/`stop`/`pause`/`setTimeScale` completely unchanged — a script's `time.scale = 0.2`
 * works exactly as it does on the main thread, because it is running the same code.
 */
const FRAME_INTERVAL_MS = 1000 / 60;
const pendingFrames = new Map<number, ReturnType<typeof setTimeout>>();
let nextFrameHandle = 1;

self.requestAnimationFrame = (callback) => {
  const handle = nextFrameHandle++;
  pendingFrames.set(
    handle,
    setTimeout(() => {
      pendingFrames.delete(handle);
      callback(performance.now());
    }, FRAME_INTERVAL_MS),
  );
  return handle;
};

self.cancelAnimationFrame = (handle) => {
  const timer = pendingFrames.get(handle);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingFrames.delete(handle);
};

const sim = new SimulationEngine();
sim.onFrame((message) => self.postMessage(message));

self.addEventListener('message', (event) => {
  const message = parseHostMessage(event.data);
  if (!message) return;
  if (message.type === 'init') {
    sim.init(message.scene, message.game);
    sim.engine.start();
    return;
  }
  sim.applyInput(message.input, message.clock);
});

// An error that escaped every guard already inside `ScriptSystem`/`PhysicsSystem` should not
// happen — but it is reported rather than left to surface only as the host's watchdog timing
// out several seconds later with no explanation.
self.addEventListener('error', (event) => {
  self.postMessage({ channel: CHANNEL, type: 'fatal', message: event.message });
});
