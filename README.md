# Web 3D Scene Editor

A browser-based 3D scene editor and the core of a web game engine. Scenes authored here are
*played* by the same code that drew them — the engine is a standalone, UI-free library and the
editor is one consumer of it.

Press **Play** and the scene runs: the camera becomes the scene's own, scripts tick, the
character walks and the zombies notice.

Press **F2** and it takes instructions: the built-in assistant authors scenes through the same
tool layer an external MCP client can drive it with.

Press **F9** and it takes a controller: an Arduino on the end of a USB cable becomes an analog
steering axis, and the player's health dims an LED on the desk.

Add a **Collider** and things fall: gravity, contacts, friction, triggers and raycasts, from a
solver that ships in the engine rather than in a dependency — and set `Physics.mode` to **2D** and
the same solver becomes a side-scroller, because 2D here is a constraint on one engine rather than a
second one.

Add a **Scatter Layer** and a hundred thousand trees are one row in the Hierarchy and one draw
call — because a 25 km world cannot afford them as anything else.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design and §9 for what the 25 km × 25 km
open-world target forces us to decide up front, [docs/SCRIPTING.md](./docs/SCRIPTING.md) for
the script API, [docs/AI.md](./docs/AI.md) for the tools and MCP,
[docs/HARDWARE.md](./docs/HARDWARE.md) for external hardware,
[docs/SCATTER.md](./docs/SCATTER.md) for mass instancing,
[docs/PHYSICS.md](./docs/PHYSICS.md) for gravity, collision and 2D,
[docs/ECS.md](./docs/ECS.md) for queries and system scheduling,
[docs/PBR.md](./docs/PBR.md) for materials and environment lighting,
[docs/LIGHTING.md](./docs/LIGHTING.md) for the light model, and
[docs/GRAPHICS.md](./docs/GRAPHICS.md) for the render pipeline and quality settings.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Typecheck, then production build to `dist/` |
| `npm test` | Vitest — engine core, undo/redo, and the architecture boundary check |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check` | Typecheck + tests |
| `npm run mcp` | Bridge an MCP client into the running editor (needs `npm run dev`) |

## Authoring

**3D primitives** — Box, Sphere, Icosphere, Plane, Cylinder, Capsule, Cone, Torus, Tube, Wedge,
and Empty (transform only, for grouping). Added from the toolbar's *Add* menu; they land where
the viewport camera is looking. Each generates an editable **quad mesh** with segment controls,
not a fixed triangle blob.

Torus is the cleanest topology of the set — every vertex has valence four and there are no
poles — which makes it the shape to reach for when checking whether a modifier misbehaves.
Icosphere exists alongside the UV sphere because its triangles are near-uniform everywhere,
where a UV sphere crowds vertices at the poles and stretches them at the equator. Wedge is
there because ramps are the second thing anyone blocks a level out with.

**2D shapes** — Circle, Ellipse, Rectangle (with corner rounding), Polygon, Star, Arc, Ring and
Gear. Flat profiles lying in the XZ plane, in the *Add ▾* menu under **2D**.

They are ordinary primitives rather than a separate kind of object, so the material, the
modifier stack, the serializer and the Inspector all already work on them. Usually a 2D shape is
a step on the way to a solid: **Extrude** it into a badge or a column, **Lathe** it into a
torus, a vase or a spring. A building footprint drawn as a Rectangle and extruded is the same
pipeline as a Star extruded with a twist.

**Modifier stack** — non-destructive, reorderable, evaluated over the generated mesh:

| Modifier | What it does |
| --- | --- |
| Subdivide | Full Catmull-Clark, up to 4 levels, with correct open-mesh and corner rules |
| Bevel | Rounds every edge by insetting faces and bridging the gaps, 1–6 segments |
| Extrude | Pushes a profile into a solid, along any axis, with steps, taper and twist |
| Lathe | Revolves a profile around an axis — plus a rise, which makes screws and springs |
| Inset Faces | Shrinks every face inside its own border with mitred corners, and bridges the gap |
| Transform | Moves, rotates and scales the mesh *inside* the stack, where it changes what comes next |
| Mirror | Reflects across X/Y/Z, welding the seam so it stays one smooth surface |
| Array | Repeats with relative and constant offsets |
| Solidify | Gives a surface thickness, closing open borders with rim faces |
| Twist / Bend / Taper | Deformers, parameterised against the object's own bounds |
| Noise Displace | Deterministic, position-hashed so welded seams do not tear |
| Weld | Merges vertices by distance — closes seams other modifiers leave split |
| Triangulate | Splits n-gons into triangles as real topology, not just at render time |
| Shade Smooth / Flat | Overrides per-face shading for the whole mesh |

Bevel is the one that makes rendered geometry stop looking like programmer art: real objects
have no perfectly sharp edges, and a bevel is what gives them a highlight to catch.

Extrude and Lathe both sweep the mesh's **border**, so they need an open surface — a 2D shape,
or anything else with a hole in it. A closed solid has no border and passes through untouched;
the operation people usually want there is Solidify.

Transform looks redundant next to the object's own transform and is not, because position in
the stack is the whole point. Lathe spins the profile around the *object origin*, so the only
way to set the radius of the resulting ring is to move the profile off the axis first — and
doing that with the entity transform would move the finished ring instead. A Circle, a Transform
of 1 along X, and a Lathe is a torus.

Order matters and is editable — Mirror then Array tiles a mirrored pair, Array then Mirror
mirrors a whole row. Each entry toggles on and off without being removed, and the evaluated
vertex/face/triangle count is shown live so you can see what a modifier costs before keeping
it.

**Viewport shading** — Shaded, Shaded + Wireframe, or Wireframe. Wireframe is how you actually
see what subdivision did to the topology.

**Layout** — three docks around the viewport, nothing floating over it. Hierarchy on the left,
Inspector and Assistant sharing a tabbed dock on the right, and Console, Performance, Statistics,
Graphics, Audio and Hardware sharing a tabbed dock along the bottom. Every dock is resizable by dragging the
divider — or by focusing it and using the arrow keys — collapsible from the arrow in its tab
strip, and remembered per browser. Widths are re-fitted whenever the window changes size, so a
layout saved on a large monitor opens on a laptop with the docks shrunk rather than with no
viewport left.

The **status bar** along the bottom is the index: one toggle per panel, an error count on the
Console when there is one, and a live fps readout with the selection and object counts. Nothing
in the editor is reachable only by knowing a function key exists.

**Transform tools** — Unity's hotkeys and gizmos.

| Key | Tool | | Key | Action |
| --- | --- | --- | --- | --- |
| `Q` | Select | | `F` | Frame selection |
| `W` | Move | | `X` | Toggle Local / Global |
| `E` | Rotate | | `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo |
| `R` | Scale | | `Ctrl+D` | Duplicate |
| `Del` | Delete | | `Ctrl+G` | Group selected |
| `Esc` | Deselect | | `Ctrl+A` | Select all |
| | | | `Ctrl+S` | Save to local storage |

Panel keys work in both edit and play mode. Pressing one brings that panel frontmost; pressing
it again collapses its dock.

| Key | Panel | | Key | Panel |
| --- | --- | --- | --- | --- |
| `F3` | Hierarchy | | `F7` | Graphics |
| `F6` | Inspector | | `F8` | Performance |
| `F2` | Assistant | | `F9` | Hardware |
| `F4` | Console | | `F10` | Statistics |
| `F1` | Audio | | | |

`F1` rather than the next free function key: `F5`, `F11` and `F12` are reload, fullscreen and
devtools, and the handler calls `preventDefault`. Taking fullscreen away from a 3D editor to
save a keystroke is a bad trade; browser help is not.

Coloured axis handles (X red, Y green, Z blue), rotation rings, scale boxes with a centre
handle for uniform scale. Local/Global space toggle. Grid snapping for move and angle snapping
for rotate, both toggleable with configurable increments. Multi-select transforms rigidly
around the selection centre.

Camera: orbit with left-drag, pan with middle/right-drag, zoom with scroll.

**Hierarchy** — tree view with parent/child nesting. Drag a row onto another to reparent;
drag onto a row's top or bottom edge to reorder among siblings. Double-click to rename.
Click, `Ctrl+click` and `Shift+click` for single, toggle and range selection. Right-click for
Rename / Duplicate / Group / Delete.

