# Scripting

A `Script` component runs JavaScript on its entity while the engine is in **Play** mode. This is
the reference for what a script can see and do; [ARCHITECTURE.md §10](../ARCHITECTURE.md) covers
why it is built this way.

```js
// Attach a Script component, then write this in the Inspector's Source box.
let bob = 0;

function start() {
  console.log(entity.name + ' is awake');
}

function update(dt) {
  bob += dt;
  entity.position.y = 1 + Math.sin(bob * props.speed) * 0.5;
}
```

## Lifecycle

Declare any of these as plain functions. Ones you leave out simply do not run — there is no
boilerplate and nothing to return.

| Hook | When |
| --- | --- |
| `start()` | Once, on the first frame the script is live |
| `update(dt)` | Every frame, `dt` in seconds |
| `destroy()` | On stop, on the entity being deleted, or on the script being disabled or edited |

Editing the source while playing destroys the old instance and starts a new one, so you can tune
a behaviour without leaving Play mode. Local variables are lost on that reload — `start()` runs
again.

## What is in scope

### `entity` — the entity the script is attached to

| Member | Notes |
| --- | --- |
| `id`, `name`, `exists` | `name` is writable |
| `position`, `rotation`, `scale` | Live views: `.x/.y/.z`, `.set(x,y,z)`, `.add(x,y,z)`, `.toArray()`. Rotation is Euler degrees |
| `component(type)` | The raw component object — mutate it to change the entity (`entity.component('Material').color = '#ff0000'`) |
| `has(type)` | |
| `addComponent(type, overrides?)` | Any registered type, with the same defaults the Inspector uses. One per type |
| `removeComponent(type)` | |
| `parent()`, `children()` | Handles, or `null` |
| `forward()` | Unit vector, following the engine's **-Z is forward** convention |
| `lookAt(x, z)` | Yaw only |
| `moveForward(distance)` | |
| `distanceTo(other)`, `distanceXZTo(other)` | Takes a handle or `[x, y, z]` |
| `health`, `alive`, `damage(n)`, `heal(n)` | Only meaningful for entities the gameplay systems registered |
| `destroy()` | |

### `scene` — everything else

| Member | Notes |
| --- | --- |
| `find(name)`, `findAll(name)`, `byId(id)` | |
| `withComponent(type)` | e.g. `scene.withComponent('NpcAgent')` |
| `nearest(from, type, maxDistance?)` | Ground-plane distance, excludes `from` |
| `spawn(kind, { name, position, color, parentId })` | Any primitive: `'Box'`, `'Capsule'`, … |
| `count` | |

### `input` — keyboard and pointer

Keys accept both `KeyboardEvent.code` and shorthand: `'w'`, `'space'`, `'left'`, `'shift'`.

```js
if (input.isDown('w')) entity.moveForward(4 * dt);
if (input.wasPressed('space')) console.log('jump');
const turn = input.axis('ArrowRight', 'ArrowLeft'); // -1, 0 or 1
```

`isDown`, `wasPressed`, `wasReleased`, `axis(negative, positive)`, `isMouseDown(button?)`,
`pointerX/pointerY` (normalised -1..1), `pointerDeltaX/Y`, `wheelDelta`.

Press and release edges last exactly one frame.

Named analog axes sit beside the keys — `getAxis(name)`, and `setAxis(name, value)` to drive one
from a script. External hardware writes `move`, `strafe` and `turn` there, which is how a
potentiometer steers a character that was written against `KeyW`. Unlike keys, an axis holds its
value until something writes another one.

### `time`

`time.dt` (same value `update` receives), `time.elapsed` (seconds since Play started),
`time.frame`.

### `props`

The tunables listed under the script in the Inspector. Add one there, then read and write it as
`props.name`. Numbers, strings and booleans only — they are saved with the scene.

Props are how one script serves many entities: twenty zombies sharing one source but each with
its own `speed` compile once, because the compiler caches by source text.

### `game` — gameplay state that is not part of the scene

