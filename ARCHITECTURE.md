# Architecture — Web 3D Scene Editor → Mini Game Engine

Status: **confirmed** (see §8). Phase 1 in progress.

Two constraints drive every decision below.

1. The scene authored in the editor today must be *played* by the same code tomorrow. So the
   core is a standalone, UI-free library, and the editor is one of (eventually) two consumers.
2. The target game is a **25 km × 25 km** open world — zombie survival, farming, seasons.
   That number is not a detail we can bolt on later: it invalidates "one flat entity array,
   all loaded, one draw call each" as a data model. §9 covers what it forces us to decide now
   versus what we can defer, and the Phase 1 schema already reflects it.

---

## 1. Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| Language | **TypeScript** (strict) | The scene schema, component registry and command system are all data contracts. Types are what keep the editor and the future runtime from drifting apart. |
| Build/dev | **Vite** | Instant HMR on a WebGL app, zero-config TS, trivial static build. No bundler config to maintain. |
| Rendering | **Three.js** (WebGL2) | Mature, by far the largest ecosystem for the things Phase 3 needs — physics bindings (rapier/cannon/ammo), positional audio, post-processing (`EffectComposer`), glTF/asset loaders, skeletal animation. Its `WebGPURenderer` gives a forward path without an API rewrite. Ships the exact primitives the MVP needs (`BoxGeometry`, `SphereGeometry`, `PlaneGeometry`, `CylinderGeometry`, `CapsuleGeometry`, `ConeGeometry`). |
| Editor UI | **React 19** | Panels are tree/form-heavy — Hierarchy, Inspector, Asset browser. That is exactly what a declarative DOM layer is good at, and it is the part the runtime will simply *not* include. |
| Editor state | **Zustand** | Tiny, hook-free-capable store. Critically it can be read/written from *outside* React (from the gizmo drag handler inside the render loop) without forcing a re-render on every mouse-move frame. Redux/Context would put React in the hot path. |
| Camera controls | `three/addons/controls/OrbitControls` | Orbit / pan / zoom, Unity Scene-View-like. |
| Gizmo | `three/addons/controls/TransformControls` | Already gives coloured axis handles (X red, Y green, Z blue), rotate rings, scale boxes + centre uniform-scale handle, a `local`/`world` space toggle and `translationSnap` / `rotationSnap` / `scaleSnap`. Wrapping it is far more robust than hand-rolling ray-picked handles, and it is replaceable behind our own `GizmoController` facade if we outgrow it. |
| Tests | **Vitest** | Runs the pure core (scene graph, serializer, command stack) headlessly in Node. No browser needed for the parts that matter most. |

### Rejected alternatives

- **react-three-fiber** — pleasant for apps, but it makes React the owner of the scene graph.
  Our scene graph must be ownable by a headless runtime with no React at all. R3F would put
  a UI framework on the wrong side of the core/UI line drawn in §2 of the brief.
- **Babylon.js** — a strong engine with a built-in inspector, but its "batteries included"
  surface makes it harder to keep *our* core thin and portable, and the brief asks us to own
  the engine layer.
- **Raw WebGL / WebGPU** — months of work re-creating what Three.js gives on day one, with no
  payoff for a scene editor.

---

## 2. Module boundaries (the load-bearing rule)

```
src/
  engine/                 ← pure core. NO React, NO DOM-editor imports, NO editor concepts.
    scene/                  Scene, Entity, Transform, hierarchy ops
    mesh/                   editable quad meshes, primitive generators, modifier stack
    components/             component definitions + registry
    render/                 Three.js bridge (Scene data ──▶ Object3D tree) + RenderHost,
                            which owns the renderer, camera and frame draw shared by the
                            editor and the runtime
    perf/                   frame measurement + stress-scene generator
    material/               material definitions → THREE.Material
    assets/                 texture/asset store (id → resource)
    serialization/          toJSON / fromJSON + schema version + migrations
    loop/                   Engine: RAF loop, fixed-step update, system list, mode flag
    systems/                RenderSystem now; ScriptSystem/PhysicsSystem later

  editor/                 ← everything the runtime will NOT ship
    state/                  Zustand store: selection, active tool, snapping, dirty flag
    commands/               command pattern + undo/redo stack
    viewport/               RenderHost host + OrbitControls, TransformControls, grid,
                            selection outline, picking, axis widget
    panels/                 Hierarchy, Inspector, Toolbar, AssetBrowser
    styles/                 dark Unity-like theme

  runtime/                ← Phase 3 placeholder. Same engine, no panels.
```