**Inspector** — Position, Rotation (Euler degrees) and Scale, two-way synced with the gizmo:
drag in the viewport and the numbers follow, type a number and the object moves. Per-primitive
geometry parameters (dimensions, segment counts). A full PBR **Material**: base colour, rendering
mode (Opaque / Transparent / Cutout), alpha, metallic and roughness; seven texture slots with
tiling and offset; emission; and the clearcoat, sheen, transmission and specular lobes for car
paint, cloth and glass — see [docs/PBR.md](./docs/PBR.md). Multi-selection edits apply to
everything selected, with fields that disagree shown as mixed.

**Undo/redo** — every operation, via the command pattern. A gizmo drag or a burst of typing
collapses into one history entry; deleting a parent restores its whole subtree, in its original
sibling position, on undo.

**Save/load** — autosaves to browser local storage and restores on reload. *Export* downloads
the scene as JSON; *Import* reads one back.

**Performance panel (`F8`)** — fps, median and p95 frame time, JavaScript vs GPU-bound verdict,
draw calls, triangles and resource counts. Comes with two stress presets — *forest* (many
instances of few meshes) and *city* (many unique meshes) — plus live sliders for density, mesh
variety, render distance, instancing, resolution scale and shadows.

This is how the engine's performance budget gets decided: run it on the device you actually
target, move one slider at a time, and record where the frame budget breaks. See
[ARCHITECTURE.md §9.7](./ARCHITECTURE.md).

## The scene renders itself

Three components describe how a scene looks, rather than the editor deciding for it. That is
what makes the editor viewport and a shipped game agree: the runtime reads the same components
and is told nothing.

| Component | What it does |
| --- | --- |
| **Camera** | fov, clip planes, and which one Play mode looks through. First primary camera wins |
| **Light** | Directional, Point or Spot, with colour, intensity, range, cone and shadow controls |
| **Environment** | Gradient sky or flat colour, ambient light, linear or exponential fog, and the environment map the PBR materials reflect |

Lights and cameras aim along their entity's **-Z**, the same way a Three.js camera does — so a
camera parented behind a character needs no rotation of its own to look where the character
looks, and rotating a sun moves its shadows.

Both render nothing on their own, so the viewport draws a handle for each one; the handle is also
what you click to select it. They disappear in Play mode along with the grid, the gizmo and the
selection outline. The built-in lighting rig stays out of the way the moment a scene adds a Light
of its own.

## Graphics settings

Press **F7**, or the *Graphics* button in the toolbar. Antialiasing, shadow quality and filter,
tone mapping and exposure, render scale, pixel-ratio cap and anisotropic filtering — every one of
them changeable while the scene is running, with no reload and no lost GL context.

| Setting | Options | What it costs |
| --- | --- | --- |
| **Antialiasing** | Off, FXAA, MSAA 2× / 4× / 8× | FXAA is one fullscreen pass; MSAA is memory bandwidth per sample |
| **Shadows** | Off, 512 → 4096, with Hard / PCF / Soft (VSM) filtering | Map size is VRAM; the filter is fill |
| **Shadow distance** | 5–200 m half-extent | Free — and halving it sharpens shadows as much as doubling the map |
| **Shadow lights** | None, 1–12, or no limit | A multiplier on the whole frame: each caster is another render of the scene |
| **Tone mapping** | None, Linear, Reinhard, Cineon, Neutral, ACES | Effectively free |
| **Render scale** | 25–100% | Quadratic. The strongest lever in a browser |
| **Pixel ratio cap** | ≤ 1× – 3× | Quadratic, and the first thing to reach for on a phone |
| **Anisotropy** | Off – 16× | Cheap, and it is what stops a floor turning to mush in the distance |

These are stored per browser, not per scene. How sharp your shadows are is a property of the
machine you are sitting at; what colour the sky is belongs to the scene, and lives in the
Environment component. Opening a colleague's scene should not try to run at their 8× MSAA.

Antialiasing being changeable at all is the part worth explaining. The obvious way to get MSAA in
WebGL is the context's `antialias` flag, which is fixed the moment the context is created — a
settings menu built on it can only say *restart to apply*. So the frame is drawn into an offscreen
multisampled buffer instead and resolved to the canvas, which makes the sample count an ordinary
runtime value and hands us the intermediate image FXAA and tone mapping need anyway.

See [docs/GRAPHICS.md](./docs/GRAPHICS.md) for the pipeline and the colour-space rules that go
with it, and [docs/LIGHTING.md](./docs/LIGHTING.md) for the light model those settings draw.

## Measuring it

Two panels, answering two different questions.

**Performance** (**F8**) answers *is this frame fast enough*. Median, p95, p99, worst — and the
1% and 0.1% lows, which are the numbers that decide whether a run *feels* smooth. A scene
averaging 60 fps whose worst percent drops to 22 stutters several times a second, and no average
will ever say so. Beside them: a frame-time graph, a hitch count, and a per-system breakdown, so
"11 of these 14 milliseconds are physics" is a fact rather than something you find by commenting
systems out. The stress-scene harness and the two strongest quality levers sit in the same panel.

**Statistics** (**F10**) answers *what in here is expensive*. Triangles split by where they come
from — meshes, scatter instances, hidden geometry, and the shadow pass, which re-submits every
caster once per shadow-casting light and is routinely the largest of the four. Object counts by
component type, unique geometries and materials against total draw calls, nesting depth, the light
census with the shadow budget, and a table of the heaviest objects in the scene that selects one
when you click it.

`renderer.info` already reported triangles and draw calls, and they were the two least actionable
numbers available: "1.4M triangles" tells you the scene is heavy, not that 1.1M of them are one
over-subdivided rock you duplicated forty times.

Every number in both panels is measured against the **wall clock**, not against the delta the
simulation was handed. That is a distinction with teeth, and until v0.7.9.5 it was the wrong way
round: the loop clamps its own delta at 100 ms so a backgrounded tab cannot teleport the physics,
and it scales that delta for slow motion — so a counter reading it reported the clamp instead of
the machine. A 250 ms hitch arrived as exactly 100 ms, which put a floor of 10 fps under the "min"
and the 1% low and hid the hitch from the count that exists to find it. The two deltas are now
separate all the way from `Clock` to `FrameStats`, which is also why the counter keeps reading 60
while the game is paused and does not double when you halve the time scale.

The fps chip in the status bar toggles a **viewport overlay** with the same headline numbers and
the frame graph. It is the one thing allowed to sit over the canvas, and it earns it by being
needed exactly when every dock is either closed or in the way: while you are playing.

## Scatter

Add a **Scatter Layer** from the *Game ▾* menu and you get a shrub and two hundred copies of it.
One entity in the Hierarchy, one draw call — not two hundred of either. That is the whole feature,
and it is the reason the format was reserved in the schema two versions before the brush existed
([ARCHITECTURE.md §9.3](./ARCHITECTURE.md)): at 25 km × 25 km, painted vegetation cannot be one
entity per instance in memory, in the panel, or in the frame budget.

**Prototypes are entities.** The thing you scatter is an ordinary object in the scene — select it,
recolour it, push a Bevel onto its modifier stack, and every instance follows, because the batch
borrows its geometry through the same refcounted cache a normal mesh uses. Several prototypes with
relative weights give a wood that is nine parts pine and one part birch.

**The layer is a seed, not a million transforms.** Area, density, scale range and seed live on the
component; press *Scatter* and the brush fills the packed buffers from them. A saved layer is a
couple of hundred bytes until you re-roll it, and re-opening the scene reproduces exactly the
forest you left. *Re-roll* bumps the seed, *Clear* empties it, and the Inspector shows what the
current settings **would** place before you press anything — which matters when one keystroke on
the density field is the difference between two hundred instances and two hundred thousand.

| Setting | What it does |
| --- | --- |
| Shape | `Rect` (extent X × Z) or `Disc` (extent X is the radius) |
| Per 100 m² | Density. 4 is a sparse wood, 40 is undergrowth |
| Max | Hard cap, applied after density. A mistyped density is otherwise an allocation failure |
| Seed | Change it to re-roll the same settings into a different layout |
| Min / Max Scale | Per-instance uniform scale range |
| Random Yaw | Rotate each instance about Y. Off for anything with a front |
| Cast Shadows | **Off by default** — shadow-casting a hundred thousand instances is the fastest way to turn a forest into a slideshow |

Clicking any instance selects the layer, which is the honest answer to clicking a forest: there is
no per-instance selection, because the instances are buffer entries rather than objects.

