import type * as THREE from 'three';

export interface FrameSample {
  /** Wall clock between successive frames, milliseconds. Includes waiting on the GPU. */
  frameMs: number;
  /** JavaScript time for the whole frame: systems, scripts, and draw-call submission. */
  jsMs: number;
  /** JavaScript time inside the render calls alone — draw-call submission overhead. */
  submitMs: number;
}

/** One named slice of the frame — a system, or anything else worth bracketing. */
export interface SectionReport {
  name: string;
  medianMs: number;
  /** Worst single frame this section has cost inside the window. */
  worstMs: number;
  /** Share of the median frame this section accounts for, 0..1. */
  share: number;
}

export interface FrameReport {
  /** Frames per second implied by the median frame. What the counter shows. */
  fps: number;
  /** Frames per second implied by the mean. Above `fps` when the run is spiky. */
  averageFps: number;
  /** Implied by the single worst frame in the window — the floor, not a trend. */
  minFps: number;
  /**
   * The average of the slowest 1% of frames, as fps.
   *
   * The number benchmarkers reach for, and the right one: a run at "60 fps" whose worst 1% is
   * 22 fps stutters visibly several times a second, and no average will ever say so. This is
   * the difference between a build that measures well and a build that feels good.
   */
  low1Fps: number;
  /** Same for the slowest 0.1% — one frame in a thousand, where the true hitches live. */
  low01Fps: number;
  /** Median frame time. What the frame "usually" costs. */
  medianMs: number;
  /**
   * 95th-percentile frame time. This is the number that matters: a run that averages 60fps
   * but spikes every second feels broken, and a mean hides that completely.
   */
  p95Ms: number;
  /** 99th percentile — where a stutter that happens "occasionally" actually shows up. */
  p99Ms: number;
  worstMs: number;
  bestMs: number;
  medianJsMs: number;
  medianSubmitMs: number;
  /** Share of the frame spent in JavaScript, 0..1. */
  jsShare: number;
  /**
   * Frames markedly slower than the median — the ones that read as a hitch.
   *
   * "Markedly" is twice the median or eight milliseconds over it, whichever is larger. The
   * absolute floor matters: at 144 Hz twice the median is 14 ms, which nobody notices, and
   * without the floor a fast machine would report constant stutter.
   */
  stutterCount: number;
  /** Stutters as a fraction of the window, 0..1. */
  stutterShare: number;
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
  /** Frames recorded since the last reset, whether or not they are still in the window. */
  totalFrames: number;
  /** Per-system timing, worst first. Empty until something calls `beginSection`. */
  sections: SectionReport[];
  /** Recent frame times, oldest first — what the graph plots. */
  history: number[];
}

const DEFAULT_WINDOW = 120;
/** Above this share of the frame spent in JS, the CPU is the thing to fix. */
const CPU_BOUND_SHARE = 0.7;
/** Below this, the frame is mostly spent waiting on the GPU. */
const GPU_BOUND_SHARE = 0.4;
/** Frames faster than this are near enough to a vsync cap that the split is not informative. */
const VERDICT_THRESHOLD_MS = 18;
/** A frame has to be at least this much slower than the median before it counts as a hitch. */
const STUTTER_FLOOR_MS = 8;

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
 *
 * Since v0.7.5 the JavaScript half is broken down further. `beginSection`/`endSection` bracket
 * each system in the loop, so "11 of the 14 milliseconds are physics" is a fact the panel can
 * state rather than something you bisect by commenting systems out.
 */
export class FrameStats {
  private samples: FrameSample[] = [];
  private frameStart = 0;
  private submitStart = 0;
  private jsMs = 0;
  private submitMs = 0;
  private info: THREE.WebGLRenderer['info'] | null = null;
  private totalFrames = 0;

  /** Milliseconds spent in each named section during the frame being measured. */
  private sectionThisFrame = new Map<string, number>();
  private sectionStart = new Map<string, number>();
  /** Rolling per-section history, the same window length as `samples`. */
  private sectionHistory = new Map<string, number[]>();

  constructor(private readonly windowSize = DEFAULT_WINDOW) {}

  /** Call at the top of the engine tick, before any system runs. */
  beginFrame(): void {
    this.frameStart = now();
    this.submitMs = 0;
    this.sectionThisFrame.clear();
  }

  /** Call once every system has run and rendering is done. */
  endFrame(): void {
    this.jsMs = now() - this.frameStart;
  }

  /** Call immediately before the render passes. */
  beginSubmit(): void {
    this.submitStart = now();
  }

  /** Call immediately after the render passes. */
  endSubmit(renderer?: THREE.WebGLRenderer): void {
    // Accumulated rather than assigned: a frame may render several passes.
    this.submitMs += now() - this.submitStart;
    if (renderer) this.info = renderer.info;
  }

  /**
   * Starts timing a named slice of the frame.
   *
   * Keyed by name rather than pushed onto a stack, because the caller is a `for` loop over
   * systems and a stack would silently mis-attribute if one of them ever nested. Nesting the
   * same name inside itself is the one thing this cannot express, and nothing does it.
   */
  beginSection(name: string): void {
    this.sectionStart.set(name, now());
  }