Enforced by a test, `src/engine/boundary.test.ts`: **`engine/**` may never import from
`editor/**`, React or Zustand, and may never touch `document`/`window`/`localStorage`.** That
check is what makes the Phase 3 split a config change rather than a rewrite, and it fails
`npm test` the moment it is violated.

(It is a test rather than an ESLint rule for a boring reason: `typescript-eslint` does not yet
support TypeScript 7, and a linter with a broken parser enforces nothing. The constraint is
what matters, not which tool carries it — if the plugin catches up, moving it back to
`no-restricted-imports` is a fine swap.)

One deliberate exception: `Engine.start()` uses `requestAnimationFrame`, which has no worker
equivalent. The frame clock is inherently main-thread; §9.5 is about moving the *work* that
systems do off-thread, not the clock that ticks them.

The renderer never learns about selection, gizmos, or the grid — those are editor overlays
that live in a separate `THREE.Scene` layer owned by `editor/viewport`, composited over the
same canvas.

---

## 3. Data model — entity + components

An entity is *data*, not a class hierarchy. `Transform` is promoted to a first-class field
(rather than a component) because every entity has exactly one and the renderer/physics both
need it on a hot path; everything else lives in an open `components` array.

```ts
interface Entity {
  id: EntityId;              // stable, uuid-ish, survives save/load
  name: string;
  parentId: EntityId | null;
  transform: { position: Vec3; rotation: Vec3 /* Euler degrees */; scale: Vec3 };
  components: Component[];   // open set — see registry below
}
```

Components are discriminated by `type` and resolved through a **registry**:

```ts
registerComponent({
  type: 'MeshRenderer',
  defaults: () => ({ primitive: 'Box', params: { … } }),
  inspector: MeshRendererInspector,   // editor-only, looked up lazily
  onAttach / onUpdate / onDetach,     // engine-side hooks
});
```

Adding `Script`/`Behaviour` in Phase 3 is then *one `registerComponent` call* — the
serializer, Inspector, undo/redo and hierarchy all handle it generically, with no switch
statement anywhere to extend. That is the whole point of the registry.

Unknown component types encountered on load are **preserved verbatim** and round-tripped, so
a scene saved by a newer build never loses data in an older one.

### Scene JSON (v1)

Superset of the brief's schema. Entity shape is unchanged from the brief; what is added is
`version` (migrations), `assets` (Phase 2 textures) and `world.chunkSize` + chunk-grouped
entities (§9.2). A small scene is one chunk, so it reads almost exactly like the brief's
example.

```jsonc
{
  "version": 2,
  "name": "Untitled Scene",
  "world": { "chunkSize": 256 },
  "assets": [ { "id": "tex_1", "type": "texture", "name": "crate.png", "src": "data:…" } ],
  "chunks": [
    {
      "key": "0,0",
      "entities": [
        {
          "id": "e1",
          "name": "Box 1",
          "parentId": null,
          "transform": { "position": [0,0,0], "rotation": [0,0,0], "scale": [1,1,1] },
          "components": [
            { "type": "MeshRenderer", "primitive": "Box", "params": { "widthSegments": 1 },
              "modifiers": [ { "type": "Subdivide", "enabled": true, "levels": 2 } ] },
            { "type": "Material", "color": "#ffffff", "alpha": 1, "mode": "Opaque",
              "metalness": 0, "roughness": 0.8, "map": null }
          ]
        }
      ]
    }
  ]
}
```

`version` + a `migrations` table means the schema can evolve without breaking saved scenes.
This has now been exercised once: **v1 → v2** added the `modifiers` array and renamed Plane's
second axis from `height` to `depth`, and the migration rewrites both so scenes saved before
the mesh pipeline still open correctly.
Chunk payloads are separable — the Cloudflare adapter (§8.2) will store them as individual
objects rather than one document.