The assistant and MCP clients reach the same thing through `scatter_instances`, which exists
partly so a model asked to "fill the clearing with trees" writes one layer instead of ten thousand
`create_primitive` calls.

Full reference in [docs/SCATTER.md](./docs/SCATTER.md), including the wire format and what the
brush deliberately does not do yet.

## Play mode

**Play** snapshots the scene, renders through the scene's own camera, and runs five systems:
hardware, physics, scripts, the character controller, and the NPC agents — in that order, which
since v0.7.6 each system *declares* rather than inheriting from the order it was installed in
(`engine/ecs/Schedule.ts`, and the Performance panel lists the result). **Stop** (or `Esc`)
restores the snapshot exactly — positions, spawned entities, health, velocities, script state, all
of it.

| Key | Action |
| --- | --- |
| `W` `S` / `↑` `↓` | Walk forward and back |
| `A` `D` | Strafe |
| `←` `→` or `Q` `E` | Turn |
| `Space` | Jump |
| `Shift` | Sprint |
| `Esc` | Stop and restore |
| `Ctrl+P` | Pause — freeze the clock without leaving Play |
| `F9` | Hardware panel — live channel values, while playing |

**Pause and time scale** sit next to the Play button and only exist while playing. Pause
(`Ctrl+P`) freezes the clock without stopping the frame: the viewport keeps rendering, input and
the hardware pump keep running, and scripts keep ticking with a `dt` of zero — which is what
makes a pause menu something a script can write rather than something the engine has to provide.
The speed menu runs the simulation between a tenth and four times real time; physics, scripts and
animation all follow it, and the frame counter deliberately does not (see below). Both are
readable and writable from a script as `time.paused` and `time.scale`, both are shown in the
status bar whenever they are not at rest, and both are reset when a play session ends — a script
that dropped into slow motion for a death animation must not follow you back into edit mode.

In an **XY 2D** scene there is no forward and no yaw, so the controls collapse to one axis:
`←`/`→` and `A`/`D` both walk, W and S do nothing, `Space` still jumps, and the character faces
whichever way it is going. An **XZ 2D** scene keeps the 3D controls exactly — its plane is the
ground plane they already worked in.

**Physics** — a `Collider` gives an entity a shape the solver sees (box, sphere, capsule, an
infinite plane, or the 2D circle and rect) and a `RigidBody` makes it move. Gravity, contacts with
friction and restitution, triggers, layers, sleeping, raycasts and overlap queries — in two
dimensions or three, from one solver. A scene-wide `Physics` component holds
gravity and the fixed timestep, and a scene without one simulates with Earth defaults so gravity
works the moment you add a body. Linear only — contacts never spin anything, which is a choice
argued out in [docs/PHYSICS.md](./docs/PHYSICS.md).

**Scripting** — a `Script` component runs JavaScript on its entity, and an entity may carry
several: each is its own behaviour with its own state, running in the order of its **Order**
field. Eleven hooks — `start`, `update(dt)`, `fixedUpdate(dt)`, `lateUpdate(dt)`, the four
collision and trigger callbacks, `onMessage`, `destroy` — and an API for the entity, the scene,
input, time and timers, physics queries, gameplay state, maths helpers, hardware, audio and the
console.
Scripts talk to each other through `scene.send` and `scene.broadcast`, which is what makes several
behaviours on one object compose rather than merely coexist. Editing the source while playing
reloads that behaviour on the next frame. A script that throws is reported to the console and
parked; the rest keep running. Full reference in [docs/SCRIPTING.md](./docs/SCRIPTING.md),
including an honest account of what the sandbox does and does not protect.

**NPCs** — an `NpcAgent` component gives an entity a faction, senses and speeds; the NpcSystem
runs the state machine over them: idle → wander → chase → attack, or flee for the things that
run. Three archetypes (Zombie, Villager, Animal) are presets, not behaviour — every field stays
editable. Wander is seeded per entity, so a crowd is deterministic and testable rather than
merely random.

**Characters** — a `CharacterController` is the player-driven entity: kinematic, so stopping is
instant and a jump reaches a chosen height, but collided against the world by depenetration
rather than by force. It falls, lands, walks up slopes, stops at walls and jumps with coyote time.
A Camera parented to it is the whole third-person rig; the transform hierarchy does the
following.

**Audio** — an `AudioSource` component plays ambience tied to an object: autoplay starts it the
moment Play begins, and it stops itself when the component is disabled, removed, or the entity is
deleted, so nothing outlives its object by accident. `spatial` panners and attenuates it from the
object's position; turn it off for a sound that should read the same everywhere, like a piece of
score. Everything more particular — a hit, a footstep, a game-over sting — goes through the
script API instead: `audio.play(clip, { position, loop, bus })`, `audio.music(clip, { fadeSeconds
})` for a crossfading track, or `entity.playSound(clip)` for the common case of "at this object".
Three buses (`music`, `sfx`, `ambient`) each fade independently, under one master volume and mute.
Every voice — component-driven or script-started — goes silent the moment Play stops, the same
promise §6 makes for everything else a session accumulates.

The **Audio panel** (`F1`) is the mixer in front of all that: master volume, mute, a fader per
bus, and what the engine is actually doing — voices in flight, clips decoded, whether the browser
is holding the context suspended until someone clicks, and every `AudioSource` in the scene with
the entity it belongs to. Levels are not persisted, because how loud the score sits under the
effects is a property of the game and not of the machine you are building it on. Balancing a mix
by editing a script and pressing Play was the only way to do it until v0.7.9.5, and mixing is the
most iterative thing in a game.

