# Web 3D Scene Editor

A browser-based 3D scene editor, built as the first stage of a web game engine. Scenes
authored here are meant to be *played* later by the same core — so the engine is a standalone,
UI-free library and the editor is one consumer of it.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design, and §9 for what the 25 km × 25 km
open-world target forces us to decide up front.

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

**Primitives** — Box, Sphere, Plane, Cylinder, Capsule, Cone, and Empty (transform only, for
grouping). Added from the toolbar's *Add* menu; they land where the viewport camera is looking.

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

## Scene format

Versioned, chunk-addressable JSON. A small scene is a single chunk and reads almost exactly
like a flat entity list — the loader accepts that form too. Unknown component types round-trip
untouched, so a scene saved by a newer build never loses data in an older one.

```jsonc
{
  "version": 1,
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
            { "type": "MeshRenderer", "primitive": "Box", "params": { "width": 1 } },
            { "type": "Material", "color": "#cccccc", "alpha": 1, "mode": "Opaque" }
          ]
        }
      ]
    }
  ]
}
```

## What's next

- **Phase 2** — texture slots and upload plus procedural defaults, alpha modes wired to the
  material UI, texture painting, then scatter painting into `ScatterLayer`, asset browser.
- **Phase 3** — play/runtime mode with a `Script` component, Cloudflare persistence, and the
  world-scale systems: streaming, LOD, camera-relative rendering, workers.

## Layout

```
src/
  engine/    core — scene graph, components, render bridge, serialization, loop.
             No React, no DOM. This is what the game runtime will use.
  editor/    panels, gizmo, undo/redo, persistence. Editor only.
```

`src/engine/boundary.test.ts` enforces that split.
