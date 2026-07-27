/**
 * Keyboard and pointer state, as plain data.
 *
 * The engine never listens to the DOM (ARCHITECTURE.md §9.5) — whoever hosts the canvas feeds
 * this from its own event handlers, and the engine only ever reads it. That is what lets the
 * same gameplay systems run under a headless test, in a worker, or in a server-side simulation
 * where "input" arrives over the network rather than from a keyboard.
 *
 * Edge state (`wasPressed`/`wasReleased`) is cleared by `endFrame()`, which the Engine calls
 * once per tick after systems have run. A system that misses a frame misses the edge — that is
 * the same contract Unity's `GetKeyDown` has, and it is why jump-on-press belongs in a system
 * rather than in a listener.
 */

/** Pointer button bitmask, matching the DOM's `PointerEvent.buttons`. */
export const MOUSE_LEFT = 1;
export const MOUSE_RIGHT = 2;
export const MOUSE_MIDDLE = 4;

/**
 * Accepts both `KeyboardEvent.code` ("KeyW", "ArrowUp", "ShiftLeft") and the shorthand a
 * script author will actually type ("w", "up", "shift"). Scripts are written by hand in a
 * textarea; making them spell "KeyW" would be a papercut on every single one.
 */
export function normalizeKey(key: string): string {
  if (key.length === 1) {
    const char = key.toUpperCase();
    if (char >= 'A' && char <= 'Z') return `Key${char}`;
    if (char >= '0' && char <= '9') return `Digit${char}`;
  }
  switch (key.toLowerCase()) {
    case 'up':
      return 'ArrowUp';
    case 'down':
      return 'ArrowDown';
    case 'left':
      return 'ArrowLeft';
    case 'right':
      return 'ArrowRight';
    case 'space':
      return 'Space';
    case 'shift':
      return 'ShiftLeft';
    case 'ctrl':
    case 'control':
      return 'ControlLeft';
    case 'alt':
      return 'AltLeft';
    case 'esc':
    case 'escape':
      return 'Escape';
    case 'enter':
      return 'Enter';
    case 'tab':
      return 'Tab';
    default:
      return key;
  }
}

/** Left and right modifiers are one key as far as gameplay is concerned. */
const PAIRED: Record<string, string> = {
  ShiftLeft: 'ShiftRight',
  ShiftRight: 'ShiftLeft',
  ControlLeft: 'ControlRight',
  ControlRight: 'ControlLeft',
  AltLeft: 'AltRight',
  AltRight: 'AltLeft',
};

export class InputState {
  /** Pointer position in normalised device coordinates, -1..1, y up. */
  pointerX = 0;
  pointerY = 0;
  /** Pointer travel since the last `endFrame()`, in pixels. */
  pointerDeltaX = 0;
  pointerDeltaY = 0;
  /** Wheel travel since the last `endFrame()`. */
  wheelDelta = 0;
  buttons = 0;

  private down = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  private axes = new Map<string, number>();

  // ------------------------------------------------------------------ writes

  setKey(key: string, isDown: boolean): void {
    const code = normalizeKey(key);
    if (isDown) {
      // Auto-repeat fires keydown over and over; only the first is an edge.
      if (this.down.has(code)) return;
      this.down.add(code);
      this.pressed.add(code);
    } else {
      if (!this.down.delete(code)) return;
      this.released.add(code);
    }
  }

  setPointer(x: number, y: number, deltaX = 0, deltaY = 0): void {
    this.pointerX = x;
    this.pointerY = y;
    this.pointerDeltaX += deltaX;
    this.pointerDeltaY += deltaY;
  }

  setButtons(buttons: number): void {
    this.buttons = buttons;
  }

  addWheel(delta: number): void {
    this.wheelDelta += delta;
  }

  /**
   * Sets a named analog axis, -1..1.
   *
   * Keys are a poor fit for a control that is not on or off: a potentiometer at a third of its
   * travel is not "W held". Named axes are the seam where continuous hardware — a stick, a
   * pedal, a wheel — reaches gameplay without every system growing a second input path. The
   * standard names the built-in systems read are `move`, `strafe` and `turn`; anything else is
   * free for scripts.
   *
   * Level state, not edge state: an axis holds its value until something writes another one,
   * which is why `endFrame` leaves it alone and `clear` does not.
   */
  setAxis(name: string, value: number): void {
    this.axes.set(name, value < -1 ? -1 : value > 1 ? 1 : value);
  }

  getAxis(name: string): number {
    return this.axes.get(name) ?? 0;
  }

  /** Keyboard axis plus the analog one, clamped — so a stick and the arrow keys can coexist. */
  combinedAxis(negative: string, positive: string, name: string): number {
    const total = this.axis(negative, positive) + this.getAxis(name);
    return total < -1 ? -1 : total > 1 ? 1 : total;
  }

  // ------------------------------------------------------------------- reads

  isDown(key: string): boolean {
    const code = normalizeKey(key);
    return this.down.has(code) || this.down.has(PAIRED[code] ?? '');
  }

  wasPressed(key: string): boolean {
    const code = normalizeKey(key);
    return this.pressed.has(code) || this.pressed.has(PAIRED[code] ?? '');
  }

  wasReleased(key: string): boolean {
    const code = normalizeKey(key);
    return this.released.has(code) || this.released.has(PAIRED[code] ?? '');
  }

  isMouseDown(button = MOUSE_LEFT): boolean {
    return (this.buttons & button) !== 0;
  }

  /** -1, 0 or 1 — the shape every movement system wants. */
  axis(negative: string, positive: string): number {
    return (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
  }

  // --------------------------------------------------------------- lifecycle

  /** Called by the Engine after systems tick. Drops edges and per-frame deltas. */
  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.pointerDeltaX = 0;
    this.pointerDeltaY = 0;
    this.wheelDelta = 0;
  }

  /**
   * Drops everything, including held keys.
   *
   * Called on leaving play mode and when the canvas loses focus: a key held as the window
   * blurs never delivers its keyup, and the character would otherwise walk into the horizon
   * forever.
   */
  clear(): void {
    this.down.clear();
    this.pressed.clear();
    this.released.clear();
    this.axes.clear();
    this.buttons = 0;
    this.pointerDeltaX = 0;
    this.pointerDeltaY = 0;
    this.wheelDelta = 0;
  }
}
