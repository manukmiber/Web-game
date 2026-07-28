# External hardware

An Arduino — or anything that can print a line of text — can drive a scene, and a scene can
drive it back. A potentiometer becomes an analog steering axis, a button becomes a key the game
already reads, and the player's health can dim an LED on the desk.

The whole feature is one line-based protocol, two pipes to carry it, and a small binding
language. Nothing below the binding layer knows what a game is, and nothing above it knows what
a serial port is.

## The five-minute version

1. Press **F9** (or the **⚡ Hardware** button in the status bar) to bring up the Hardware tab
   in the bottom dock.
2. Press **+ Simulated** — a board made of sliders, so none of this needs a delivery to arrive.
3. Add a **Hardware Rig** from the toolbar's **Game ▾** menu, and a **Player** if the scene has
   none.
4. Press **Play** and drag the `A1` slider. The character walks.

Then swap the simulated rig for a real one: flash `firmware/WebGameLink/WebGameLink.ino`, press
**+ USB Serial**, pick the port. The bindings do not change.

## Connecting

| Route | For | Needs |
| --- | --- | --- |
| **USB Serial** | An Arduino on the end of a cable | Chrome or Edge (Web Serial), a user click |
| **WebSocket** | ESP32, Pi Pico W, or a bridge process next to a USB board | A URL |
| **Simulated** | Building and testing bindings with no hardware at all | Nothing |

Web Serial only exists in Chromium browsers, and only from a user gesture — the port chooser is
the browser's own, and a page cannot enumerate ports or open one silently. That is a privacy
decision worth respecting rather than routing around: on Firefox and Safari, run something next
to the board that relays its serial port to a WebSocket and connect to that. The contract is
just "the same lines, both directions".

Opening a serial port toggles DTR, which **resets most Arduinos**. That is why auto-connect is
off by default: a page that reopens the port on every hot reload resets the board every time you
save a file.

## The protocol

ASCII, one message per line. It is deliberately something you can type into the Arduino IDE's
serial monitor to test a servo, and read back to find out why a rig went quiet.

**Board → editor**

```
hello name=Cockpit protocol=1 channels=A0,A1,D2,D3   introduce yourself (optional, recommended)
A0=512 A1=7 D2=1                                     any number of channels per line
A0 512                                               spaces work too
#calibrating                                         a log line — shows in the editor console
!stick not calibrated                                an error — shows in red
bye                                                  signing off
```

**Editor → board**

```
D13=255      set a channel
servo=90     names are free-form; the firmware decides what they mean
bye=1        the editor is closing the link — zero your outputs
?            identify yourself
```

Values may be numbers or the words `on`/`off`, `true`/`false`, `high`/`low`. Channel names are a
letter followed by letters, digits or underscores: `A0`, `D13`, `throttle`. A `hello` field
containing spaces is quoted — `name="Left Cockpit"`.

A line the editor cannot parse is shown in the console rather than swallowed, because "my sketch
prints the wrong thing" and "the editor shows nothing" should not look the same.

**Why text.** A packed binary framing would save a handful of bytes per sample and cost the
ability to debug the link with a serial monitor. At 115200 baud the budget is ~11,520 characters
a second — about 190 per frame at 60 fps — and `A0=512\n` is seven of them.

### Rate, and why the firmware matters

The link is the narrow part of this system, and the sketch is where that is managed:

- Report a channel **only when it changes** by more than a deadband. A 10-bit ADC jitters by a
  couple of counts sitting still; streaming every reading fills the link with noise.
- Cap how often one channel may report (the reference sketch: 8 ms, ~120 Hz — twice a frame).
- Send a **heartbeat** anyway once a second, so a channel that has not moved still proves it is
  alive.
- Never `delay()`. A delay in the loop is latency in the game.

The editor's side keeps its half of the bargain: an output whose value has not changed is never
written, and every output binding carries a rate limit.

## Channels

A channel is a name and a number. Two conventions the engine assumes when nothing says
otherwise:

| Name | Assumed range | Because |
| --- | --- | --- |
| `A0`, `A1`, … | 0–1023 | Every AVR Arduino's ADC is 10-bit |
| anything else | 0–1 | Digital pins, and named channels are usually flags |

Wrong guesses are one option away — `max=4095` for an ESP32's 12-bit ADC — and the guess only
has to be right often enough that the common case needs no calibration.

Reference a channel as `A0` for "whichever board has it", or `uno:A0` to name the device. The
device id is shown in the hardware panel next to each board.

## Input bindings

On a **Hardware Input** component. One binding per line:

```
A0 -> axis:turn bipolar deadzone=0.06
A1 -> axis:move bipolar
D2 -> key:Space
D3 -> key:ShiftLeft
uno:A2 -> key:KeyE threshold=0.8
```

| Option | Default | What it does |
| --- | --- | --- |
| `min=` `max=` | from the channel name | Raw range the channel spans |
| `bipolar` | off | Map to -1..1 instead of 0..1 — what a centre-detented stick wants |
| `invert` | off | Flip it, for a pot wired backwards |
| `deadzone=` | 0 | Below this magnitude the axis reads zero; the rest is rescaled to full travel, so a deadzone costs no top speed |
| `threshold=` | 0.5 | `key:` bindings only — the value at which the key counts as held |

`#` and `//` start a comment. Commas and semicolons separate bindings on one line.

**Keys are real keys.** A binding to `key:Space` calls the same `InputState.setKey` a keyboard
does, so held/pressed/released behave identically and *nothing downstream can tell the
difference*. That is the point: a scene built with a keyboard works with a rig plugged in, and a
scene built for a rig degrades to the keyboard when it is unplugged.

