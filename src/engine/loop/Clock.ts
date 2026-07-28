/** Guards against a huge dt after a tab has been backgrounded or a devtools breakpoint releases. */
export const MAX_FRAME_DELTA = 0.1;

export interface ClockOptions {
  /**
   * Exponential smoothing factor for `smoothDelta`, from 0 (no smoothing) up to just under 1.
   * Default 0. `tick()`'s return value — what systems actually simulate with — is never
   * smoothed; smoothing softens jitter for things like a camera, not the physics that must
   * stay faithful to real elapsed time.
   */
  smoothing?: number;
  /** Hard ceiling on a single frame's delta, in seconds. Default `MAX_FRAME_DELTA`. */
  maxDelta?: number;
}

/**
 * Turns raw `requestAnimationFrame` timestamps into a dt the rest of the engine can trust.
 *
 * Pulled out of `Engine.start()`, which used to do all of this inline as one clamped
 * subtraction, because three more cases kept wanting the same timestamp: pausing without the
 * resume frame reporting the entire paused interval as one dt spike, a time scale for slow
 * motion, and a smoothed reading for consumers that would rather not see frame-to-frame jitter.
 * None of that is right to reimplement per system, and none of it is testable through
 * `requestAnimationFrame`, so it lives here as a plain function of timestamps in and dt out.
 */
export class Clock {
  private lastTime = 0;
  private started = false;
  private paused = false;
  private smoothed = 0;
  private readonly maxDelta: number;
  private readonly smoothing: number;
  /** Multiplies every non-paused dt. 1 = real time, 0.5 = half speed. Does not affect `isPaused`. */
  timeScale = 1;

  constructor(options: ClockOptions = {}) {
    this.maxDelta = options.maxDelta ?? MAX_FRAME_DELTA;
    this.smoothing = options.smoothing ?? 0;
  }

  /** Anchors the clock to a timestamp with no elapsed time yet — call before the first `tick`. */
  reset(nowMs: number): void {
    this.lastTime = nowMs;
    this.started = true;
    this.smoothed = 0;
  }

  pause(): void {
    this.paused = true;
  }

  /** Resumes and re-anchors to `nowMs`, so the paused interval never appears in a dt. */
  resume(nowMs: number): void {
    this.paused = false;
    this.lastTime = nowMs;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Feeds a new timestamp (ms, as from `requestAnimationFrame`/`performance.now`) and returns
   * this frame's dt in seconds — clamped, time-scaled, and zero while paused.
   */
  tick(nowMs: number): number {
    if (!this.started) this.reset(nowMs);
    // Never negative: a duplicate or out-of-order timestamp reports zero elapsed time rather
    // than running the frame backwards.
    const raw = Math.max((nowMs - this.lastTime) / 1000, 0);
    this.lastTime = nowMs;
    if (this.paused) return 0;
    const dt = Math.min(raw, this.maxDelta) * this.timeScale;
    this.smoothed =
      this.smoothing <= 0 || this.smoothed === 0
        ? dt
        : this.smoothed + (dt - this.smoothed) * (1 - this.smoothing);
    return dt;
  }

  /** The smoothed reading from the last `tick`, for consumers that want jitter filtered out. */
  get smoothDelta(): number {
    return this.smoothed;
  }
}