**Save games** — the toolbar's *Save Game* and *Load Game* buttons, live only while playing. This
is not the scene *Save*/*Load* pair from the Authoring section above — that autosaves what you
*authored*; this remembers what you were *playing*: health, factions, script variables, and every
entity exactly where it stood. Loading does not change whether you are in Play or Edit mode, and
it does not restart NPC or script behaviour — a loaded save resumes, it does not reboot.

**Console** (**F4**) — script output and combat events, with the entity attached: click a
message to select whatever produced it. Filter by level, or search the text; an error opens the
panel if the bottom dock is closed, and otherwise shows as a count on the tab.

Add any of it from the toolbar's **Game ▾** menu: Player, Zombie, Villager, Animal, Camera, the
five light types, Environment, Physics, a Ground Plane with its collider, a Rigid Box that falls
and reports its landing, a Trigger Volume with the script that reads it, a Game Logic object
carrying an example spawner script, or a Hardware Rig carrying the default bindings.

## AI integration

The editor can be driven by a model, and by *your* model. Both go through one tool layer
(`engine/assistant`), so the schemas, the validation and the undo behaviour exist once.

**Assistant** (**F2**, a tab in the right dock beside the Inspector) — ask for scene changes in plain language and Claude calls the
tools: twenty of them, covering primitives, prefabs, transforms, hierarchy, components,
scripts, the modifier stack and scatter layers. It needs an Anthropic API key, entered in the panel and kept in
`localStorage`; there is no backend to proxy through, so the key is yours and goes straight from
the browser to the API. Fine for a developer tool, wrong for a shipped product.

**MCP server** — the same tools, published over the Model Context Protocol, so Claude Code or
Claude Desktop can build in the running editor:

```bash
npm run dev                                                # editor open in a browser
claude mcp add scene-editor -- node tools/mcp-bridge.mjs
```

There is no second server and no extra port. The bridge speaks Vite's own HMR socket, which
already runs between the dev server and the page — which also means the MCP channel is dev-only,
on purpose.

**Every edit lands on the undo stack.** The tools never touch the `Scene` directly; they go
through a `SceneEditor` interface that the editor implements with commands, so one tool call is
one Ctrl+Z however many steps it took. The same interface has a direct implementation with no
undo, which is what a headless runtime and the tests use.

**Arguments are validated before anything is written**, and a wrong one comes back as a sentence
the model can act on — `Box has no parameter "size". It takes: width, height, depth, …` — rather
than a silently mis-sized box. Component, modifier and primitive lists are read out of the same
registries the Inspector builds from, so a component added tomorrow is discoverable with no edit
to the tool layer.

Full reference, including how to add a tool and what the sandbox does *not* protect, in
[docs/AI.md](./docs/AI.md).

## External hardware

An Arduino can drive a scene, and a scene can drive it back. Press **F9** for the hardware panel.

**Connecting** — **USB Serial** over Web Serial (Chrome and Edge, from a click), **Bluetooth** over
Web Bluetooth for a board with no cable, **WebSocket** for a networked board or a bridge process,
or **Simulated**: a board made of sliders, so the bindings can be built and tested before any
hardware arrives. The simulated boards come in profiles — a 10-bit Uno, a 12-bit ESP32, one that
is all buttons — because a binding written against a 1023-scale ADC is not the binding an ESP32
needs, and finding that out when the post arrives is the wrong time.

**Watching it** — the panel carries a serial monitor and a plotter. The monitor is the raw line
traffic in both directions, which is the first thing you want when a rig has gone quiet and the
second thing you want when a binding is firing and nothing is moving. The plotter graphs any
channel over time, which is how you see that a stick is noisy rather than mis-scaled.

**The protocol** is lines of ASCII, both directions — `A0=512 D2=1` in, `D13=255` out — which is
a protocol you can debug with the Arduino IDE's own serial monitor and type by hand to test a
servo. Reference firmware is in [`firmware/WebGameLink`](./firmware/WebGameLink), and it is
worth reading for the rate-limiting alone: report on change, cap the rate, never `delay()`.

**Bindings** live on two components and are plain text, one per line:

```
A0 -> axis:turn bipolar deadzone=0.06     a potentiometer steers
D2 -> key:Space                           a button jumps
D13 <- health01 scale=255 rate=8          a lamp dims as the player is hurt
```

A binding to `key:Space` writes the same key state a keyboard does, so **nothing downstream can
tell the difference** — a scene built with a keyboard works with a rig plugged in, and a scene
built for a rig degrades to the keyboard when it is unplugged. Analog controls arrive as named
axes (`move`, `strafe`, `turn`) which are summed with the keys, so the character walks at a third
speed for a third of the travel: the thing keys cannot do.

Inbound lines are applied once per frame, before any system runs, so a frame sees one consistent
snapshot of the rig and `wasPressed` means "since the last frame". Devices are never serialized —
which board is on the desk is not a property of the level.

Scripts get `hardware` for what bindings cannot express. Full reference, including the wire
format and the security note, in [docs/HARDWARE.md](./docs/HARDWARE.md).

## Scene format

Versioned, chunk-addressable JSON. A small scene is a single chunk and reads almost exactly
like a flat entity list — the loader accepts that form too. Unknown component types round-trip
untouched, so a scene saved by a newer build never loses data in an older one.

```jsonc
{
  "version": 2,
  "name": "Untitled Scene",
  "world": { "chunkSize": 256 },
  "assets": [],
  "chunks": [
    {
      "key": "0,0",
      "entities": [
        {
          "id": "e1",
          "name": "Box 1",
          "parentId": null,
          "transform": { "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1] },
          "components": [
            { "type": "MeshRenderer", "primitive": "Box", "params": { "width": 1 },
              "modifiers": [] },
            { "type": "Material", "color": "#cccccc", "alpha": 1, "mode": "Opaque" }
          ]
        }
      ]
    }
  ]
}
```

## What's next

Gameplay: NPC agents still steer by distance rather than by the solver, so they walk through each
other and through walls unless you give them colliders; angular dynamics, joints and continuous
collision are all deliberately absent, in 2D as much as in 3D (see
[docs/PHYSICS.md](./docs/PHYSICS.md)). Then line-of-sight instead of plain distance for NPC senses,
navigation around obstacles, and moving scripts and the solver into a Worker — which for scripts is
the same change as making the sandbox a real one, for physics is the reason `engine/physics` imports
neither Three.js nor the DOM, and for both is now unblocked by the schedule, since you cannot decide
what may run concurrently until the dependencies between systems are written down.

Modelling: edit mode (vertex/edge/face selection, loop cut, and extrude/inset on a *selection*
rather than on every face), editable Bézier paths so a profile can be drawn rather than picked
from the shape list, sweeping a profile along one of those paths, and Boolean — which needs
robust CSG and is deliberately not attempted yet.

Engine: adaptive quality driven by the HUD's numbers, then LOD and chunk streaming. Instancing
landed with the scatter brush; what is still missing around it is per-chunk frustum culling, LOD
chains per prototype, and a stroke-based paint mode that needs a terrain to project onto. The ECS
layer indexes and schedules but does not pack — archetype storage is the next thing to measure
before it is the next thing to build ([docs/ECS.md](./docs/ECS.md) says why in more detail).

Materials: an asset browser, so the seven texture slots can be filled by clicking rather than by
editing a scene file. Everything under them is in place; the browser is the missing half.

Audio: the same asset-browser gap, one level down — `AudioSource.clip` is a URL because there is
no audio entry in `AssetStore` yet, the way there already is for textures. The mixer itself landed
in v0.7.9.5; what it still cannot do is remember a mix, which wants the levels to live in the
scene rather than in the session.

Hardware: the Gamepad API as a third device kind — the same channel model, a different pipe —
and a serial-to-WebSocket bridge for browsers without Web Serial.

## Versions

`main` holds the stable line. Release branches mark known-good states to roll back to:

```bash
git checkout release/v0.1.0   # Phase 1 editor MVP
git checkout release/v0.2.0   # RenderHost + performance harness
git checkout release/v0.3.0   # Editable meshes + modifier stack
git checkout release/v0.4.0   # More primitives, bevel and utility modifiers
git checkout release/v0.5.0   # Scripting, NPCs and scene-owned rendering
git checkout release/v0.6.0   # 2D shapes, extrude/lathe, tessellation
git checkout release/v0.7.0   # Assistant tool layer and MCP server
git checkout release/v0.7.1   # External hardware over Web Serial and WebSocket
git checkout release/v0.7.2   # Scatter brush and instancing
git checkout release/v0.7.3   # Render pipeline rework and graphics settings
git checkout release/v0.7.4   # Dock layout, status bar and every panel moved
git checkout release/v0.7.5   # Physics, multi-script objects, better lights
git checkout release/v0.7.6   # ECS, one solver for two dimensions, real PBR
git checkout release/v0.7.7   # Save-game system and a Web Audio engine
```

v0.7.0 added the assistant tool layer and the MCP server. It needed **no schema change and no
engine changes** beyond a new directory: the tools are a consumer of the scene model, not an
extension of it, and the one thing they needed from the editor — undo — was already an interface
away. Scenes are unaffected in both directions.

v0.7.1 added external hardware. Also no schema change: two new components, which round-trip like
any other, and a bus beside `input` on the Engine.

v0.7.2 connected `ScatterLayer` and fixed six bugs. The component had been in the registry since
Phase 1 with nothing reading it — the format was fixed early on purpose, and the brush that fills
it is what v0.7.2 added. Still **no schema change**: the new brush settings are additive fields on
a component that already round-tripped, and the packed instance buffers are strings.

The bugs, all found by reading rather than by a failing test, and each now covered by one:

- **Hiding an object did not stick.** The shading pass rewrote `visible` across the whole tree
  from a `userData.entityVisible` flag that nothing had ever written, so unchecking *Visible*
  worked until the next event that re-ran the pass — which is every transform change while a
  wireframe mode is on.
- **The wireframe overlay leaked a material per rebuild**, and it rebuilds on every frame of a
  gizmo drag.
- **A hardware output whose binding already named its board never went dark.** The zeroing write
  on Stop reconstructed the reference from the component's device *and* the binding's channel,
  producing `uno:uno:D13`. Keys were worse than axes for the same class of reason: a button held
  when the USB cable came out stayed held forever.
- **Redoing a duplicate minted new entity ids**, so anything later in the redo stack — the move
  you made right after duplicating — silently applied to nothing.
- **Lowering `maxHealth` mid-play left health above it**, and `health01` above 1, which drove a
  lamp binding past its own maximum.
- **Save, Load and Import ran during Play mode.** Saving autosaved the running simulation over
  the authored scene; loading was discarded outright the moment you pressed Stop, because Stop
  restores the snapshot taken before it. Those four buttons now say why they are off.

v0.7.3 reworked the render pipeline and added the graphics settings above. **No
schema change** again: the settings are per-browser and never touch a scene file, and the one new
component field — a light's normal bias — is optional and defaulted by its reader, so scenes saved
before it round-trip unchanged.

The rework is one structural change and four fixes. The structural change is that the frame is no
longer always drawn straight to the canvas: when antialiasing is on it goes through an offscreen
buffer that is resolved, tone mapped and encoded in a final pass. That is what makes MSAA a
runtime setting rather than a reload, and it is where tone mapping had to move to — Three applies
`toneMapping` and the sRGB encode only when it is drawing to the canvas, so the moment a render
target is involved the last pass owns both.

The fixes:

- **The sky and the ground grid were rendered in the wrong colour space.** Both are custom
  shaders, and `Color.set('#3f6fb5')` converts an authored sRGB value into the linear working
  space — so writing it out untouched handed the framebuffer linear numbers the display then read
  as sRGB. Everything drawn by a built-in material was correct; those two came out visibly dark
  and desaturated, and the further a colour was from grey the worse it looked. Three's own
  materials end with the tone-mapping and colour-space chunks; a `ShaderMaterial` has to ask.
- **The renderer asked for a deprecated shadow filter.** Three removed `PCFSoftShadowMap`;
  `WebGLShadowMap` now warns on the first shadow render and rewrites the type to plain PCF. So
  shadows were never the filter the code requested, and the console said so every time. Soft
  shadows are variance shadow mapping now, which is a filter that still exists.
- **Hiding a scatter layer did not survive a shading pass.** Exactly the v0.7.2 bug above, in the
  one place that had been missed: an `InstancedMesh` is a mesh as far as the pass is concerned,
  but the batches never recorded `entityVisible`. Hiding a forest worked until you left wireframe
  mode, at which point ten thousand trees came back with no way to hide them again.
- **Shadow acne had only one dial.** Depth bias alone can only trade acne for peter-panning — push
  it far enough to clean up a sphere and contact shadows detach from what casts them. Lights now
  carry a normal bias too, which scales the correction with how obliquely the light hits.

The resolution and shadow levers that used to live in the perf HUD moved into the settings the
Graphics panel writes. They had been a second source of truth for values the renderer also held,
and whichever was touched last won.

### v0.7.4 — the UI revamp

This version moves every panel and rewrites the shell around them. **No schema change, no engine
changes:** nothing here touches the scene model, the components or the renderer. A scene saved by
v0.7.3 opens unchanged, and the only new persisted value is the dock layout, which lives beside
the graphics settings in `localStorage` and never enters a scene file.

The problem was structural rather than cosmetic. Two panels were docked; the other five were
absolutely positioned over the canvas at fixed offsets — Graphics at `left: 10px`, Hardware also
at the left edge, Performance at `right: 10px`, the Assistant also at the right, and the Console
across the bottom. Any two of them open at once overlapped. Each had its own `visible` flag, its
own header and its own close button, and their toggle buttons sat on the viewport's bottom edge
where they collided with the camera hint and with each other. The Performance panel had no button
at all: it opened only if you knew `F8` existed. A 3D editor whose UI covers the 3D is answering
the wrong question.

What replaced it:

- **Three docks, no overlays.** Hierarchy left; Inspector and Assistant sharing a tabbed dock
  right; Console, Performance, Graphics and Hardware sharing a tabbed dock along the bottom. A
  dock takes space from the viewport rather than covering it, and shows one panel at a time.
- **Resizable and remembered.** Every divider drags, and is a focusable `separator` with arrow-key
  support so the sizes are reachable without a mouse. Sizes are clamped against the window on
  every write, so a layout saved on a large monitor opens on a laptop with the docks shrunk
  instead of with no viewport left.
- **A status bar.** One toggle per panel, an error count on the Console, and a live fps readout
  beside the selection and object counts. The frame rate used to be inside the Performance panel,
  which meant the cheapest question in the editor — is this still running at speed? — cost opening
  a panel that covered the thing you were asking about.
- **One description of the panels.** `editor/state/layout.ts` names every panel, its dock, its
  icon and its shortcut; the tab strips, the status bar and the keyboard handler are all built
  from it. `useShortcuts` had a branch per panel duplicated across its edit- and play-mode paths,
  which is why the panel keys behaved differently in the two modes.
- **Panels that are not frontmost are unmounted.** The Hardware panel re-renders at 15 Hz off the
  engine's frame event and the Performance panel polls the render loop four times a second; under
  the old scheme both ran for as long as the panel was open, which was easy to leave true for a
  whole session.

Three things came out of the move rather than being the point of it:

- **The simulated hardware rig moved into `EditorContext`.** It had been held in panel state,
  which stops working the moment the panel is a tab that unmounts: the rig would be forgotten
  while you looked at the Console, leaving its device in the bus with nothing draining its
  outbound queue, and the next *+ Simulated* would add a second board beside it.
- **An error no longer yanks the bottom dock.** It opens the Console if the dock is closed, and
  otherwise shows a count on the tab. The old flag was unconditional, which was harmless when the
  console was its own overlay and would have made the dock unusable under a script that throws
  every frame.
- **Console filtering and Hierarchy search.** Both are the reason their panels' limits are
  livable — 200 messages with nothing but a scrollbar, and a tree with no way to find one of
  three objects called *Wall*.

`Row` and `Slider` were duplicated between the Performance and Graphics panels, sharing a
stylesheet class while each kept its own copy of the components; they are now shared for real in
`panels/controls.tsx`. The stylesheet lost its per-panel sections along with the panels they
described: adding a panel should mean adding no CSS.

CI (`.github/workflows/ci.yml`) runs typecheck, tests and build on every push and pull
request. It needs GitHub Actions enabled on the repository to do anything.

### v0.7.5 — physics, and instruments to watch it with

The largest release since scripting, and the first one that adds a whole subsystem to the engine
rather than reworking one. **No schema change:** a scene saved by v0.7.4 opens unchanged, and the
new components are ordinary components — unknown ones already round-trip, so a v0.7.5 scene opened
in an older build keeps its colliders as data it does not understand rather than losing them.

**Gravity and physics.** `engine/physics` is a hand-rolled solver: sequential impulses over a fixed
timestep, the same family as Box2D and PhysX. Box, sphere, capsule and infinite-plane colliders with
a full SAT narrowphase for oriented boxes, a uniform-grid broadphase, friction and restitution,
positional correction with slop, sleeping, collision layers by name, triggers, and raycast and
overlap queries. Three components — `Collider`, `RigidBody`, `Physics` — and the smallest useful
scene needs two of them.

Hand-rolled rather than a dependency, and it is worth saying why: what the engine needs is that
characters fall, stop on floors, slide along walls and cannot walk through rocks, all of which is
*linear*. Contacts never spin a body here. Rotational response needs an inertia tensor per shape,
angular impulses at contact points and a solver that couples the two — roughly three times the
code — and the payoff is tumbling debris. When tumbling is the feature being asked for, the honest
move is a real rigid-body library, not a half-solver grown in place. The whole argument, and the
rest of the limits, are in [docs/PHYSICS.md](./docs/PHYSICS.md).

The `CharacterController` stops being a lie. It was kinematic and pinned to a fixed
`groundHeight` with no collision at all, which made every scene a flat plane whatever was built in
it. It now falls, lands on whatever is under it, walks up slopes to a configurable limit, stops at
walls, and jumps — with coyote time, because players press jump on the last frame of the ledge and
should not be punished for it. Still kinematic, deliberately: a player driven by forces feels like
a shopping trolley.

**Several scripts on one object.** Scripts were the one component that could not compose, and it
distorted scenes: a crate that floats, spins and explodes on contact became three nested entities
whose transforms had nothing to do with the structure. Each `Script` now carries a stable id and an
`order`, instances are keyed by entity *and* script, and the frame runs them sorted — because a
camera script that follows a character has to run after the movement script or it tracks where the
character was. Getting there meant index-addressed component operations through the whole stack:
`Scene.getComponents`/`removeComponentAt`, the undo commands, the Inspector, and the assistant's
`set_script`, which now takes a script *name*. Every one of those was a real bug first: removing
the second script deleted the first.

**Advanced scripting.** Three hooks became eleven. `fixedUpdate(dt)` fires exactly as often as the
solver stepped — asked of the physics system rather than guessed from a private accumulator, so the
two cannot drift out of phase — which is the fix for the most common physics bug there is: a force
applied once per *frame* is a force whose strength depends on the frame rate. `lateUpdate` for
follow cameras, four collision and trigger callbacks, and `onMessage` with `scene.send` /
`scene.broadcast` so behaviours on one object can talk without knowing about each other. New in
scope: `physics` (raycasts, overlaps, `explode`), `entity.body` for shoving bodies about,
`entity.grounded` and `entity.jump` that answer for a rigid body *or* a character controller,
`mathf` for the arithmetic every gameplay script otherwise rewrites, and real timers —
`time.after` and `time.every`, owned by the script instance so they die with it, which is the
behaviour people wanted from the `setTimeout` that is deliberately shadowed.

**A better lighting system.** Two new types: `Hemisphere`, which is the cheapest useful light in
the engine — no shadow pass, and it gives shaded sides a colour instead of black — and `Area`
(RectAreaLight) for softboxes and windows. Colour temperature in kelvin, normalised so the slider
changes hue and not brightness. Physical intensity units, where a point light's candela is
`lumens / 4π` and a spot's divides by its cone's solid angle, so **the same bulb in a tighter cone
is genuinely brighter** — which is how a torch works and which artistic units cannot express. Per
light: an `enabled` flag, because lighting is iterative and half of it is turning things off.

And a **shadow budget**. Every shadow-casting light is another render of the whole scene from that
light's point of view, so four casters is five renders a frame — the fastest way there is to turn a
comfortable frame into an unplayable one, and the easiest to do by accident because each light looks
free when you place it. The renderer now caps them and spends the budget per frame on the lights
that matter: explicit `shadowPriority` first, then brightness, then distance to the camera. A scene
can hold thirty torches and cost four passes. The Statistics panel reports "3 of 9", so a light
losing its shadow is visible rather than mysterious.

**An advanced FPS counter.** 1% and 0.1% lows — the average of the slowest frames, which is the
statistic that distinguishes a smooth run from a stuttering one and which no mean ever will. A
hitch count with an absolute floor, so a 144 Hz machine is not slandered by frames twice its
median. A frame-time graph, because the *shape* of a trace is the information: a flat line, a
sawtooth and a flat line with one spike a second have similar medians and feel nothing alike. And a
per-system breakdown, from `beginSection`/`endSection` around each system in the loop — "the frame
costs 14 ms" is a fact you can do nothing with, and "11 of the 14 are physics" is a plan. Plus an
opt-in viewport overlay, the one thing allowed over the canvas, because the moment you most need the
frame rate is while playing and that is exactly when every dock is in the way.

**Advanced triangle and object counts.** A new Statistics panel (**F10**) built on
`engine/perf/SceneStats`, which walks the rendered tree once and attributes every triangle to the
entity that put it there. Triangles split into meshes, scatter instances, hidden geometry, unique
triangles in memory, and the shadow pass — routinely the largest of the five, and the number that
explains why a second shadow light halved the frame rate. Objects by component type, including
types from a newer build, because a census that quietly omits what it does not recognise is a census
you cannot trust. And a table of the heaviest objects that selects one when you click it.

Three bugs the new tests found in code written for this release, all in the solver, all of the kind
only a test finds: a resting body's contact was resetting its own sleep timer so nothing ever slept
and stacks jittered forever; motion locks held against gravity but not against positional
correction, which is the less useful half of a lock; and a ray cast straight down at a box came back
with the far face's normal, pointing down through the geometry it had just hit.

### v0.7.6 — an ECS, one solver for two dimensions, and real PBR

Three subsystems, and the theme they share is that each one refuses a second implementation of
something the engine already had. **No schema change:** a scene saved by v0.7.5 opens unchanged, and
every new field is additive and defaulted by its reader, so a v0.7.6 scene opened in an older build
loses nothing it understood.

**An Entity Component System.** The data model was already entity-plus-components; what was missing
was both halves of the *system* side. `engine/ecs` adds a component index maintained off the Scene's
existing events, `all`/`any`/`none` queries resolved against it, and a scheduler that computes the
order systems tick in from constraints they declare.

Every system used to open with `for (const entity of scene.all())` and a `components.find` — which
is O(entities × components) per system per frame, so five systems over a 10 000-entity scene walk the
same ten thousand entities five times to reach the eleven that have a collider. All five now declare
a query instead, results are cached against a revision that only moves when the index's *shape*
changes (a slider drag emits `componentsChanged` sixty times a second and must not invalidate
anything), and the iteration is driven by the smallest term in the query.

It is a type index, not an archetype table, and that is a decision rather than a shortcut.
Components here are also the serialisation format, the Inspector's model and the undo system's unit
of work, and unknown types round-trip verbatim so a newer scene survives an older build — none of
which has a shape to pack into parallel arrays. The lookup is the factor-of-a-thousand and costs 200
lines; the packing is a constant factor and costs the data model. The query API is precisely the
seam that would let the packing happen later without touching a system.

The scheduler is the part that fixes a real fragility. The frame's order was the order
`installGameplaySystems` pushed things, documented by a numbered comment — and that comment was the
only thing holding it together, because hardware has to be pumped before scripts read it, the solver
has to step before scripts hear about contacts, and agents have to run after the player moved.
Insert one system in the wrong place and all of it breaks silently, looking like a one-frame input
lag rather than a scheduling bug. Systems now carry a `stage` (`input`, `simulate`, `script`,
`resolve`, `present`) and optional `after`/`before`; a dependency on an absent system is ignored
rather than fatal, so `after: ['PhysicsSystem']` does not make physics a requirement of a headless
setup; and a contradiction is **reported** on the engine and shown in the console rather than
resolved arbitrarily, because throwing inside a frame would turn a mis-ordered system into a blank
viewport. With no constraints the sort is stable and reproduces the insertion order exactly, which
is what made adopting it a refactor. The Performance panel lists the resolved order beside the
per-system cost breakdown — a computed order that cannot be inspected is worse than a hand-written
one.

**A unified 2D/3D physics engine.** `Physics.mode = '2D'` makes the whole simulation
two-dimensional. There is no second solver, no second collider hierarchy and no second raycast API.

Shipping a parallel 2D engine is the obvious move and it is what Unity did; it left that project
with two collider hierarchies, two sets of layer settings, two raycast APIs and a permanent question
about which one a component belongs to. But nothing in this solver is dimensional — circles are
spheres, rectangles are boxes, and sequential impulses do not care how many axes they run over. So
2D is four rules in one new file: bodies are held on the simulation plane, the depth axis is locked
in velocity *and* in positional correction, gravity is projected into the plane, and contact normals
and query directions are projected and renormalised. Every one is the identity in 3D, so scenes that
do not use it pay nothing, and `collision.ts` gained not a line.

The payoff is that every feature reaches both dimensions at once. Triggers, layers, sleeping,
restitution, the character controller, the script API and `explode` have no 2D variant to write
because none of them knows which mode it is in. Two new collider shapes — `Circle` and `Rect` — are
not new primitives either: they resolve to a capsule and a box extruded along the depth axis, so
their cross-section in the plane is exactly a circle and exactly a rectangle. Extruded rather than
flat on purpose, because a 2D layer inside a 3D scene has bodies that are only approximately
coplanar and the Z a sprite happened to be authored at should stop mattering.

Two planes, and the second one is nearly free: `XY` is the side-scroller, where default gravity
still falls down; `XZ` is the top-down game, where gravity points along the axis that is not
simulated and the projection makes the world weightless with nothing to configure. The character
controller adapts to the first — an XY scene has no forward, so `←`/`→` and `A`/`D` both walk, W and
S do nothing, and yaw snaps to the direction of travel — and needs nothing for the second, whose
plane *is* the ground plane the 3D controls already worked in.

The subtlety the design pays for is the last rule. An extruded prism can produce a contact normal
that leans out of the plane — a circle resting on a rect's corner — and resolving along it pushes the
body off the plane, where the snap drags it straight back, once per step, forever: a body that
visibly buzzes while resting. Renormalising after the projection is not cosmetic either, since a
shortened normal under-resolves by the same factor and the body sinks a little further every step.

**A PBR material system.** The `Material` component grows from eight fields to thirty: seven texture
slots (base colour, normal, roughness, metalness, occlusion, emissive, displacement) with tiling and
offset, emission with its own intensity, and the four extension lobes — clearcoat for car paint,
sheen for cloth, transmission and IOR for glass, and a specular dial for the dielectrics that are
not 4% reflective.

The lobes are opt-in and the engine notices: a material with all four at their defaults is built as
a `MeshStandardMaterial`, and touching any of them upgrades it to `MeshPhysicalMaterial`, which
compiles all four into every fragment and — for transmission — makes the renderer keep a copy of the
framebuffer to refract through. A scene of painted crates pays none of that, and there is no shader
for an artist to remember to pick.

And the piece without which the rest is a lie: **environment lighting**. `metalness = 1` means the
base colour is the *reflection* and there is no diffuse term, so a metal with nothing to reflect
renders black however many lights are aimed at it — analytic lights only give a metal its highlight.
`Environment.ibl` prefilters the scene's own sky gradient into a PMREM environment map and assigns
it to the scene, so reflections match the background because they are generated from it rather than
from an HDR someone has to keep in step. It is on by default, because a new scene should show a
believable metal rather than a debugging exercise. The prefiltering is the load-bearing part: a rough
metal has to reflect a blurred environment, and one convolution per roughness level is what makes
`roughness` behave across its whole range instead of only at 0.

The interesting engineering is underneath, in two problems with the same shape. `AssetStore` marks
every texture sRGB because it cannot know what a texture is for, which is right for base colour and
wrong for normals, roughness, metalness and occlusion — and `repeat`/`offset` live on the texture
rather than the material in Three, so two materials tiling one asset differently cannot share a
texture object. Both are solved by each material owning a lightweight *view* of every asset it
references: a clone that shares the decoded image (Three refcounts sources, so the pixels upload
once) and carries its own colour space and uv transform.

Four bugs, three of them latent in code written before this release:

- **Releasing a material could blank a texture everywhere else it was used.** `disposeMaterial`
  disposed `material.map` — which was the `AssetStore`'s own texture, shared with every other
  material referencing that asset. It was dead code, never called, which is the only reason nobody
  had hit it; wiring up disposal properly meant fixing it first, and owning views rather than
  borrowing textures is what makes releasing a material a local operation at all.
- **A texture that finished decoding was never picked up.** Decoding is asynchronous and materials
  are built once and cached, so a material built while its image was in flight stayed untextured for
  the rest of the session — the texture appeared only if something happened to change the material's
  cache key afterwards, which reads as "textures work sometimes". `AssetStore.textureLoaded` now
  re-resolves the slots of any live material naming that asset.
- **An occlusion map would have rendered the mesh black.** Three samples `aoMap` through `uv1`, the
  glTF convention for a baked pass with its own atlas, and the engine's primitives only generate one
  UV set. The bridge now aliases `uv` under the second name — the same buffer, so no extra memory
  and no extra upload.
- **`entityRemoved` only named the root of what it removed.** Anything keeping a per-entity table had
  to scan its own keys for ids that no longer resolved, which is O(scene) on every delete. The event
  carries the whole subtree now; the render bridge had worked around it by walking its own Three.js
  tree, and the new component index would have quietly gone on reporting colliders for deleted
  children.

The material cache key also changed shape, from a delimiter-joined string to JSON of a normalised
component. With eight fields the joined form was readable; with thirty, one field inserted in the
wrong position silently shifts every value after it, which is the class of bug where materials come
out wearing another material's roughness.

Seventy-four new tests, and one of them is the reason the corner case above is documented rather
than discovered later.

### v0.7.7 — a save-game system, and the engine can make noise

**No schema change.** `AudioSource` is one more additive component, like every one before it; a
v0.7.6 scene opens unchanged, and playing it in an older build just leaves it silent.

**Audio.** `engine/audio/AudioEngine` wraps Web Audio behind the same seam `physics` and
`hardware` already sit behind on the `Engine`: three buses (`music`, `sfx`, `ambient`) each with
their own fader, plus a master volume and mute above all three; spatial sounds panned and
attenuated from a `PannerNode`, with the listener moved every frame off the primary camera's
*world* transform, not its local one; and a clip cache keyed by URL, decoded once and reused by
every subsequent `play()` for it. The `AudioContext` itself is built lazily on first use rather
than in the constructor — a browser refuses to run one until a user gesture has reached the page,
and `AudioContext` does not exist in Vitest's Node environment at all, so building it eagerly
would fail every test that touches an `Engine`, not only the audio ones. A `contextFactory`
constructor argument is the fix, the same dependency-injection seam `HardwareTransport` and
`ScenePersistence` use elsewhere, and it is what lets `AudioEngine.test.ts` drive real playback
logic — bus routing, crossfades, cancelling a sound that was stopped before it finished decoding —
against a fake Web Audio graph with no browser involved.

Scripts get it as `audio` — `audio.play(clip, { position, loop, bus })`, `audio.music(clip,
{ fadeSeconds })` for a crossfading score, `entity.playSound(clip)` for the common "at this
object's position" case — and `AudioSource` is a component for the other half: ambience that
belongs to an object for as long as the object exists, autoplaying when Play mode starts and
stopped automatically when it is disabled, removed, or the entity is deleted. Sounds are session
state exactly the way a zombie's health is (§6), so every voice — component-driven or
script-started — is silenced in `Engine.setMode` along with everything else a Play session
accumulates; leaving one playing across Stop would be the audio equivalent of the bug `GameState`
already guards health against.

**A save-game system**, and it is a genuinely different thing from the scene Save button that has
been in the toolbar since Phase 1. That one remembers what someone was *authoring*; this one
remembers what someone was *playing* — which is exactly the health, factions and script variables
`GameState` deliberately keeps outside the scene so that stopping Play can restore the authored
scene exactly (§6's "what restored has to cover"). `GameState.toJSON`/`fromJSON` serialise that
half; `gameplay/SaveGame.captureSaveGame` pairs it with a scene snapshot — `snapshotScene`, now
exported from `loop/Engine` for exactly this reuse — into one JSON-safe record, and
`restoreSaveGame` loads it back in without touching whichever mode the engine is already in,
because "load, then press Play" from a title screen is two actions, not one.

The one subtlety worth being explicit about: `fromJSON` fires a `restored` event, not `reset`.
Those have to mean different things. `reset` tells every listener — an NPC's wander state, a
script's own closures — to drop what it was doing, because Stop means the simulation is over. A
save load means the opposite: positions and health jump to the saved moment, but *behaviour*
keeps running, so a loaded save does not open with every zombie standing still for a frame while
it re-decides what to do. Getting this backwards is the kind of bug that only shows up once, on
the one save file that mattered.

The toolbar's *Save Game*/*Load Game* buttons are the mirror image of *Save*/*Load*: greyed out
in Edit mode instead of Play mode, because there is no running session to snapshot before Play
has started, and their local-storage keys live under a different prefix than the scene autosave's
so the two can never collide.

### v0.7.8 — mobile control, and four things that were quietly wrong

**No schema change.** Nothing here touches the scene format; a v0.7.6 scene opens unchanged.

**The editor works on a phone.** Not "renders on a phone" — it did that already, which was the
problem. Three separate dead ends had to be cleared, and none of them was in the same place.

The layout was the visible one. Both side docks are laid out beside the viewport, and at their
default widths they are 580px between them: on a phone in landscape, which is 844px and sounds
roomy, that leaves a 264px viewport. The editor rendered as three panels with a postage stamp of
scene between them. Below `DRAWER_BREAKPOINT` — derived, not chosen: it is the narrowest window
that fits both docks and a minimum viewport — the docks come out of flow and float over the scene
instead, and start closed. The stylesheet's mobile block and that constant make the same decision
from opposite sides and are documented to stay in step.

The gizmo was the invisible one, and it is the bug that got reported as "move, rotate and scale do
not work with the arrows". The handles were there and they were live; at the default size the
translate arrows are about 3mm wide on a phone, under half of what a fingertip can reliably hit, so
a drag aimed at the X arrow landed on the free-move handle in the middle and the object slid across
the ground plane instead of along the axis. `TransformControls.size` scales the picker geometry
along with the arrows, so a coarse pointer now gets handles it can actually hold. Tap-to-select had
the same shape of problem from the other end — the click threshold that separates a click from an
orbit drag was 4px, which a tap on glass routinely exceeds while the finger flattens — and picking
now fires a small cross of rays rather than one, because a ray through the centre of a contact patch
misses anything thin even when you are plainly touching it.

Orbit also used to yield to the gizmo one frame late. It was set once per frame in `render()`, so
the first frame of every drag had both controls live and the camera swung as the handle was picked
up; on a touch screen, where one finger drives both, that was enough to throw the whole drag off its
axis. It is set synchronously from `dragging-changed` now, with the per-frame line kept only as a
safety net for the one path that never fires it.

**Play mode has controls.** It reads WASD, the arrows, Shift and Space, none of which a phone has —
so pressing Play gave you a scene you could look at and a character you could not move. Two relative
thumb pads and two buttons now write the named analog axes (`move`, `strafe`, `turn`) that
`CharacterSystem` already read alongside the keys. **No engine code changed for this**, which is the
§9.5 boundary earning its keep: the engine never listens to the DOM, input arrives as data, and a
thumb on glass and a gamepad on the hardware bus come through the same door. A script reading
`input.getAxis('move')` cannot tell which one it got. The pads are relative — the centre is wherever
the thumb lands — because a fixed centre asks you to look at your thumb, and in a game you are
looking at the screen.

### The four bugs

- **The Statistics panel did not count most of what the frame drew.** The stress harness is added to
  the render host's scene rather than to the render bridge, and the census walked the bridge. So
  loading the Forest preset put 4,045 cones and 62,170 triangles in front of the camera and every
  number in the panel — objects, visible, unique, triangles — stayed exactly where it was. Ramping
  the density changed nothing, which is how it was found. The census takes extra roots now and
  counts them into every render-tree total, while the entity counts stay what they always were,
  because the harness owns no entities: the two halves of the panel now answer "what does this frame
  cost" and "what is in this scene", which are different questions and were being conflated. Harness
  rows are named in the heaviest table with their own flag, and are not clickable — there is nothing
  to select.

- **Moving a directional light took every shadow in the scene with it.** The shadow frustum was a
  ±`shadowRange` box centred on the *light entity's position*. A directional light has no position,
  only a direction, so dragging the sun sideways changed the shading not at all and silently walked
  the shadowed area off the geometry — shadows simply stopped existing, with no control anywhere
  that looked responsible. This is the same reason an unlit scene had shadows near the origin and
  none further out: the placeholder rig's sun had the bug too. The frustum is placed from the view
  now, pushed `range` ahead of the camera so the covered slab is not half behind the viewer, with
  only the rotation coming from the entity. The centre is quantised to whole shadow-map texels,
  without which a map that slides continuously resamples every edge every frame and the shadows
  crawl as you orbit.

- **The stress harness z-fought with authored ground.** Its ground plane sat at exactly y=0, and so
  does the ground plane of every scene authored in this editor. Two coplanar shadow-receiving
  surfaces interpenetrate, which on a shadowed surface reads as a second flickering copy of every
  shadow. The harness ground is 2mm lower now.

- **Panels could not be scrolled with a finger.** Latent rather than observed, and introduced by the
  first attempt at the fix above: `touch-action: none` on the body stops the browser claiming canvas
  drags, and also stops every dock scrolling. The canvas asks for it specifically; the scroll
  containers ask for `pan-y`.

One report is **not** fixed, because it could not be reproduced: a doubled shadow from a single
object under a single light. Two mechanisms that produce something that looks like it are fixed
above (the z-fighting ground, and the harness geometry that casts shadows no Inspector checkbox
governs). A scene file or a screenshot showing it would settle what the third is.

Thirty-eight new tests, covering the shadow frame's placement and texel snapping, the census with
geometry that belongs to no entity, the drawer breakpoint, and the stick response curve.

### v0.7.9.5 — the features that were built but not plugged in

A release with no new subsystem in it. The brief was to go looking for things the engine can do
that nothing in the editor can reach, and for bugs that had survived because they only appear
under conditions nobody hits on purpose. Both turned out to be the same shape of problem: code
that is correct in isolation and unreachable, or unreachable-*ly* wrong.

**The frame counter was measuring the wrong clock.** `Clock` produces a delta the simulation can
trust — clamped at 100 ms so a backgrounded tab cannot teleport a rigid body through a wall,
multiplied by the time scale, and zero while paused. `Engine.tick` handed that same number to
`FrameStats`, which exists to report what the *machine* did. So every frame slower than 100 ms
was recorded as exactly 100 ms: `minFps` could not go below 10 whatever happened, `stutterCount`
missed the hitches it was written to count, and the 1% low — the one statistic in the panel that
justifies the other twelve — was pinned away from the truth in precisely the situation you would
open the panel to investigate. It is a good example of a bug that is invisible until it matters:
at 60 fps the two deltas are the same number, and every number in the panel is right.

`Clock` now reports both — `tick()` for what the world advances by, `rawDelta` for how long the
frame really took — and nothing but `FrameStats` reads the second. Which is also why the counter
now keeps reading 60 while the game is paused, and does not claim to have doubled when you halve
the speed.

**The clock had no controls and no script access at all.** `pause`, `resume`, `setTimeScale`,
`getTimeScale` and `smoothDelta` had been on the Engine since v0.7.9 with not one caller: no
button, no key, no script API. Every one of them now has all three. Pause is `Ctrl+P` and a
button beside Play; the speed menu runs 0.1× to 4×; scripts read and write `time.paused` and
`time.scale` and read `time.smoothDt`. Both directions move the same value — a script that drops
into slow motion moves the toolbar's menu, because the store follows a `timeChanged` event rather
than keeping its own copy. And both reset when a play session ends, for the same reason health and
held keys do: a session that finished in slow motion must not hand a slowed editor back.

`setTimeScale` clamps to `0..8`, which it did not before. A negative scale runs the solver
backwards through collision responses written on the assumption that it does not, and past 8 a
single step at the frame cap is long enough for a fast body to pass clean through a thin one.

**The mixer existed and had no faders.** Master volume, mute and the three bus levels shipped with
the audio engine in v0.7.7, reachable only as `audio.setBusVolume('music', 0.4)` from a script —
which turns balancing a mix, the most iterative job in a game, into an edit-and-press-Play loop.
There is an **Audio panel** (`F1`) now: the faders, plus what the engine is actually doing —
voices in flight, clips decoded, whether the browser is holding the context suspended waiting for
a click, and every `AudioSource` in the scene with a row that selects its entity. The status
readout earns its place: when nothing is audible the useful question is never "is the volume up".

**Two audio bugs that could not survive a second attempt.** A voice does not exist as sound until
its clip has decoded, and everything said to it in between has to be *held* — which `volume` was,
and the other two were not.

- `playMusic(url, { fadeSeconds })` reached straight for the voice's gain node to schedule the
  ramp. On the first play of a track there is no gain node yet, so the fade was silently skipped;
  on every play afterwards the clip was cached, the node existed, and the crossfade worked. A
  crossfade that only works once the file is warm is worse than none, because reproducing the
  failure means reloading the page.
- `handle.setPosition(...)` before the decode finished was dropped on the floor, against a doc
  comment one function above promising it would be held. A script that plays a footstep and places
  it in the next statement got the sound at wherever the entity had been standing when `play` ran.

Both are now recorded on the voice and applied in `start()`, which reads the voice rather than the
`PlayOptions` it was created from — the options describe one instant, and the voice describes now.

**The status bar was keeping its own list of panels.** ARCHITECTURE §14.2 says adding a panel is
one entry in `layout.ts` plus a render case, and three consumers fall out of it. Two of them did;
the status bar had a hand-written copy beside it, which made the claim quietly false and would
have left the new Audio panel reachable by tab and by key but missing from the one row whose whole
job is to be the index of what exists. It is derived now, and a test walks every dock to keep it
that way.

Also: the README's hardware section never got v0.7.9's Bluetooth, board profiles, serial monitor
or plotter, all of which shipped and were documented only in `docs/HARDWARE.md`; the Statistics
panel's `F10` was missing from the key table; `releaseMaterial` was a wrapper nothing called; and
the page had no favicon, so every single load logged a 404 into the console — which is a good way
to teach people that the console is full of noise worth ignoring.

**No schema change.** Nothing here touches the scene format: the two new controls are session
state, the mixer is session state, and the frame counter never had any.

Twenty new tests, covering the two deltas through `Clock` and `Engine`, the script-facing clock
including the clamp and the reset on Stop, the four things a voice has to remember across the gap
between `play` returning and a clip decoding, and two invariants over the panel description — that
every dock is walked, and that no panel is bound to a key the browser needs.

## Layout

```
src/
  engine/    core — scene graph, mesh pipeline, components, ecs (component index,
             queries, system schedule), render host (PBR materials + environment
             probe), serialization, loop, physics (one solver, 2D or 3D, shapes,
             queries), scripting, AI, gameplay, input, hardware (protocol, bus,
             bindings), perf (frame stats + scene census), scatter (packed instances +
             brush) and the assistant tool layer + MCP server. No React, no DOM.
             This is what the runtime uses.
  editor/    dock layout and panels, gizmo, undo/redo, persistence, console, assistant,
             and the hardware transports (Web Serial, WebSocket). Editor only.
tools/       mcp-bridge.mjs — stdio ↔ dev server, for external MCP clients.
firmware/    WebGameLink — reference Arduino sketch for the hardware protocol.
```

`src/engine/boundary.test.ts` enforces that split.
