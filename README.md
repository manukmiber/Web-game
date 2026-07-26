# Web 3D Scene Editor

A browser-based 3D scene editor, built as the first stage of a web game engine. Scenes
authored here are meant to be *played* later by the same core — so the engine is a standalone,
UI-free library and the editor is one consumer of it.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the engine-wide design (§9 covers what the
25 km × 25 km open-world target forces us to decide up front), and
[docs/MODELING.md](./docs/MODELING.md) for the mesh/modifier/edit-mode pipeline specifically —
kept as its own file so working on modelling doesn't require reading the rest.
[CHANGELOG.md](./CHANGELOG.md) has the current version, what's planned next, and why each past
change happened — read it first if you're picking this project back up.

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

## Phase 1 — what works today

**Primitives** — Box, Sphere, Icosphere, Plane, Cylinder, Capsule, Cone, Torus, Tube, and Empty
(transform only, for grouping). Added from the toolbar's *Add* menu; they land where the
viewport camera is looking. Each generates an editable **quad mesh** with segment controls, not
a fixed triangle blob.

Torus is the cleanest topology of the set — every vertex has valence four and there are no
poles — which makes it the shape to reach for when checking whether a modifier misbehaves.
Icosphere exists alongside the UV sphere because its triangles are near-uniform everywhere,
where a UV sphere crowds vertices at the poles and stretches them at the equator.

**Modifier stack** — non-destructive, reorderable, evaluated over the generated mesh:

| Modifier | What it does |
| --- | --- |
| Subdivide | Full Catmull-Clark, up to 4 levels, with correct open-mesh and corner rules |
| Bevel | Rounds every edge by insetting faces and bridging the gaps, 1–6 segments |
| Mirror | Reflects across X/Y/Z, welding the seam so it stays one smooth surface |
| Array | Repeats with relative and constant offsets |
| Solidify | Gives a surface thickness, closing open borders with rim faces |
| Twist / Bend / Taper | Deformers, parameterised against the object's own bounds |
| Noise Displace | Deterministic, position-hashed so welded seams do not tear |
| Weld | Merges vertices by distance — closes seams other modifiers leave split |
| Triangulate | Fans n-gons into triangles as real topology, not just at render time |
| Shade Smooth / Flat | Overrides per-face shading for the whole mesh |

Bevel is the one that makes rendered geometry stop looking like programmer art: real objects
have no perfectly sharp edges, and a bevel is what gives them a highlight to catch.

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

**Play** — snapshots the scene, switches the engine's mode flag, and restores on stop.
Gameplay systems arrive in Phase 3; the seam exists now so they have somewhere to land.

**Performance HUD (`F8`)** — fps, median and p95 frame time, JavaScript vs GPU-bound verdict,
draw calls, triangles and resource counts. Comes with two stress presets — *forest* (many
instances of few meshes) and *city* (many unique meshes) — plus live sliders for density, mesh
variety, render distance, instancing, resolution scale and shadows.

This is how the engine's performance budget gets decided: run it on the device you actually
target, move one slider at a time, and record where the frame budget breaks. See
[ARCHITECTURE.md §9.7](./ARCHITECTURE.md).

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

See [CHANGELOG.md](./CHANGELOG.md#next-version-v060--planned-not-started) for the active plan
in detail. In short: edit mode (vertex/edge/face selection with extrude, inset and loop cut) is
the next big piece — splines with lathe/sweep generators and Boolean (needs robust CSG,
deliberately deferred) come after it.

Engine: adaptive quality driven by the HUD's numbers, then instancing, LOD and chunk
streaming. `ScatterLayer` and the `Script` component's client/server split are reserved in the
schema so neither needs a migration.

## Versions

Every shipped version has a `release/vX.Y.Z` branch at the exact commit it corresponds to, so
a regression can always be isolated by rolling back to the last one known good — see
[CHANGELOG.md](./CHANGELOG.md) for what changed in each and why:

```bash
git checkout release/v0.5.0   # current — transform gizmo rewrite (this branch)
git checkout release/v0.4.0   # Torus/Tube/Icosphere primitives + Bevel + utility modifiers
git checkout release/v0.3.0   # editable quad meshes + modifier stack
git checkout release/v0.2.0   # RenderHost + performance harness
git checkout release/v0.1.0   # Phase 1 editor MVP
```

`release/*` branches are rollback checkpoints, not integration targets — active work happens
on a feature branch and merges via PR; nothing is committed directly to a `release/*` branch.

CI (`.github/workflows/ci.yml`) runs typecheck, tests and build on every push and pull
request. It needs GitHub Actions enabled on the repository to do anything.

## Layout

```
src/
  engine/    core — scene graph, mesh pipeline, components, render host,
             serialization, loop. No React, no DOM. This is what the runtime uses.
  editor/    panels, gizmo, undo/redo, persistence. Editor only.
```

`src/engine/boundary.test.ts` enforces that split.
