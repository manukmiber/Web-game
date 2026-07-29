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
| `fixedUpdate(dt)` | Once per physics step, `dt` always the fixed timestep |
| `lateUpdate(dt)` | After every `update` in the scene has run |
| `onCollisionEnter(hit)` | A solid contact began |
| `onCollisionStay(hit)` | A solid contact is still there — once per frame, not once per step |
| `onCollisionExit(otherId)` | A solid contact ended |
| `onTriggerEnter(hit)` | Something entered a collider marked **Is Trigger** |
| `onTriggerExit(otherId)` | It left |
| `onMessage(name, payload, senderId)` | Another script sent this entity a message |
| `destroy()` | On stop, on the entity being deleted, or on the script being disabled or edited |

Editing the source while playing destroys the old instance and starts a new one, so you can tune
a behaviour without leaving Play mode. Local variables are lost on that reload — `start()` runs
again.

### `update` or `fixedUpdate`?

Anything that applies **force** belongs in `fixedUpdate`. A push applied once per *frame* is a
push whose strength depends on the frame rate, which is the most common physics bug there is:
the same code sends a crate twice as far on a 120 Hz monitor as on a 60 Hz one. `fixedUpdate`
runs exactly as often as the solver stepped — several times in a slow frame, not at all in a very
fast one — so a force applied there is the same force everywhere.

Everything else belongs in `update`: reading input, animating, counting down. And `lateUpdate` is
for anything that has to see the finished frame, which in practice means a follow camera.

## Several scripts on one entity

An entity may carry as many `Script` components as it likes, and each is a separate behaviour
with its own local variables, its own timers and its own error state. Deleting one leaves the
others running.

They run in the order of the component's **Order** field — lower first, ties in the order the
components were added. Order matters more often than it looks: a camera script that follows a
character has to run after the movement script, or it tracks where the character *was*.

```js
// "Health" — order 0
function onMessage(name, payload) {
  if (name !== 'hit') return;
  props.hp -= payload;
  if (props.hp <= 0) scene.send(entity, 'died');
}

// "Loot" — order 10, and it does not know the Health script exists
function onMessage(name) {
  if (name === 'died') scene.spawn('Sphere', { name: 'Coin', position: entity.position.toArray() });
}
```

That is the point of the split: either behaviour can be deleted without touching the other.

## What is in scope

### `entity` — the entity the script is attached to

| Member | Notes |
| --- | --- |
| `id`, `name`, `exists` | `name` is writable |
| `position`, `rotation`, `scale` | Live views: `.x/.y/.z`, `.set(x,y,z)`, `.add(x,y,z)`, `.toArray()`. Rotation is Euler degrees |
| `component(type)` | The raw component object — mutate it to change the entity (`entity.component('Material').color = '#ff0000'`) |
| `has(type)` | |
| `components(type)` | Every component of a type — `entity.components('Script')` |
| `addComponent(type, overrides?)` | Any registered type, with the same defaults the Inspector uses. One per type, except types that allow several (`Script`) |
| `removeComponent(type)` | Removes the first of that type |
| `body` | A `BodyHandle` when the entity has a `RigidBody`, else `null` |
| `grounded` | Standing on something. Answers for a rigid body *or* a character controller |
| `jump(speed)` | Launches a character controller; an equivalent impulse on a rigid body |
| `send(name, payload?)` | Delivers `onMessage` to every script on this entity |
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
| `send(target, name, payload?)` | Message every script on one entity. Returns how many heard it |
| `broadcast(name, payload?)` | Message every script in the scene |
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

### `time` — the clock, and timers

`time.dt` (the same value `update` receives), `time.elapsed` (seconds since Play started),
`time.frame`, `time.fixedDt` (the physics step), and `time.smoothDt` — `dt` with frame-to-frame
jitter filtered out, for anything that would rather be smooth than exact. A follow camera reads
it; a timer or a physics impulse must not, because they have to be faithful to real elapsed time.

`time.scale` and `time.paused` are the two you can also **write**.

```js
function update() {
  if (input.wasPressed('p')) time.paused = !time.paused;
  // Bullet time while the player is nearly dead.
  time.scale = game.health(entity) < 20 ? 0.4 : 1;
}
```

`time.scale` multiplies every subsequent `dt`: physics, scripts and animation all slow down
together, which is what makes bullet time one line rather than a per-system speed field. It is
clamped to `0..8` — a negative scale would run the solver backwards through collision responses
that assume time moves forward, and past 8 a single step at the frame cap is large enough to
tunnel a body straight through a wall.

`time.paused` freezes the world without stopping the frame. Rendering, input and the hardware
pump all keep running and scripts keep ticking with a `dt` of zero, so the script that paused
the game is still there to watch for the key that unpauses it — which is why a pause menu needs
nothing from the engine beyond this flag. Note what does *not* stop: `time.every` and
`time.after` are driven by `dt`, so they hold still too, and a sound already playing keeps
playing (stop it yourself if a paused game should be silent).

Both are shared with the editor — the toolbar's pause button and speed menu read and write the
same values — and both are reset to `false` and `1` when Play mode ends, so a session that
finished in slow motion does not hand a slowed editor back to whoever pressed Stop.

```js
function start() {
  time.after(2, function () { console.log('two seconds in'); });
  const handle = time.every(0.5, function () { entity.rotation.y += 45; });
  time.after(5, function () { time.cancel(handle); });
}
```

