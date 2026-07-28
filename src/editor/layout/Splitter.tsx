import { useCallback, useRef } from 'react';

interface Props {
  /** `x` resizes a side dock, `y` resizes the bottom dock. */
  axis: 'x' | 'y';
  /**
   * True when the dock is on the far side of the handle — the right dock and the bottom dock —
   * so dragging towards the centre of the window makes it bigger, not smaller.
   */
  invert?: boolean;
  size: number;
  onResize(size: number): void;
  label: string;
}

/** Keyboard nudge, and the wheel/arrow step. Matches the grid other editors use. */
const STEP = 16;

/**
 * The drag handle between a dock and the viewport.
 *
 * Pointer capture rather than window listeners: the pointer routinely leaves the 6px handle
 * mid-drag, and over the WebGL canvas at that — where a stray `pointermove` would otherwise
 * start orbiting the camera underneath the drag.
 *
 * It is also a real focusable control with arrow keys, because a splitter that can only be
 * dragged makes the panel sizes unreachable without a mouse.
 */
export function Splitter({ axis, invert = false, size, onResize, label }: Props) {
  const start = useRef({ pointer: 0, size: 0 });

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      start.current = {
        pointer: axis === 'x' ? event.clientX : event.clientY,
        size,
      };
    },
    [axis, size],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const delta = (axis === 'x' ? event.clientX : event.clientY) - start.current.pointer;
      onResize(start.current.size + (invert ? -delta : delta));
    },
    [axis, invert, onResize],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
      const forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      if (event.key !== back && event.key !== forward) return;
      event.preventDefault();
      // The shortcut layer must not see these: an unhandled arrow key is harmless today, but
      // the splitter owning its own keys is what keeps it that way.
      event.stopPropagation();
      const direction = event.key === forward ? 1 : -1;
      onResize(size + direction * STEP * (invert ? -1 : 1));
    },
    [axis, invert, onResize, size],
  );

  return (
    <div
      className={`splitter splitter-${axis}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(size)}
      title={`${label} — drag, or focus and use the arrow keys`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResize(axis === 'x' ? 280 : 220)}
    >
      <span className="splitter-grip" />
    </div>
  );
}
