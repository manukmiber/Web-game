import type * as THREE from 'three';

export interface FrameSample {
  /** Wall clock between successive frames, milliseconds. Includes waiting on the GPU. */
  frameMs: number;
  /** JavaScript time for the whole frame: systems, scripts, and draw-call submission. */
  jsMs: number;
  /** JavaScript time inside the render calls alone — draw-call submission overhead. */
  submitMs: number;
}

export interface FrameReport {
  fps: number;
  /** Median frame time. What the frame "usually" costs. */
  medianMs: number;
  /**
   * 95th-percentile frame time. This is the number that matters: a run that averages 60fps
   * but spikes every second feels broken, and a mean hides that completely.
   */
  p95Ms: number;
  worstMs: number;
  medianJsMs: number;
  medianSubmitMs: number;
  /** Share of the frame spent in JavaScript, 0..1. */
  jsShare: number;
  /**
   * Rough verdict on where the time goes. `unknown` while frames are comfortably fast, since
   * a frame capped by vsync tells you nothing about headroom.
   */
  bound: 'cpu' | 'gpu' | 'unknown';
  drawCalls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
  sampleCount: number;
}

const DEFAULT_WINDOW = 120;
/** Above this share of the frame spent in JS, the CPU is the thing to fix. */
const CPU_BOUND_SHARE = 0.7;
/** Below this, the frame is mostly spent waiting on the GPU. */
const GPU_BOUND_SHARE = 0.4;
/** Frames faster than this are near enough to a vsync cap that the split is not informative. */
const VERDICT_THRESHOLD_MS = 18;

/**
 * Rolling frame-time measurement.
 *
 * An important limitation to be explicit about: **there is no synchronous way to measure GPU
 * time from JavaScript.** `renderer.render()` queues commands and returns; the GPU work
 * happens afterwards. So `submitMs` is the CPU cost of issuing draw calls — which is a real
 * and often dominant cost in Three.js — and *not* how long the GPU took.
 *
 * What is measurable is the whole frame (wall clock) and the JavaScript within it. The ratio
 * between them is the useful signal: if nearly all of a slow frame is JavaScript, the fix is
 * on the CPU; if most of it is unaccounted for, the frame is waiting on the GPU and the fix
 * is fill rate, overdraw or shader cost. That is what `bound` reports.
 */
export class FrameStats {
  private samples: FrameSample[] = [];
  private frameStart = 0;
  private submitStart = 0;
  private jsMs = 0;
  private submitMs = 0;
  private info: THREE.WebGLRenderer['info'] | null = null;

  constructor(private readonly windowSize = DEFAULT_WINDOW) {}

  /** Call at the top of the engine tick, before any system runs. */
  beginFrame(): void {
    this.frameStart = performance.now();
    this.submitMs = 0;
  }

  /** Call once every system has run and rendering is done. */
  endFrame(): void {
    this.jsMs = performance.now() - this.frameStart;
  }

  /** Call immediately before the render passes. */
  beginSubmit(): void {
    this.submitStart = performance.now();
  }

  /** Call immediately after the render passes. */
  endSubmit(renderer?: THREE.WebGLRenderer): void {
    // Accumulated rather than assigned: a frame may render several passes.
    this.submitMs += performance.now() - this.submitStart;
    if (renderer) this.info = renderer.info;
  }

  /**
   * Records the frame, given the loop's delta in seconds.
   *
   * Frames longer than a second are dropped: they are almost always a backgrounded tab or a
   * devtools pause, and one 4000ms sample poisons the p95 for the rest of the window.
   */
  record(dt: number): void {
    const frameMs = dt * 1000;
    if (frameMs > 1000) return;
    this.samples.push({ frameMs, jsMs: this.jsMs, submitMs: this.submitMs });
    if (this.samples.length > this.windowSize) this.samples.shift();
  }

  report(): FrameReport {
    if (this.samples.length === 0) {
      return {
        fps: 0,
        medianMs: 0,
        p95Ms: 0,
        worstMs: 0,
        medianJsMs: 0,
        medianSubmitMs: 0,
        jsShare: 0,
        bound: 'unknown',
        drawCalls: 0,
        triangles: 0,
        programs: 0,
        geometries: 0,
        textures: 0,
        sampleCount: 0,
      };
    }

    const frames = this.samples.map((s) => s.frameMs).sort((a, b) => a - b);
    const js = this.samples.map((s) => s.jsMs).sort((a, b) => a - b);
    const submit = this.samples.map((s) => s.submitMs).sort((a, b) => a - b);

    const medianMs = percentile(frames, 0.5);
    const medianJsMs = percentile(js, 0.5);
    const jsShare = medianMs > 0 ? Math.min(1, medianJsMs / medianMs) : 0;

    let bound: FrameReport['bound'] = 'unknown';
    if (medianMs > VERDICT_THRESHOLD_MS) {
      if (jsShare >= CPU_BOUND_SHARE) bound = 'cpu';
      else if (jsShare <= GPU_BOUND_SHARE) bound = 'gpu';
    }

    return {
      fps: medianMs > 0 ? 1000 / medianMs : 0,
      medianMs,
      p95Ms: percentile(frames, 0.95),
      worstMs: frames[frames.length - 1] ?? 0,
      medianJsMs,
      medianSubmitMs: percentile(submit, 0.5),
      jsShare,
      bound,
      drawCalls: this.info?.render.calls ?? 0,
      triangles: this.info?.render.triangles ?? 0,
      programs: this.info?.programs?.length ?? 0,
      geometries: this.info?.memory.geometries ?? 0,
      textures: this.info?.memory.textures ?? 0,
      sampleCount: this.samples.length,
    };
  }

  /** Drops the window. Call after changing a quality lever so the old regime doesn't linger. */
  reset(): void {
    this.samples = [];
  }
}

/** `sorted` must already be ascending. Nearest-rank, which needs no interpolation. */
export function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}
