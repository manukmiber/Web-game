# Physics

Gravity, collision and rigid bodies, new in **v0.7.5**; **2D** since v0.7.6. Three components do
all of it, and the smallest useful scene needs two of them.

```
Ground   → Collider (Plane)
Crate    → Collider (Box) + RigidBody
```

Press **Play**: the crate falls, lands, and after a moment goes to sleep. That is the whole API
in two components — everything below is detail.

## The three components

### `Collider` — the shape the solver sees

Deliberately *not* the rendered mesh. Colliding against rendered triangles means a broadphase
over a hundred thousand of them, no reliable inside/outside test for an open mesh, and a
collision shape whose cost changes silently every time someone raises a segment count in the
Inspector. Every engine that ships separates the two, and the cheap primitive is what makes a
thousand bodies affordable.

| Shape | Parameters | Good for |
| --- | --- | --- |
| `Box` | `size` (full extents) | Crates, walls, platforms |
| `Sphere` | `radius` | Balls, projectiles, blast volumes |
| `Capsule` | `radius`, `height` (caps included) | Characters, barrels, logs |
| `Plane` | none — it is infinite | The ground |
| `Circle` | `radius`, `depth` | 2D — balls, coins, characters |
| `Rect` | `size` (W×H), `depth` | 2D — platforms, walls, blocks |

Plus `center` (a local offset), `isTrigger`, `restitution` (bounciness, 0..1), `friction`, and the
two layer fields below.

A `Plane` collider is an **infinite half-space** facing local +Y, so an unrotated one is a floor.
It is the right choice for the ground even when the visible mesh is 40 m across: nothing can fall
off the edge of the world, and it costs the solver four numbers and no broadphase cell.

**A Collider with no RigidBody is static** — the world, rather than a thing in it. That is the
common case (a floor, a wall, a rock), and making it the default means the simple scene needs one
component instead of two.

### `RigidBody` — what makes it move

| Type | Gravity | Pushed by contacts | Pushes others |
| --- | --- | --- | --- |
| `Dynamic` | yes | yes | yes |
| `Kinematic` | no | no | yes |
| `Static` | no | no | yes |

`Kinematic` is for a lift, a moving platform, a door: something a script or an animation moves,
which shoves dynamic bodies out of the way and is never shoved back.

Dynamic bodies also carry `mass`, `gravityScale` (0 floats, negative rises, 2 falls hard),
`linearDamping`, `maxSpeed`, the three axis locks, and `canSleep`.

### `Physics` — scene-wide settings

One per scene, and optional: a scene without one simulates with Earth gravity and sensible
defaults, so gravity works the moment you add a RigidBody rather than after you remember to
configure the world. Add it from **Game ▾ → Physics** when you want to change something.

| Field | Default | Notes |
| --- | --- | --- |
| `gravity` | `0, -9.81, 0` | The Moon is about -1.62; a platformer usually wants -20 or lower |
| `fixedTimestep` | 1/60 | See below |
| `maxSubsteps` | 4 | Ceiling on steps per frame |
| `solverIterations` | 6 | Stiffer stacks, more time. 4–10 is the useful range |
| `positionCorrection` | 0.4 | Fraction of remaining overlap pushed out per step |
| `allowedPenetration` | 0.005 m | Overlap left alone, so resting bodies do not chatter |
| `sleepVelocity` / `sleepDelay` | 0.06 m/s, 0.6 s | When a still body stops being simulated |
| `mode` | `3D` | `2D` constrains the whole simulation to a plane — see below |
| `plane` | `XY` | Which plane a 2D scene lives in |
| `planeDepth` | 0 | Where that plane sits along the axis it does not simulate |

## Why a fixed timestep

Physics runs on a fixed step out of an accumulator, not on the frame's `dt`. It is the single most
important decision in the system. A variable step makes the simulation depend on frame rate: the
same jump reaches a different height on a 144 Hz monitor than on a 30 fps laptop, penetration
recovery oscillates whenever a frame stutters, and no run ever reproduces another.

The consequence you can see is `maxSubsteps`. A frame that took 400 ms owes twenty-four steps;
running them all would make the *next* frame worse, which makes the next one worse again — the
"spiral of death" every fixed-step loop has to defend against. Hitting the cap discards the
backlog, so the simulation runs slow rather than locking the tab. The Performance panel shows the
step count and flags when it throttled.

