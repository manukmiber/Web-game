# Web 3D Scene Editor

A browser-based 3D scene editor and the core of a web game engine. Scenes authored here are
*played* by the same code that drew them — the engine is a standalone, UI-free library and the
editor is one consumer of it.

Press **Play** and the scene runs: the camera becomes the scene's own, scripts tick, the
character walks and the zombies notice.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design and §9 for what the 25 km × 25 km
open-world target forces us to decide up front, and [docs/SCRIPTING.md](./docs/SCRIPTING.md) for
the script API.

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
| `F2` | Rename | | `Ctrl+A` | Select all |
| `Esc` | Deselect | | `Ctrl+S` | Save to local storage |
| `F8` | Perf HUD | | | |

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
lights, Environment, or a Game Logic object carrying an example spawner script.

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

Engine: adaptive quality driven by the HUD's numbers, then instancing, LOD and chunk streaming.
`ScatterLayer` is reserved in the schema so it needs no migration.

## Versions

`main` holds the stable line. Release branches mark known-good states to roll back to:

```bash
git checkout release/v0.1.0   # Phase 1 editor MVP
git checkout release/v0.2.0   # RenderHost + performance harness
git checkout release/v0.3.0   # Editable meshes + modifier stack
git checkout release/v0.4.0   # More primitives, bevel and utility modifiers
git checkout release/v0.5.0   # Scripting, NPCs and scene-owned rendering
```

This version (v0.6.0) adds the 2D shapes, the Extrude/Lathe/Inset/Transform modifiers and the
Wedge. It needed **no schema change**: new primitive parameters and new modifier types are both
additive, unknown modifiers are skipped rather than throwing, and every parameter falls back to
its default. A scene saved by the previous build opens untouched, and one saved by this build
opens in the previous build with the new modifiers simply not applied.

CI (`.github/workflows/ci.yml`) runs typecheck, tests and build on every push and pull
request. It needs GitHub Actions enabled on the repository to do anything.

## Layout

```
src/
  engine/    core — scene graph, mesh pipeline, components, render host, serialization,
             loop, scripting, AI, gameplay, input. No React, no DOM. This is what the
             runtime uses.
  editor/    panels, gizmo, undo/redo, persistence, console. Editor only.
```

`src/engine/boundary.test.ts` enforces that split.