**Axes are named.** The character controller reads three: `move` (positive forward), `strafe`
(positive right) and `turn` (positive right). They are summed with the keyboard, so an unplugged
rig leaves them at zero and the keys behave exactly as they always did. Any other name is yours
to read from a script.

The **Smoothing** field (0–0.95) exponentially smooths axes only. A breadboard pot jitters by a
couple of counts, which is invisible on a lamp and very visible on a camera that will not sit
still. Buttons are deliberately never smoothed — a delayed edge is worse than a noisy one.

## Output bindings

On a **Hardware Output** component. The arrow points the other way, and the source is read from
**the entity the component is on**:

```
D13 <- health01 scale=255 rate=8
buzzer <- alive
D9 <- var:alarm
D5 <- const:1
servo <- axis:turn scale=90 decimals=1
```

| Source | Value |
| --- | --- |
| `health` | The entity's current health |
| `health01` | Health as a 0–1 fraction of its maximum |
| `alive` | 1 or 0 |
| `var:name` | A `GameState` variable — what scripts set with `game.set('name', v)` |
| `axis:name` | A named input axis, for echoing a control back to the rig |
| `const:n` | A fixed number |

| Option | Default | What it does |
| --- | --- | --- |
| `scale=` | 1 | Multiplier — `scale=255` turns a 0–1 fraction into PWM |
| `min=` `max=` | unclamped | Clamp after scaling |
| `decimals=` | 0 | Places sent. Zero, because `analogWrite` takes an integer |
| `rate=` | 20 | Writes per second, per binding |

**Zero On Stop** writes 0 to every channel the session touched when Play ends. Without it a lamp
lit on the last frame stays lit on the desk, which is the hardware version of a play session
leaking into the scene — the one thing [ARCHITECTURE.md §6](../ARCHITECTURE.md) promises does
not happen.

Outputs are one frame behind the state they read (the hardware system runs first, so a physical
button is never a frame late). At a rate limit of 8 Hz that is already invisible.

## From a script

Bindings cover the common case; `hardware` covers everything else — a rotary encoder that means
"next weapon", a lamp that blinks twice when a wave starts, a firmware command this protocol
does not model.

```js
function update(dt) {
  // Raw is what the board sent; value is 0..1 against the channel's assumed range.
  const throttle = hardware.value('A0');
  entity.moveForward(throttle * 4 * dt);

  if (hardware.wasPressed('D2')) console.log('fired');

  // Unchanged writes cost nothing, so this in update() is fine.
  hardware.write('D13', entity.health > 30 ? 0 : 255);
}
```

| Member | Returns |
| --- | --- |
| `hardware.connected` | True while any device has an open link |
| `hardware.devices()` | Device ids, for `write(id + ':D13', 1)` |
| `hardware.raw(ch)` / `value(ch)` | Exactly what the board sent / 0–1 |
| `hardware.isDown(ch)` | `raw >= 0.5` |
| `hardware.wasPressed(ch)` / `wasReleased(ch)` | Edges, valid for one frame |
| `hardware.write(ch, v)` | False if nothing took it — no device, closed link, or unchanged |
| `hardware.send(line, deviceId?)` | A raw protocol line |
| `hardware.axis(name)` | A named axis, whoever set it |

Every read is safe with nothing plugged in — 0, or false. A scene that uses hardware must still
be playable without it, or the rig becomes a requirement for opening the project.

## Frames, not events

Inbound lines are queued as they arrive and applied **once per frame**, at the top of the tick,
before any system runs. So a frame sees one consistent snapshot of the rig rather than a stick
that moves halfway through, and `wasPressed` means "since the last frame" rather than "since
some point in the last 16 ms". It is the same contract `InputState` keeps for the keyboard, and
it is what makes hardware behaviour reproducible enough to test.

The bus is pumped in edit mode too, which is why channel values move in the panel without
pressing Play — calibrating a pot by watching a number is an editing task.

## Devices are not scene data

Nothing about a connection is serialized. Which board is plugged in is a property of the desk,
not of the level; scenes reference channels by name and run on any rig that provides them. A
scene with a `Hardware Rig` opens fine on a machine with nothing attached — the channels read
zero and the keyboard still works.

Play and Stop do not close ports. What they do drop is buffered lines, edges, and the record of
what was last written, so the next session re-sends its outputs rather than assuming the board
remembers.

## What this does not do

- **No HID or Bluetooth.** Web Serial and WebSocket cover a wired board and a networked one; a
  gamepad is a different API with a different shape and is not pretended to be a serial device.
- **No auto-reconnect.** A board being flashed drops the link, and a transport that redials
  every second turns a flash cycle into a console full of failures. The panel has a button.
- **No firmware upload.** Flash from the Arduino IDE, or `arduino-cli`.
- **One board, one name.** Two identical boards get distinct ids, but which is which is decided
  by connection order — qualify the reference (`serial2:A0`) rather than guessing.

## Security, stated rather than implied

Web Serial is a permission the user grants per port, per origin, from a click. A page cannot
open a port silently, and a scene cannot ask for one — scenes describe channels, and only the
panel connects.

What a scene *can* do, once a device is attached, is write to any channel on it. A scene file is
already executable code ([ARCHITECTURE.md §10.2](../ARCHITECTURE.md)); with hardware attached it
is executable code with a wire to a pin. Do not open a scene you would not run a script from,
and do not leave a port open to one.