`time.after(seconds, fn)` runs once, `time.every(seconds, fn)` repeats, and both return a handle
for `time.cancel`. They belong to the script instance: they are dropped when the script is
disabled, edited, deleted, or when Play mode stops. That is exactly the behaviour people wanted
from `setTimeout` and would not have got — a real timer outlives the play session and keeps
firing into a scene that no longer exists, which is why `setTimeout` is shadowed.

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

### `physics` — the simulated world

Every query is safe in a scene with no colliders: casts miss and overlaps come back empty. See
[PHYSICS.md](./PHYSICS.md) for the components these queries are asking about.

```js
// Shoot: a ray from the entity, ignoring its own collider.
const hit = physics.raycast(entity.position.toArray(), entity.forward(), 50, { ignore: [entity.id] });
if (hit) {
  console.log('hit ' + hit.entity.name + ' at ' + hit.distance.toFixed(1) + ' m');
  hit.entity.damage(10, entity.id);
}
```

| Member | Notes |
| --- | --- |
| `gravity` | The scene's gravity vector |
| `bodyCount` | Bodies the solver is tracking |
| `raycast(origin, direction, maxDistance?, options?)` | Nearest hit, or `null` |
| `raycastAll(...)` | Every hit, nearest first |
| `overlapSphere(center, radius, options?)` | Handles for everything inside |
| `groundBelow(origin, maxDistance?, options?)` | Straight down — "what is under this" |
| `explode(center, radius, strength, options?)` | Shoves nearby bodies out, falling off with distance |

A hit carries `entity`, `entityId`, `distance`, `point` and `normal`. `options` takes
`ignore: [id, …]`, `layers: ['props', …]` and `includeTriggers: true`; triggers are skipped by
default, because a bullet should not stop at a checkpoint.

`entity.body` is how a script pushes its own body about — `velocity`, `speed`, `mass`,
`sleeping`, `grounded`, `groundId`, `impulse(x, y, z)`, `force(x, y, z)`, `teleport(x, y, z)`,
`wake()`. It is `null` when nothing is simulating the entity, which is the honest answer.

### `mathf` — the arithmetic every gameplay script writes

`clamp`, `clamp01`, `lerp`, `inverseLerp`, `remap`, `damp`, `moveTowards`, `smoothstep`,
`wrapAngle`, `angleDelta`, `lerpAngle`, `random(min?, max?)`, `randomInt(min, max)`,
`randomDirection()`, `distance(a, b)`, `distanceXZ(a, b)`.

Two are worth calling out. `mathf.damp(current, target, smoothing, dt)` is the fix for the
`x += (target - x) * 0.1` everyone writes, which converges twice as fast at 120 fps as at 60 and
so makes a camera feel different on different machines. And `mathf.lerpAngle` goes the short way
round, so 350° to 10° turns forward through zero rather than backwards through 180.

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

### `audio` — Web Audio, and `entity.playSound`

Safe with nothing loaded: a clip that has not finished decoding yet, or one that 404s, just plays
no sound rather than throwing.

```js
function onCollisionEnter(collision) {
  entity.playSound('sfx/impact.mp3', { volume: 0.6 });
}
```

| Member | Notes |
| --- | --- |
| `play(clip, options?)` | One-shot or looping. `options.position` makes it spatial |
| `music(clip, options?)` | Replaces the music bus, crossfading over `options.fadeSeconds` |
| `stopMusic(fadeSeconds?)` | |
| `stopAll()` | Every playing sound — a scene transition, a game-over screen |
| `busVolume(bus)` / `setBusVolume(bus, volume)` | `'music'`, `'sfx'` or `'ambient'` |
| `masterVolume` | Get/settable, above all three buses |
| `muted` | Get/settable, and overrides `masterVolume` without forgetting it |

`entity.playSound(clip, options?)` is the common case: a one-shot at the entity's current
position, on the `sfx` bus by default. `AudioSource` is the component for the object-owned case —
ambience that starts with Play and stops with the entity — described in the README's Play mode
section; this API is for events, `AudioSource` is for things that just *are* playing.

Every voice, whether started by a script or by an `AudioSource`, is silenced the moment Play
stops — sounds are session state exactly the way `game` is (the note above about restores applies
here too).

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
- **Contacts arrive in the frame they happened.** Physics steps before scripts run, so a script
  hears about a landing and can react to it on the same frame rather than the next one.
- **Messages are delivered synchronously**, so `scene.send` can be a question and not just an
  announcement. Two scripts that answer each other are cut off after eight rounds rather than
  blowing the stack.

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

**No `setTimeout`, no async.** `setTimeout` and `setInterval` are shadowed deliberately: a real
timer outlives Play mode and would keep firing into a scene that no longer exists. Use
`time.after` and `time.every`, which are owned by the script instance and die with it. There is
still no way to `await` anything.

**`grounded` is one frame old.** Scripts run before the character controller moves, so
`entity.grounded` is what the last completed step found. It is the same one-frame contract
Unity's `isGrounded` has, and for the same reason.

**Physics is linear only.** Contacts never spin a body — there is no angular velocity. See
[PHYSICS.md](./PHYSICS.md) for why, and for what to reach for instead when tumbling is the
feature.

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