`game.get(key, fallback)` / `game.set(key, value)` for shared variables (score, wave number),
and `game.health(target)`, `game.maxHealth(target)`, `game.isAlive(target)`,
`game.damage(target, amount, source?)`, `game.heal(target, amount)` where `target` is a handle or
an entity id.

None of it survives leaving Play mode, which is the point — see the note on restores below.

### `hardware` — attached boards

Channels from an Arduino or any other device on the hardware bus. Reads are safe with nothing
plugged in — 0, or false — so a scene that uses a rig stays playable without one.

```js
if (hardware.wasPressed('D2')) console.log('fired');
entity.moveForward(hardware.value('A0') * 4 * dt);
hardware.write('D13', entity.health > 30 ? 0 : 255);   // unchanged writes cost nothing
```

`connected`, `devices()`, `raw(ch)`, `value(ch)`, `isDown(ch)`, `wasPressed(ch)`,
`wasReleased(ch)`, `write(ch, value)`, `send(line, deviceId?)`, `axis(name)`.

Most rigs need no script at all: a `HardwareInput` component maps a button onto a *key* and a
potentiometer onto a named axis, and the game reads those exactly as it reads a keyboard. This
is for what bindings cannot express. Full reference in [HARDWARE.md](./HARDWARE.md).

### `console`

`console.log`, `console.warn`, `console.error`. Output goes to the editor's Console panel, not to
the browser devtools. Clicking a message selects the entity that produced it.

## Rules the engine keeps

- **Nothing a play session does is saved.** The scene is snapshotted on Play and restored on
  Stop, and `game` state is dropped. Entities a script spawned disappear; positions it changed
  go back.
- **One broken script does not break the others.** A throw is reported to the console once, that
  instance is parked, and every other script keeps running. Fix the source and it restarts.
- **A script that hogs the frame is reported.** Over ~4 ms in one `update` earns a one-time
  warning naming the script.

## Limits worth knowing before you hit them

**This is not a security sandbox.** `window`, `document`, `fetch`, `setTimeout` and friends are
shadowed to `undefined`, which stops the accidents and makes the intended API discoverable. It
does not contain hostile code: `eval` cannot be shadowed at all (it is illegal as a parameter
name in strict mode), and `({}).constructor.constructor` rebuilds `Function` from nothing. A
scene file therefore *is* executable code — do not open one you would not run a script from.
Real isolation means a Worker or a sandboxed iframe, which needs the API to be message-based
first.

**An infinite loop hangs the tab.** There is no way to interrupt synchronous JavaScript on the
main thread. Same fix as above, same reason it has not been done yet.

**No timers, no async.** `setTimeout` and `setInterval` are shadowed deliberately: a timer
outlives Play mode and would keep firing into a scene that no longer exists. Count in
`update(dt)` or read `time.elapsed`.

**One Script per entity.** Use child entities for multiple behaviours. The Inspector addresses
components by type, and lifting that restriction is a bigger change than it looks.

## Worked example: a spawner

This is the `Game Logic` prefab from the **Game ▾** menu, verbatim.

```js
let timer = 0;

function update(dt) {
  timer += dt;
  if (timer < props.interval) return;
  timer = 0;

  const alive = scene.withComponent('NpcAgent').length;
  if (alive >= props.maxAlive) return;

  const angle = Math.random() * Math.PI * 2;
  const zombie = scene.spawn('Capsule', {
    name: 'Zombie',
    position: [
      entity.position.x + Math.cos(angle) * props.radius,
      0.9,
      entity.position.z + Math.sin(angle) * props.radius,
    ],
    color: '#6d8c5a',
  });
  zombie.addComponent('NpcAgent', { archetype: 'Zombie' });
  console.log('spawned a zombie, ' + (alive + 1) + ' alive');
}
```

The `addComponent` line is what makes it a zombie rather than a capsule standing in a field: the
NpcSystem picks the new agent up on the next frame, with the archetype's speeds, senses and
faction already filled in.