This is also why scripts have both `update` and `fixedUpdate`: see
[SCRIPTING.md](./SCRIPTING.md#update-or-fixedupdate).

## 2D

Set `Physics.mode` to `2D` and the scene becomes two-dimensional. There is no second solver, no
second collider hierarchy and no second raycast API — 2D is a **constraint on the 3D world**.

```
Physics  → mode: 2D, plane: XY
Ground   → Collider (Rect, 20 × 1)
Player   → Collider (Circle) + CharacterController
```

### Why not a separate 2D engine

That is the obvious way to ship 2D, and it is what Unity did. It left that project with two
collider hierarchies, two sets of layer settings, two raycast APIs and a permanent question about
which one a given component belongs to.

Everything a 2D game needs from a solver is already here. Circles are spheres, rectangles are
boxes, and sequential impulses do not care how many axes they run over. So the whole feature is
four rules, applied in one file (`physics/dimension.ts`) and consumed in about a dozen places:

1. Bodies are **held on the plane** — the depth coordinate is snapped, not integrated.
2. The depth axis is **locked**, in velocity and in positional correction alike.
3. Gravity is **projected into the plane**.
4. Contact normals and query directions are **projected and renormalised**.

Nothing else in the simulation changes. `collision.ts` did not gain a line for this release.

The payoff is that every feature reaches both dimensions at once. Triggers, layers, sleeping,
restitution, sensors, the character controller, the script API, `explode` — none of them has a 2D
variant to write, because none of them knows which mode it is running in.

### The two planes

| `plane` | Depth axis | Gravity | What it is |
| --- | --- | --- | --- |
| `XY` | Z | acts in-plane | A side-scroller. Default gravity still falls down. |
| `XZ` | Y | projected away | A top-down game. Weightless with no configuration. |

The `XZ` case is worth dwelling on: default gravity points along the axis a top-down world does not
simulate, so the projection makes it zero. A top-down scene is weightless without anyone editing
the gravity vector, which is what a top-down game wants.

### `Circle` and `Rect`

The two shapes meant for 2D, and they are not a second collider type. A `Circle` resolves to a
capsule extruded along the depth axis; a `Rect` resolves to a box whose depth half-extent is
`depth / 2`. Their cross-section *in the plane* is exactly a circle and exactly a rectangle, so the
narrowphase gives the right 2D answer with no 2D code in it.

They are extruded rather than flat for a practical reason: a 2D gameplay layer inside a 3D scene has
bodies that are only approximately coplanar, and `depth` (10 m by default) means the Z a sprite
happened to be authored at stops mattering. In a 2D scene, depth is not gameplay.

A `Rect` reads its size from `size` X and Y whichever plane it lands in, so switching a scene from
`XY` to `XZ` keeps the shapes it had rather than collapsing them.

### The character in 2D

An `XY` scene has no yaw and no forward — pressing W would ask the character to walk into the
camera — so the controls collapse to one signed axis. `←`/`→` and `A`/`D` both walk; W and S do
nothing; `Space` still jumps; and the character's yaw snaps to whichever way it is going, so a model
with a front faces it.

An `XZ` scene needs none of that. Its plane *is* the ground plane the 3D controls already work in,
so turning and walking behave exactly as in 3D and only gravity goes away.

### From a script

Nothing to learn. Velocities, impulses and query directions are projected by the world itself, so a
behaviour that shoves a body sideways or raycasts for a wall works unchanged in both modes.
`physics.mode` and `physics.plane` are there for the rare behaviour that is only meaningful in one.

### The corner case worth knowing about

An extruded prism can hand back a contact normal that leans out of the plane — a circle resting on
the corner of a rect is the clearest case. Resolving along it would push the body off the plane,
where the snap drags it straight back, once per step, forever: a body that visibly buzzes while
resting. Projecting and renormalising the normal is what avoids it, and renormalising is not
optional — a shortened normal under-resolves the contact by the same factor, so the body sinks a
little further every step.

A normal that is *entirely* along the depth axis is dropped. In a world where depth is not gameplay,
two prisms overlapping only in depth are not touching.

## Layers

Two string fields per collider: `layer` (what this is) and `mask` (what it responds to, comma
separated, or `*` for everything).

```
Player   layer: player    mask: *
Bullet   layer: bullet    mask: enemy,world
Enemy    layer: enemy     mask: *
```

Names rather than a bitmask, for two reasons: a scene file that says `layer: "player"` survives
someone inserting a layer above it, and a bitmask in a text field is unreadable in an Inspector.

Both sides must accept the other before a pair interacts. The asymmetric alternative — bullets
hit walls but walls do not hit bullets — produces contacts that resolve on one body and not the
other, which reads as tunnelling.

## Triggers

Tick **Is Trigger** and the collider reports overlaps and pushes nothing. That plus
`onTriggerEnter` is the whole of checkpoints, pickups and damage volumes. The **Trigger Volume**
prefab ships with the script that reads it, because a trigger with no handler anywhere is
indistinguishable from a broken one.

Only the entering and leaving edges are reported. "Still inside the trigger" is a question a
script can answer with `physics.overlapSphere`, and firing it every frame would turn every
checkpoint into sixty events a second.

## Characters

A `CharacterController` is **kinematic** — it writes its transform directly rather than being
pushed around by forces — which is the same choice Unity's `CharacterController` and Godot's
`CharacterBody3D` make, and for the same reason: a player driven by forces feels like a shopping
trolley. Instant stops, air control and a jump that reaches a chosen height are all things a
dynamic body actively fights.

What it takes from the solver is the world. Gravity pulls it down, a downward cast finds the floor
it lands on, and its capsule is pushed back out of anything it walks into. Before v0.7.5 it was
pinned to a fixed `groundHeight` with no collision at all, which made every scene a flat plane
whatever was actually built in it.

The fields worth knowing: `useGravity` (off restores the old flat behaviour), `gravity`,
`jumpSpeed`, `maxFallSpeed`, `coyoteTime`, `radius`, `height`, `maxSlopeAngle`, and
`groundHeight` — now the floor of last resort rather than the mechanism, so a scene with no
colliders is still playable instead of an infinite fall.

`jumpSpeed` is a speed rather than a height because it composes: height is `v²/2g`, so halving
gravity for a floaty jump keeps the same take-off feel while doubling the arc, which is what that
dial is usually for.

**Coyote time** is the grace period after walking off a ledge during which a jump still works.
It is in every platformer that feels good: without it, players who press jump on the last frame of
the ledge — which is most of them — get nothing, and the controls feel unresponsive rather than
strict.

## What this solver does not do

**No 2D-specific solver features.** 2D here is 3D with an axis removed, which means it inherits
every limitation below — including the absence of angular dynamics, which is felt more in 2D than in
3D: a 2D game is exactly where tumbling crates are cheap and expected. It also means no 2D-only
niceties: no one-way platforms, no ledge grabs, no slope-aware ground friction.

**No angular velocity.** Contacts never spin a body. That is a real limitation and it is chosen
rather than missed: rotational response needs an inertia tensor per shape, angular impulses at
contact points and a solver that couples the two — perhaps three times the code — and the payoff
is tumbling debris. What a survival game actually needs is that characters fall, stop on floors,
slide along walls and cannot walk through rocks, all of which is linear. Bodies keep whatever
rotation the author or a script gives them.

When tumbling *is* the feature being asked for, the honest move is a real rigid-body library, not
a half-solver grown here.

**No joints, no continuous collision.** A bullet-fast body can pass through a thin wall between
two steps; the mitigations are a smaller `fixedTimestep`, a thicker collider, or a raycast instead
of a projectile.

**Capsule-versus-box is approximated.** Two refinement passes rather than a full GJK query. It is
within a fraction of a millimetre for the configurations that occur — a capsule standing on,
leaning against or wedged into a box — and the positional-correction loop absorbs the rest over
the following steps.

## Reading the simulation

The **Performance** panel (F8) breaks the frame down per system, so "11 of these 14 milliseconds
are physics" is a fact rather than something you bisect by commenting systems out. The
**Statistics** panel (F10) counts bodies and colliders along with everything else in the scene.

From a script, `physics.bodyCount` and `entity.body.sleeping` are usually enough to answer "is
this thing actually being simulated".