  endSection(name: string): void {
    const started = this.sectionStart.get(name);
    if (started === undefined) return;
    this.sectionStart.delete(name);
    this.sectionThisFrame.set(name, (this.sectionThisFrame.get(name) ?? 0) + (now() - started));
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
    this.totalFrames += 1;

    // A section that did not run this frame still records a zero, so every history stays the
    // same length as every other and a system that stops running visibly falls to zero rather
    // than holding its last value forever.
    for (const name of this.sectionHistory.keys()) {
      if (!this.sectionThisFrame.has(name)) this.sectionThisFrame.set(name, 0);
    }
    for (const [name, ms] of this.sectionThisFrame) {
      let history = this.sectionHistory.get(name);
      if (!history) {
        history = [];
        this.sectionHistory.set(name, history);
      }
      history.push(ms);
      if (history.length > this.windowSize) history.shift();
    }
  }

  report(): FrameReport {
    if (this.samples.length === 0) return emptyReport(this.totalFrames);

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

    const total = frames.reduce((sum, value) => sum + value, 0);
    const meanMs = total / frames.length;
    const worstMs = frames[frames.length - 1] ?? 0;
    const stutterThreshold = Math.max(medianMs * 2, medianMs + STUTTER_FLOOR_MS);
    const stutterCount = frames.filter((value) => value > stutterThreshold).length;

    return {
      fps: toFps(medianMs),
      averageFps: toFps(meanMs),
      minFps: toFps(worstMs),
      low1Fps: toFps(slowestMean(frames, 0.01)),
      low01Fps: toFps(slowestMean(frames, 0.001)),
      medianMs,
      p95Ms: percentile(frames, 0.95),
      p99Ms: percentile(frames, 0.99),
      worstMs,
      bestMs: frames[0] ?? 0,
      medianJsMs,
      medianSubmitMs: percentile(submit, 0.5),
      jsShare,
      stutterCount,
      stutterShare: stutterCount / frames.length,
      bound,
      drawCalls: this.info?.render.calls ?? 0,
      triangles: this.info?.render.triangles ?? 0,
      programs: this.info?.programs?.length ?? 0,
      geometries: this.info?.memory.geometries ?? 0,
      textures: this.info?.memory.textures ?? 0,
      sampleCount: this.samples.length,
      totalFrames: this.totalFrames,
      sections: this.sectionReports(medianMs),
      history: this.samples.map((s) => s.frameMs),
    };
  }

  /** Drops the window. Call after changing a quality lever so the old regime doesn't linger. */
  reset(): void {
    this.samples = [];
    this.sectionHistory.clear();
    this.sectionThisFrame.clear();
    this.sectionStart.clear();
    this.totalFrames = 0;
  }

  private sectionReports(medianMs: number): SectionReport[] {
    const out: SectionReport[] = [];
    for (const [name, history] of this.sectionHistory) {
      if (history.length === 0) continue;
      const sorted = [...history].sort((a, b) => a - b);
      const median = percentile(sorted, 0.5);
      out.push({
        name,
        medianMs: median,
        worstMs: sorted[sorted.length - 1] ?? 0,
        share: medianMs > 0 ? Math.min(1, median / medianMs) : 0,
      });
    }
    // Worst first: the panel is read top-down, and the expensive system is the answer.
    return out.sort((a, b) => b.medianMs - a.medianMs);
  }
}

/** `sorted` must already be ascending. Nearest-rank, which needs no interpolation. */
export function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

/**
 * Mean of the slowest `fraction` of an ascending set — the "1% low" statistic.
 *
 * Averaged rather than read off as a single percentile, which is the difference between the two
 * numbers people both call "1% low": the percentile is one frame and jumps around, while the
 * mean of the tail is stable enough to compare two builds by.
 */
export function slowestMean(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const count = Math.max(1, Math.floor(sorted.length * fraction));
  let total = 0;
  for (let i = sorted.length - count; i < sorted.length; i += 1) total += sorted[i] ?? 0;
  return total / count;
}

function toFps(frameMs: number): number {
  return frameMs > 0 ? 1000 / frameMs : 0;
}

function emptyReport(totalFrames: number): FrameReport {
  return {
    fps: 0,
    averageFps: 0,
    minFps: 0,
    low1Fps: 0,
    low01Fps: 0,
    medianMs: 0,
    p95Ms: 0,
    p99Ms: 0,
    worstMs: 0,
    bestMs: 0,
    medianJsMs: 0,
    medianSubmitMs: 0,
    jsShare: 0,
    stutterCount: 0,
    stutterShare: 0,
    bound: 'unknown',
    drawCalls: 0,
    triangles: 0,
    programs: 0,
    geometries: 0,
    textures: 0,
    sampleCount: 0,
    totalFrames,
    sections: [],
    history: [],
  };
}

/** `performance` is absent in some hosts the engine is meant to run in; `Date` never is. */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