---

## 3b. Mesh pipeline

Primitives are not opaque parametric blobs. Each one generates an **editable quad mesh**
(`engine/mesh/MeshData.ts`), which then runs through a **non-destructive modifier stack**
before being triangulated for the GPU:

```
primitive params ──▶ MeshData (quads) ──▶ modifier stack ──▶ BufferGeometry
```

**Why quads rather than triangles.** Every modelling operation worth having depends on quad
topology. Catmull-Clark subdivision on triangles produces pinched, uneven surfaces; extrude,
inset and bevel are face operations, and a triangulated cube has twelve faces to push instead
of six; edge loops only exist in quads at all. Triangulation happens exactly once, at the end.

**Why a stack rather than baked edits.** Non-destructive is what makes the editor comparable
to Blender's modifiers or C4D's generators — change the source primitive's segment count and
everything downstream re-evaluates. Order is meaningful and editable: Mirror then Array tiles
a mirrored pair, Array then Mirror mirrors a whole row.

Modifiers register through their own registry (`engine/mesh/modifiers/registry.ts`) using the
same field schemas the component Inspector uses, so a new modifier is one file plus one import
— no Inspector, serializer or undo changes. Unknown modifier types are skipped rather than
throwing, matching how unknown components are handled.

Shipping now: Subdivide (full Catmull-Clark, with the open-mesh boundary and pinned-corner
rules), Bevel, Mirror, Array, Solidify, Twist, Bend, Taper, Noise Displace, Weld, Triangulate
and Shade.

Still to come: edit mode (vertex/edge/face selection with extrude, inset, loop cut), splines
with lathe/sweep generators, and Boolean — which needs robust CSG and is deliberately not
attempted yet.

**Testing closed surfaces.** Winding correctness is checked with signed volume via the
divergence theorem, not a centroid-dot-normal test. The centroid test only holds for convex
shapes — a torus face on the inside of the ring legitimately points back toward the axis — and
it silently passed an inside-out torus that signed volume caught immediately. A second check
verifies each directed edge appears exactly once with exactly one opposite, which catches holes
and individually flipped faces that a global volume check would average away.

## 4. Render bridge

`engine/render` keeps a `Map<EntityId, THREE.Object3D>` mirroring the scene data and applies
diffs. Data is the source of truth; the Three.js tree is a projection of it. This is what lets
the same scene data drive an editor viewport and a headless-ish runtime canvas identically.

Geometry and materials are **cached and shared** by their parameter hash, so 500 default cubes
allocate one `BoxGeometry`. Disposal is refcounted to avoid GPU leaks on delete/undo churn.

---

## 5. Undo/redo

Command pattern, entirely in `editor/commands` (the runtime has no undo). Every mutation goes
through a command with `do()` / `undo()`, pushed onto a bounded stack.

Commands for Phase 1: `AddEntity`, `DeleteEntity`, `ReparentEntity`, `RenameEntity`,
`SetTransform`, `SetComponentProperty`, `DuplicateEntity`, `GroupEntities`.

Two details that decide whether undo *feels* right:
- **Coalescing** — a gizmo drag or a held arrow key in a number field produces one undo
  entry, not sixty. Commands declare a `mergeKey`; consecutive same-key commands within a
  time window merge.
- Deleting a parent captures the whole subtree so undo restores it with hierarchy intact.

`Ctrl+Z` / `Ctrl+Shift+Z` (and `Ctrl+Y`).

---

## 6. Engine loop & the Play-mode seam (Phase 3 groundwork)

```ts
class Engine {
  mode: 'edit' | 'play';
  systems: System[];          // each declares runsIn: ('edit'|'play')[]
  tick(dt) { for (const s of this.systems) if (s.runsIn.includes(this.mode)) s.update(dt); }
}
```

Entering Play mode therefore is: snapshot scene JSON → flip `mode` → enable
`ScriptSystem`/`PhysicsSystem` → render through the scene's own camera entity instead of the
editor camera. Exiting restores the snapshot. **No engine rewrite, no second renderer** — this
is exactly the seam §2 of the brief asks for, and the Play button in the toolbar is wired to
it from Phase 1 (disabled until Phase 3 fills in the systems).

