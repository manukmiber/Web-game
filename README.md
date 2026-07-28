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

Add a **Scatter Layer** and a hundred thousand trees are one row in the Hierarchy and one draw
call — because a 25 km world cannot afford them as anything else.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design and §9 for what the 25 km × 25 km
open-world target forces us to decide up front, [docs/SCRIPTING.md](./docs/SCRIPTING.md) for
the script API, [docs/AI.md](./docs/AI.md) for the tools and MCP,
[docs/HARDWARE.md](./docs/HARDWARE.md) for external hardware,
[docs/SCATTER.md](./docs/SCATTER.md) for mass instancing, and
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

**Transform tools** — Unity's hotkeys and gizmos.

| Key | Tool | | Key | Action |
| --- | --- | --- | --- | --- |
| `Q` | Select | | `F` | Frame selection |
| `W` | Move | | `X` | Toggle Local / Global |
| `E` | Rotate | | `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo |
| `R` | Scale | | `Ctrl+D` | Duplicate |
| `Del` | Delete | | `Ctrl+G` | Group selected |
| `F2` | Assistant | | `Ctrl+A` | Select all |
| `Esc` | Deselect | | `Ctrl+S` | Save to local storage |
| `F8` | Perf HUD | | `F9` | Hardware panel |

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
geometry parameters (dimensions, segment counts). Material with base colour, rendering mode
(Opaque / Transparent / Cutout), alpha, metallic and roughness. Multi-selection edits apply to
everything selected, with fields that disagree shown as mixed.

**Undo/redo** — every operation, via the command pattern. A gizmo drag or a burst of typing
collapses into one history entry; deleting a parent restores its whole subtree, in its original
sibling position, on undo.

**Save/load** — autosaves to browser local storage and restores on reload. *Export* downloads
the scene as JSON; *Import* reads one back.

**Performance HUD (`F8`)** — fps, median and p95 frame time, JavaScript vs GPU-bound verdict,
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
| **Environment** | Gradient sky or flat colour, ambient light, linear or exponential fog |

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
with it.

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

**Play** snapshots the scene, renders through the scene's own camera, and runs three systems:
scripts, the character controller, and the NPC agents. **Stop** (or `Esc`) restores the snapshot
exactly — positions, spawned entities, health, script state, all of it.

| Key | Action |
| --- | --- |
| `W` `S` / `↑` `↓` | Walk forward and back |
| `A` `D` | Strafe |
| `←` `→` or `Q` `E` | Turn |
| `Shift` | Sprint |
| `Esc` | Stop and restore |
| `F9` | Hardware panel — live channel values, while playing |

**Scripting** — a `Script` component runs JavaScript on its entity, with `start`, `update(dt)`
and `destroy` hooks and an API for the entity, the scene, input, time, gameplay state and the
console. Editing the source while playing reloads that behaviour on the next frame. A script
that throws is reported to the console and parked; the rest keep running. Per-entity tunables
live in `props`, which is also why twenty entities sharing a script compile it once. Full
reference in [docs/SCRIPTING.md](./docs/SCRIPTING.md), including an honest account of what the
sandbox does and does not protect.

**NPCs** — an `NpcAgent` component gives an entity a faction, senses and speeds; the NpcSystem
runs the state machine over them: idle → wander → chase → attack, or flee for the things that
run. Three archetypes (Zombie, Villager, Animal) are presets, not behaviour — every field stays
editable. Wander is seeded per entity, so a crowd is deterministic and testable rather than
merely random.

**Characters** — a `CharacterController` is the player-driven entity, kinematic and pinned to a
ground height. There is no physics yet, so it walks through walls. A Camera parented to it is the
whole third-person rig; the transform hierarchy does the following.

**Console** — script output and combat events, with the entity attached: click a message to
select whatever produced it.

Add any of it from the toolbar's **Game ▾** menu: Player, Zombie, Villager, Animal, Camera,
lights, Environment, a Game Logic object carrying an example spawner script, or a Hardware Rig
carrying the default bindings.

## AI integration

The editor can be driven by a model, and by *your* model. Both go through one tool layer
(`engine/assistant`), so the schemas, the validation and the undo behaviour exist once.

**Assistant panel** (**F2**) — ask for scene changes in plain language and Claude calls the
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

**Connecting** — **USB Serial** over Web Serial (Chrome and Edge, from a click), **WebSocket**
for a networked board or a bridge process, or **Simulated**: a board made of sliders, so the
bindings can be built and tested before any hardware arrives.

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

Gameplay: collision and gravity, which is the largest gap — agents and the character currently
walk through walls and each other. Then line-of-sight instead of plain distance for NPC senses,
navigation around obstacles, and moving scripts into a Worker, which is the same change as
making the sandbox a real one.

Modelling: edit mode (vertex/edge/face selection, loop cut, and extrude/inset on a *selection*
rather than on every face), editable Bézier paths so a profile can be drawn rather than picked
from the shape list, sweeping a profile along one of those paths, and Boolean — which needs
robust CSG and is deliberately not attempted yet.

Engine: adaptive quality driven by the HUD's numbers, then LOD and chunk streaming. Instancing
landed with the scatter brush; what is still missing around it is per-chunk frustum culling, LOD
chains per prototype, and a stroke-based paint mode that needs a terrain to project onto.

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

This version (v0.7.3) reworks the render pipeline and adds the graphics settings above. **No
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

CI (`.github/workflows/ci.yml`) runs typecheck, tests and build on every push and pull
request. It needs GitHub Actions enabled on the repository to do anything.

## Layout

```
src/
  engine/    core — scene graph, mesh pipeline, components, render host, serialization,
             loop, scripting, AI, gameplay, input, hardware (protocol, bus, bindings),
             scatter (packed instances + brush) and the assistant tool layer + MCP
             server. No React, no DOM. This is what the runtime uses.
  editor/    panels, gizmo, undo/redo, persistence, console, assistant panel, and the
             hardware transports (Web Serial, WebSocket). Editor only.
tools/       mcp-bridge.mjs — stdio ↔ dev server, for external MCP clients.
firmware/    WebGameLink — reference Arduino sketch for the hardware protocol.
```

`src/engine/boundary.test.ts` enforces that split.
