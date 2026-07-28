import { useEffect, useRef, useState } from 'react';
import type { InputState } from '@engine/input/InputState';
import { lookAxis, stickAxis } from './touchStick';

/**
 * On-screen movement controls for Play mode on a device with no keyboard.
 *
 * Play mode reads WASD, the arrow keys, Shift and Space. On a phone none of those exist, so
 * pressing Play produced a camera that could be looked at and a character that could not be
 * moved — the whole runtime, unreachable. This is the missing half of the input path.
 *
 * It writes into `InputState` and nowhere else. The engine never listens to the DOM
 * (ARCHITECTURE.md §9.5), and the named analog axes it already exposes — `move`, `strafe`,
 * `turn`, read by `CharacterSystem` alongside the keys — are exactly the seam a stick belongs
 * on. So none of this needed a line of engine code: a thumb on glass and a gamepad plugged into
 * the hardware bridge arrive through the same door, and a script that reads `input.getAxis`
 * cannot tell them apart.
 *
 * Both pads are *relative*: the stick's centre is wherever the thumb first lands rather than
 * the middle of a painted circle. Fixed centres demand that you look at your thumb, and in a
 * game you are looking at the screen.
 */

interface Props {
  input: InputState;
  /** Leaving Play mode has to release whatever was held — see `release`. */
  playing: boolean;
}

export function TouchControls({ input, playing }: Props) {
  const [running, setRunning] = useState(false);
  // Which pointer owns which pad. Tracked by id so a thumb on the stick and a thumb on the look
  // pad do not overwrite each other — the single most obvious thing to get wrong here.
  const pads = useRef(new Map<number, Pad>());

  // A pointer released outside the pad, or lost to Play mode ending, never delivers its "up".
  useEffect(() => {
    if (playing) return;
    pads.current.clear();
    setRunning(false);
    input.setAxis('move', 0);
    input.setAxis('strafe', 0);
    input.setAxis('turn', 0);
    input.setKey('ShiftLeft', false);
  }, [playing, input]);

  if (!playing) return null;

  const begin = (kind: PadKind) => (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pads.current.set(event.pointerId, { kind, x: event.clientX, y: event.clientY });
    // Not preventDefault: the pads sit above the canvas and `touch-action: none` already stops
    // the browser claiming the gesture, so there is nothing left to cancel.
  };

  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const pad = pads.current.get(event.pointerId);
    if (!pad) return;
    const dx = event.clientX - pad.x;
    const dy = event.clientY - pad.y;

    if (pad.kind === 'move') {
      input.setAxis('strafe', stickAxis(dx));
      // Screen up is forward, and screen y grows downward.
      input.setAxis('move', stickAxis(-dy));
    } else {
      input.setAxis('turn', lookAxis(dx));
    }
  };

  const end = (event: React.PointerEvent<HTMLDivElement>) => {
    const pad = pads.current.get(event.pointerId);
    if (!pad) return;
    pads.current.delete(event.pointerId);
    if (pad.kind === 'move') {
      input.setAxis('move', 0);
      input.setAxis('strafe', 0);
    } else {
      input.setAxis('turn', 0);
    }
  };

  const handlers = (kind: PadKind) => ({
    onPointerDown: begin(kind),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
  });

  return (
    <div className="touch-controls" aria-hidden="true">
      <div className="touch-pad touch-pad-move" {...handlers('move')}>
        <span className="touch-pad-label">move</span>
      </div>
      <div className="touch-pad touch-pad-look" {...handlers('look')}>
        <span className="touch-pad-label">turn</span>
      </div>
      <div className="touch-buttons">
        <button
          className={`touch-button ${running ? 'held' : ''}`}
          // Run is a toggle rather than a hold: holding a third finger down while two thumbs are
          // already busy is not a thing a pair of hands can do.
          onPointerDown={() => {
            const next = !running;
            setRunning(next);
            input.setKey('ShiftLeft', next);
          }}
        >
          run
        </button>
        <button
          className="touch-button"
          onPointerDown={() => input.setKey('Space', true)}
          onPointerUp={() => input.setKey('Space', false)}
          onPointerCancel={() => input.setKey('Space', false)}
        >
          jump
        </button>
      </div>
    </div>
  );
}

type PadKind = 'move' | 'look';

interface Pad {
  kind: PadKind;
  /** Where the thumb first landed — this pad's centre for as long as it is held. */
  x: number;
  y: number;
}