---

## 7. Phasing

- **Phase 1 (MVP)** — primitives, transform gizmo + hotkeys Q/W/E/R, local/global, snapping,
  Inspector (two-way with gizmo), Hierarchy with drag-reparent/rename/multi-select/context
  menu, full undo/redo, solid-colour material, save/load JSON (chunk-aware, §9.6).
- **Phase 2** — texture slots + upload + procedural defaults, alpha modes
  (Opaque/Transparent/Cutout), texture painting, then scatter painting into `ScatterLayer`
  (§9.3), asset browser panel, UI polish.
- **Phase 3** — Play/runtime mode (§6), `Script` component, Cloudflare persistence adapter,
  and the world-scale systems from §9: streaming, LOD, camera-relative rendering, workers.

---

## 8. Confirmed decisions

1. **"Paint" = both.** Texture painting first (Phase 2), object/scatter painting after.
   Scatter is not a second-class add-on — see §9.3, it is the feature that forces the
   instancing/chunking model into the schema now.
2. **Persistence: localStorage + JSON export/import now; Cloudflare backend after the MVP.**
   Everything goes through one `ScenePersistence` interface with a `LocalStorageAdapter`
   today, so the Cloudflare adapter (Workers + R2 for assets, D1/KV for scene metadata,
   Durable Objects if multiplayer arrives) is a new implementation, not a refactor. Scene and
   asset payloads are kept separately addressable from day one because a 25 km world will not
   round-trip as one JSON blob.
3. **Textures: user upload + procedurally generated defaults** (checker, grid, UV test).
   No binary assets in the repo.
4. **Stack: confirmed as §1**, with the scale work in §9 folded into the roadmap.

## 9. Designing for 25 km × 25 km

Most of the heavy machinery below belongs to later phases — building it now, against an empty
world, would be guessing. What *cannot* wait is anything that would otherwise become a
breaking change to the save format or the core data model. Those are marked **now**.

### 9.1 Coordinates and precision — decide **now**

Float32 has ~7 decimal digits. At 12,500 m from origin, a float32 position quantises to
roughly 1 mm, and *rendered* vertex positions (which go through float32 matrices) start
visibly jittering and z-fighting well before the world edge.

- Scene data stores positions as plain JS numbers (**float64**) — already true, no cost.
- Rendering uses **camera-relative transforms**: the render bridge rebases world matrices
  around the active camera each frame, so the GPU only ever sees small coordinates.
- The editor viewport gets the same treatment, so what you author at x=24000 looks the way it
  will look at runtime.

The rebase is implemented in the render bridge, i.e. one place. Phase 1 keeps origin at zero;
the seam is a single `originOffset` in the bridge.

### 9.2 Spatial partitioning and streaming — schema **now**, systems later

The scene is partitioned into a **uniform chunk grid** (default 256 m, configurable per
scene — a 25 km world is then ~98 × 98 chunks). Chunk coordinates are derived from an
entity's world position, never hand-authored.

Consequences baked into the v1 format:
- The save format is **chunk-addressable**: a scene is a manifest plus per-chunk payloads.
  A small scene serialises to a single file with one chunk — identical ergonomics to the flat
  schema in the brief — but the reader/writer already speaks chunks, so growing to 9,600 of
  them is data, not a migration.
- Entities carry stable ids that are unique scene-wide, so cross-chunk references (a door
  referencing its building) survive independent chunk loading.

Streaming, chunk LOD and background (worker) load/unload land with Phase 3, behind a
`StreamingSystem` that the loop already has a slot for.

### 9.3 Mass instancing — schema **now**

A 25 km world has millions of trees, rocks and grass tufts. One entity each is not viable at
any level: not in memory, not in the hierarchy panel, not in the draw call budget.

So **scatter output is not entities.** A `ScatterLayer` component holds a prototype list plus
packed typed arrays (`Float32Array` of position/rotation/scale/variant per instance), rendered
through `InstancedMesh` — one draw call per prototype per chunk. It is one component on one
entity in the Hierarchy, however many million instances it contains.

