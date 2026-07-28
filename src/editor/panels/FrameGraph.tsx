/**
 * The frame-time history, drawn as a bar per frame.
 *
 * A graph rather than more numbers, because the shape of a frame-time trace is the information:
 * a flat line at 16 ms, a sawtooth, and a flat line with one spike every second all produce
 * similar medians and feel completely different to play. Percentiles summarise that shape;
 * seeing it is faster.
 *
 * Inline SVG rather than a canvas. It is a hundred rectangles refreshed four times a second, so
 * the DOM cost is nothing, and it inherits the theme's colours instead of hard-coding them in
 * fill styles — which matters because this sits in a dock beside panels that already match.
 */

interface Props {
  /** Frame times in milliseconds, oldest first. */
  history: readonly number[];
  /** The budget line, in milliseconds. Frames above it are drawn as over budget. */
  budgetMs?: number;
  height?: number;
}

/** 60 fps. The line everything is drawn relative to. */
const DEFAULT_BUDGET_MS = 1000 / 60;

/** Ceiling of the vertical axis, so one 400 ms hitch does not flatten everything else to zero. */
const MAX_SCALE_MS = 100;

export function FrameGraph({ history, budgetMs = DEFAULT_BUDGET_MS, height = 48 }: Props) {
  if (history.length === 0) {
    return <div className="frame-graph empty">No frames measured yet.</div>;
  }

  // Scaled to the worst frame in the window, floored at twice the budget so a comfortable run
  // does not look alarming and clamped so a single stall stays readable.
  const worst = Math.max(...history);
  const scale = Math.min(MAX_SCALE_MS, Math.max(budgetMs * 2, worst));
  const width = history.length;
  const budgetY = height - (budgetMs / scale) * height;

  return (
    <div className="frame-graph">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Frame times, worst ${worst.toFixed(1)} milliseconds`}
      >
        {history.map((ms, index) => {
          const clamped = Math.min(ms, scale);
          const barHeight = Math.max(0.5, (clamped / scale) * height);
          return (
            <rect
              key={index}
              x={index}
              y={height - barHeight}
              width={1}
              height={barHeight}
              className={ms > budgetMs * 2 ? 'bad' : ms > budgetMs ? 'ok' : 'good'}
            />
          );
        })}
        <line x1={0} x2={width} y1={budgetY} y2={budgetY} className="budget" />
      </svg>
      <div className="frame-graph-axis">
        <span>{history.length} frames</span>
        <span>{budgetMs.toFixed(1)} ms budget</span>
        <span>peak {worst.toFixed(1)} ms</span>
      </div>
    </div>
  );
}