This is the decision that had to be made before Phase 2's scatter brush, not after: the brush
writes into instance buffers, and undo/redo for it records buffer deltas rather than entity
add/remove commands.

Hand-placed entities stay entities. Both paths render through the same bridge.

### 9.4 Draw-call and memory budget — later, but not accidental

- Geometry/material caching + refcounted disposal (already in §4) — the foundation.
- Frustum culling per chunk before per object; LOD chains per prototype; imposters for
  distant vegetation.
- glTF with Draco/meshopt compression for authored assets; KTX2/Basis for textures so VRAM
  cost is a fraction of PNG.
- Terrain as heightfield chunks with GPU-side clipmap LOD, not a mesh entity per tile.

### 9.5 Threading — constraint **now**

`engine/**` must stay free of `window`/`document` (§2 already forbids DOM-editor imports;
this extends it to the DOM entirely, enforced by the same lint rule). That keeps chunk
generation, streaming, pathfinding and physics movable into Web Workers later without
untangling them from the browser main thread first.

### 9.6 The viewport grid is procedural, not geometry

Worth recording because it is the first place the 25 km target changed an implementation
rather than a schema. The editor grid is a camera-following quad with the lines computed per
fragment from world position (`editor/viewport/GroundGrid.ts`), not a `GridHelper`:

- **No extent.** A grid mesh covering 25 km is either millions of wasted vertices or something
  that has to be rebuilt as the camera travels. This is two triangles wherever the camera is.
- **No aliasing.** Screen-space derivatives (`fwidth`) hold lines at one pixel wide at any
  distance or zoom, and fine cells fade out before they turn into moiré. Line geometry cannot
  do this.
- **Robustness.** Long line primitives turned out to be genuinely fragile: the software
  rasterizer in headless Chromium discards line segments needing frustum clipping once the
  endpoints are far enough apart, so a 200-unit `GridHelper` renders as a thin band at the
  horizon and nothing else. Verified by pixel readback — a single segment spanning ±10 draws,
  the same segment spanning ±100 draws zero pixels, while plane meshes are correct out to
  2000 units. Real GPUs are very likely fine; the procedural grid is immune either way.

### 9.7 Measuring the budget

Numbers beat arguments, so the engine ships an instrument rather than a set of assumptions.
`Engine.stats` (`engine/perf/FrameStats.ts`) records a rolling window and
`engine/perf/StressScene.ts` generates the two load shapes an engine has to survive. The
editor exposes both through the perf HUD (**F8**).

**Why two presets.** They fail for opposite reasons, and tuning against one produces a
renderer that collapses on the other:

| | forest | city |
| --- | --- | --- |
| shape | many instances, few unique meshes | many unique meshes, fewer objects |
| carried by | instancing | occlusion culling |
| occlusion | poor — everything is visible | good — buildings hide each other |
| pressure | draw submission, overdraw | memory, draw calls |

**Reading the numbers.** `p95` matters more than the average — a run that averages 60fps but
spikes every second feels broken, and a mean hides that. The `bound` verdict comes from what
share of the frame is JavaScript: mostly JS means fewer draw calls and less per-frame work;
mostly *not* JS means the frame is waiting on the GPU, so resolution scale, overdraw and
shader cost are the levers.

**One honest limitation.** There is no synchronous way to read GPU time from JavaScript —
`renderer.render()` queues commands and returns. So `submit` is the CPU cost of *issuing*
draw calls, not how long the GPU took. That number is still worth having (in Three.js it is
often the bottleneck), but it must not be read as GPU time. Real GPU timing would need
`EXT_disjoint_timer_query_webgl2`, which is a later addition.

**How to produce the budget table.** Run `npm run dev` on the target device, press F8, pick a
preset, then move one slider at a time until the frame budget breaks. Record draw calls,
triangles and render distance at the break point. Those numbers — not estimates — set the
parameters for the streaming, LOD and instancing work.

### 9.8 What Phase 1 actually ships against this

Chunk-aware serializer, camera-relative seam in the bridge, `ScatterLayer` reserved in the
component registry, DOM-free engine core. Everything else in §9 is scheduled, not built —
an editor with twelve cubes in it does not need a streaming system, and writing one now would
mean tuning it against a world that does not exist.
