# Architecture — Web 3D Scene Editor → Mini Game Engine

Status: **confirmed** (see §8). Phases 1 and 2 shipped; Phase 3 in progress — the play seam,
scripting, agents and scene-owned rendering are in (§10), the assistant tool layer and MCP
server are in (§11), physics and streaming are not.

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
    mesh/                   editable quad meshes, 2D shape contours, primitive generators,
                            ear-clip tessellation, sweep/border helpers, modifier stack
    components/             component definitions + registry
    render/                 Three.js bridge (Scene data ──▶ Object3D tree) + RenderHost,
                            which owns the renderer, cameras, environment and frame draw
                            shared by the editor and the runtime
    scatter/                mass instancing: the packed instance codec and the seeded
                            area brush that fills it (§9.3). No Three.js — the batches
                            are built in render/
    perf/                   frame measurement + stress-scene generator
    material/               material definitions → THREE.Material
    assets/                 texture/asset store (id → resource)
    core/                   Emitter, and the seeded PRNGs everything deterministic shares
    serialization/          toJSON / fromJSON + schema version + migrations
    loop/                   Engine: RAF loop, fixed-step update, system list, mode flag
    input/                  key/pointer state as data, written by the host, read by systems
    hardware/               external devices: the line protocol, the device/channel model,
                            the binding language and the system that applies it (§12).
                            Transport-free, for the same reason `input/` is listener-free
    scripting/              Script compilation, the script API, ScriptSystem
    ai/                     steering maths + NpcSystem
    gameplay/               GameState (health, factions, script vars), CharacterSystem,
                            and the one call that installs the Play-mode systems
    assistant/              the machine-facing surface: tool definitions + JSON Schema
                            validation, the SceneEditor seam, and a transport-free MCP
                            server (§11)

  editor/                 ← everything the runtime will NOT ship
    state/                  Zustand store: selection, active tool, snapping, console
    commands/               command pattern + undo/redo stack
    viewport/               RenderHost host + OrbitControls, gizmo, grid, selection
                            outline, light/camera handles, picking, axis widget
    panels/                 Hierarchy, Inspector, Toolbar, Console, ScriptEditor,
                            ScatterEditor, AssistantPanel
    assistant/              CommandSceneEditor (tools → undo stack), the Anthropic
                            tool-use loop, and the MCP transports
    hardware/               the transports themselves: Web Serial, WebSocket, and the
                            simulated rig the panel drives
    styles/                 dark Unity-like theme

  runtime/                ← Phase 3 placeholder. Same engine, no panels.

firmware/                 ← reference Arduino sketch for the hardware protocol (§12)
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

That claim has now been cashed. `Script`, `Camera`, `Light`, `Environment`, `NpcAgent`,
`CharacterController`, `HardwareInput` and `HardwareOutput` were eight `registerComponent`
calls; the serializer, the undo stack and the Hierarchy needed no changes at all, and the
Inspector needed none beyond the two panels that are genuinely bespoke (the modifier stack and
the script source editor) plus one new field kind. It also meant **no schema
bump**: the new components are additive, so a scene from the previous build opens untouched.

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
                     2D shape (contours)
                             │ fill
                             ▼
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
rules), Bevel, Extrude, Lathe, Inset, Transform, Mirror, Array, Solidify, Twist, Bend, Taper,
Noise Displace, Weld, Triangulate and Shade.

**2D shapes are primitives, not a second object type.** `engine/mesh/shapes.ts` produces closed
contours in ordinary 2D coordinates, and `fillShape` maps them into a flat mesh in XZ. Making
them a parallel kind of scene object would have meant a second Inspector, a second serializer
path and a conversion step before any modifier could touch them; making them primitives means
Extrude, Bevel, Subdivide and the material all work on day one. The 2D stage stays genuinely 2D
so winding, area and convexity are testable as plain numbers rather than as properties of a mesh.

A shape's hole is filled as a ring of quads bridging the two contours, which is why a hole must
have as many points as its outline. The alternative — bridging the hole into the outline with a
zero-width slit, so the whole thing is one face — is what a general triangulator needs, and it
produces a face that Subdivide, Bevel and Solidify all mangle.

**Extrude and Lathe are one construction** (`engine/mesh/sweep.ts`) differing only in the
transform applied along the path. Sweeping the mesh's *border* (`engine/mesh/loops.ts`) rather
than a separate curve type is what keeps 2D and 3D on the same pipeline. The sweep also decides
its own orientation, by measuring whether the first small step moves the surface along its
normals or against them: a negative extrude distance, a lathe profile on the far side of the
axis and a negative angle all produce walls wound backwards, and having one rule in one place
beats three sign conventions in two callers.

Still to come: edit mode (vertex/edge/face selection, loop cut, and extrude/inset over a
selection rather than the whole mesh), editable Bézier paths and sweeping along one, and
Boolean — which needs robust CSG and is deliberately not attempted yet.

**Testing closed surfaces.** Winding correctness is checked with signed volume via the
divergence theorem, not a centroid-dot-normal test. The centroid test only holds for convex
shapes — a torus face on the inside of the ring legitimately points back toward the axis — and
it silently passed an inside-out torus that signed volume caught immediately. A second check
verifies each directed edge appears exactly once with exactly one opposite, which catches holes
and individually flipped faces that a global volume check would average away.

Swept solids are checked against closed-form volumes — a circle extruded is a cylinder, an
offset circle lathed is a torus by Pappus's theorem, a half disc lathed is a sphere — because
those catch a wrong radius or a dropped ring that a manifold check happily accepts.

**Triangulation is ear clipping, not a fan** (`engine/mesh/tessellate.ts`). Fanning an n-gon
from its first corner is correct only for convex faces, which every primitive generator happens
to produce; Star, Gear and a wide Arc are not, and neither is a quad after a deformer has pushed
one corner through the opposite edge. A fanned star paves over the notches between its points
and lays triangles back-to-front on top of them. Convex faces keep the fan behind a convexity
scan, so only concave ones pay.

Worth recording how that bug hides: **signed area cannot detect it.** A fan's signed triangle
areas telescope to the polygon's own area for any simple polygon, concave included, because the
triangles that spill outside the border come back with the opposite sign. The arithmetic
balances while the rendered surface does not, so the test measures area with the sign discarded
and separately asserts that no triangle faces backwards.

## 4. Render bridge

`engine/render` keeps a `Map<EntityId, THREE.Object3D>` mirroring the scene data and applies
diffs. Data is the source of truth; the Three.js tree is a projection of it. This is what lets
the same scene data drive an editor viewport and a headless-ish runtime canvas identically.

Geometry and materials are **cached and shared** by their parameter hash, so 500 default cubes
allocate one `BoxGeometry`. Disposal is refcounted to avoid GPU leaks on delete/undo churn.

What the bridge produces is drawn by `RenderHost`, which owns the frame itself — including the
antialiasing, tone mapping and colour-space pipeline described in §13.

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

## 6. Engine loop & the Play-mode seam

```ts
class Engine {
  mode: 'edit' | 'play';
  systems: System[];          // each declares runsIn: ('edit'|'play')[]
  tick(dt) {
    for (const s of this.systems) if (s.runsIn.includes(this.mode)) s.update(dt, this);
    this.scene.flushTransforms();   // one event per moved entity, not one per axis
    this.events.emit('afterUpdate', { dt });   // rendering happens in here
    this.input.endFrame();          // press/release edges last exactly one tick
  }
}
```

Entering Play mode is: snapshot the scene → flip `mode` → the gameplay systems start ticking →
render through the scene's own camera entity instead of the editor camera. Exiting restores the
snapshot. **No engine rewrite, no second renderer, no second scene graph.**

The seam held. Adding scripting, agents and a character controller took no change to this file
beyond three lines: `input`, `game`, and a `reset` hook on `System`.

**What "restored" has to cover.** The scene snapshot is only half of a play session's state.
Health, script instances, agent state machines and held keys live outside the scene, so they are
dropped in `setMode` too — one place with one answer to "what does stopping undo?", rather than
one answer per system. The `reset(engine)` hook on `System` exists for exactly that, and it fires
in both directions so a stop-then-start never resumes half a simulation.

**The snapshot is a structural clone, not JSON.** It used to be `sceneToJSON`. Two things were
wrong with that. The chunked save format buckets entities by world position and writes the
buckets in key order, so an entity at a negative coordinate came back somewhere else in the
Hierarchy every time you pressed stop — and "restored exactly as it was" has to mean exactly.
And a 25 km world should not stringify itself every time someone taps Play.

**Transform writes are batched.** A hundred agents each writing x, y and z through
`Scene.setTransform` would emit three hundred events a frame, and every listener — render bridge,
selection outline, gizmo pivot — would run three hundred times for a hundred actual changes.
Gameplay systems mutate in place and call `markTransformDirty`; the loop flushes one event per
entity after every system has had its say. Editor commands still use `setTransform`, because a
gizmo drag is one entity and wants its event immediately.

---

## 7. Phasing

- **Phase 1 (MVP)** — primitives, transform gizmo + hotkeys Q/W/E/R, local/global, snapping,
  Inspector (two-way with gizmo), Hierarchy with drag-reparent/rename/multi-select/context
  menu, full undo/redo, solid-colour material, save/load JSON (chunk-aware, §9.6).
- **Phase 2** — texture slots + upload + procedural defaults, alpha modes
  (Opaque/Transparent/Cutout), texture painting, then scatter painting into `ScatterLayer`
  (§9.3), asset browser panel, UI polish.
  *Shipped so far:* alpha modes, and scatter as an area brush — stroke painting waits on a
  terrain to project onto. Still open: texture upload, texture painting, the asset browser.
- **Phase 3** — Play/runtime mode (§6), `Script` component, Cloudflare persistence adapter,
  and the world-scale systems from §9: streaming, LOD, camera-relative rendering, workers.
  *Shipped so far:* the play seam itself, scripting, NPC agents, a character controller, and
  scene-owned rendering (§10). Still open: physics and collision, streaming, LOD, workers.

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

### 9.3 Mass instancing — schema **now**, brush shipped in v0.7.2

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

**What v0.7.2 added**, two versions after the format was fixed and with no migration required —
which is the entire return on having decided it early:

- `scatter/codec` — the packed format, base64 over explicitly little-endian bytes. Written by
  hand rather than through `btoa`, because §9.5 keeps `engine/**` free of DOM globals and this
  codec is exactly the kind of work that will move into a Worker.
- `scatter/generate` — the brush, a pure seeded function of area, density, scale range and
  seed. A layer therefore stores a seed and a dozen numbers rather than a million transforms
  until someone edits an individual instance, and re-opening a scene reproduces the forest that
  was saved.
- `render/RenderBridge` — one `InstancedMesh` per prototype, borrowing geometry and material
  from the *source entity* through the same refcounted caches ordinary meshes use. That is what
  makes editing the source tree — parameters, colour, modifier stack — update every instance
  with no scatter-specific code in the mesh pipeline.

Still open, and deliberately so: stroke-based painting (needs a surface to project onto — §9.4's
terrain), per-instance selection and its buffer-delta undo, and per-chunk batching. Today it is
one draw call per prototype rather than per prototype *per chunk*, which is the right answer
until layers are big enough that culling half of one matters — and that arrives with streaming.

The prototype list is also where an LOD chain hangs, and it is shaped for one.

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

Of those four, the reserved component is the one that paid off measurably: the brush that fills
it arrived in v0.7.2 as new directories plus one method on the render bridge, with no schema
version bump and no change to any scene already on disk.

---

## 10. Gameplay: scripting, agents and the game view

Three features landed together because they are one feature: a scene that can be *played*. A
camera with nothing to look at, agents with no player to chase, and scripts with no way to see
either would each have been a demo rather than a system.

### 10.1 Rendering belongs to the scene, not to the host

Camera, Light and Environment are **components**, so the runtime gets the editor's look by
reading the same data and being told nothing. The alternative — a `scene.environment` field, a
lighting rig configured by whoever constructs the RenderHost — needs a schema migration, a
bespoke panel and a bespoke undo command. As components they inherit all three from the registry
for free, which is the payoff §3 predicted.

Three consequences fell out of that:

- **The placeholder lighting rig steps aside** the moment a scene contains one Light of its own.
  A scene that could not turn off the built-in lights would be impossible to light deliberately.
- **-Z is forward, everywhere.** Cameras, directional and spot lights, characters and agents all
  agree, so a camera parented behind a character needs no rotation of its own. Three's default
  for lights (aim at the world origin) is discarded in favour of a target parked one unit down
  local -Z, because a light whose rotation does nothing is baffling the first time you rotate one
  and the shadows stay put.
- **The game camera is synced, not parented.** The active Camera entity's world matrix is
  decomposed and its position and rotation copied onto a `PerspectiveCamera` that lives outside
  the bridge's tree. Parenting would be less code and would inherit the entity's *scale* into the
  view matrix, quietly distorting the projection of any camera under a scaled parent.
- **The sky is a shader on an inverted sphere**, not `scene.background`. A gradient background
  would have to be generated, generating one means a canvas, and the engine may not touch the
  DOM (§9.5). Same reasoning as the procedural grid in §9.6. Being a custom shader is also what
  made it the one thing in the scene that could get its colour space wrong — see §13.2.

### 10.2 Scripting: what the sandbox is and is not

A `Script` component's source is compiled with `new Function`, once per unique source text and
cached — so a hundred zombies sharing a behaviour compile once. Per-entity variation goes in
`props`, which is also what keeps that cache effective, and what gives the Inspector something to
show without parsing the script.

Hooks are picked up by name (`start`, `update`, `destroy`) rather than returned by the author.
`typeof` on an undeclared identifier is the one construct that does not throw under strict mode,
which is what makes "define only the hooks you need, return nothing" work.

Roughly forty globals — `window`, `document`, `fetch`, `setTimeout`, `Function` — are shadowed to
`undefined` by being declared as parameters of the wrapper. **This is a guard rail, not a
security boundary, and the code says so.** It stops the accidents: a DOM reach, a timer that
keeps firing into a scene that no longer exists after Play stops. It does not contain hostile
code. `eval` cannot be shadowed at all — it is illegal as a parameter name in strict mode — and
`({}).constructor.constructor` rebuilds `Function` from nothing. Scene JSON is therefore
executable code and has to be treated as such.

Real isolation is a Worker or a sandboxed iframe with its own CSP. That is the same change as
fixing the other honest limitation — an infinite loop in a script hangs the tab, because nothing
can interrupt synchronous JavaScript on the main thread — and it needs the script API to be
message-based first. Freezing the API's *shape* now, while it is small, is what makes that
migration tractable later.

What is enforced today: every hook call is wrapped, a throw is reported to the editor console
once and parks that instance, and every other script keeps running. An exception escaping into
`Engine.tick` would kill the loop and with it the editor's viewport — for a typo in one of a
hundred scripts.

### 10.3 Agents keep no state in their components

`NpcAgent` is configuration only: factions, senses, speeds. No `state`, no `currentTarget`, no
health that ticks down. All of that lives in the NpcSystem's own map and in `GameState`, because
§6 promises Play mode restores the scene exactly — and a zombie that persisted its half-empty
health bar into the saved scene would break that promise quietly, one field at a time.

Wander is seeded per entity from its id, so a crowd is deterministic. That is not decoration: it
is the difference between "does this agent stay inside its wander radius" being an exact test and
a flaky one.

The steering maths is pure functions over numbers (`engine/ai/steering.ts`) with the state
machine on top, so the parts worth testing — shortest-arc turning, arrival without overshoot,
uniform disc sampling — are testable without a Scene, an Engine or a frame loop.

**System order is a design decision, not an accident.** Scripts run first, so a decision a script
makes is visible to everything else in the same frame. The character moves next, so agents chase
where the player *is* rather than where they were a frame ago — a one-frame lag that is invisible
at 60 fps and very visible at 20.

### 10.4 What is deliberately missing

No physics, no collision, no navigation mesh, and sight is distance rather than line of sight.
Agents and the character walk through walls. This is the largest remaining gap and it is left
open on purpose: a hand-rolled half-physics would be harder to remove later than a real one is to
add now, and the state machine is shaped so line of sight and pathfinding slot into `findTarget`
and the movement step rather than needing a rewrite.

---

## 11. The machine-facing surface: tool calls and MCP

Two consumers arrived at once — an assistant panel inside the editor, and external MCP clients
outside it — and they are one feature, because the hard part is neither of them. It is deciding
what a model is allowed to do to a scene, and what happens when it gets an argument wrong.

### 11.1 The tools live in the engine, not the editor

`engine/assistant` holds the tool definitions, their schemas and their validation. That looks
odd for something whose obvious consumer is a UI panel, and it is the same call §2 makes
everywhere: the tools operate on scene data and nothing else, so they belong on the side of the
line that a runtime can ship. The payoff is immediate rather than theoretical — the whole tool
layer and the MCP server are tested in Node with no browser, no React and no editor, and the
boundary test enforces that they stay that way.

What that forced: `readPath`/`writePath` moved out of `editor/commands` into `engine/scene`,
because three separate things now address component fields by path and only one of them is
allowed to be editor code.

### 11.2 `SceneEditor` is the seam, and undo is the reason

The tools never touch `Scene`. They go through a `SceneEditor` interface with two
implementations: `DirectSceneEditor` writes straight through, and the editor's
`CommandSceneEditor` turns every call into a command on the undo stack.

Handing the tools a `Scene` would have been less code and would have made the editor's undo
history silently wrong the first time a model touched anything. "The assistant's edits are the
only ones you cannot take back" is not a seam anyone would choose deliberately — and an
assistant whose work cannot be undone is one nobody will try anything ambitious with, which
removes the point of having it.

One tool call is **one** undo entry. That needs a wrinkle: the steps inside a call are applied
as they are decided, because a later step reads what an earlier one produced, so by the time
there is a composite worth pushing the work has already happened. `CommandHistory.pushExecuted`
records an already-applied command rather than pretending it has not run; the alternative — a
composite whose first `execute()` secretly does nothing — is the same behaviour with a lie in it.

### 11.3 Validation is the interesting part

A tool call is a model's guess about an API it cannot see. Three decisions follow.

- **Validate at the boundary, and report every error at once.** A model told about three
  mistakes fixes them in one turn; told about the first, it spends three. The schema type and
  the validated type are deliberately the same type — anything the validator could not enforce
  would be a promise on the wire the code does not keep.
- **Unknown fields are an error, not a shrug.** A silently ignored `params.size` on a Box is the
  worst outcome available: the tool reports success, the box is the wrong size, and nobody finds
  out. Naming the parameters that *do* apply turns a dead end into a one-line fix. The same rule
  runs on component fields and modifier fields, checked against the registries' own field
  schemas.
- **Numeric strings are coerced; `"3 metres"` is not.** Models emit `"3"` for number fields
  regularly, and rejecting it costs a round trip to fix a value that was never ambiguous. The
  coercion is exact or nothing.

`list_capabilities` reads the component, modifier and primitive registries at call time rather
than restating them in a prompt. This is the §3 registry payoff again: a component added
tomorrow is discoverable by the assistant with no edit to the tool layer, and a baked-in list
would be wrong the first time anyone added one.

Entity arguments accept an id **or** an exact name, because a model that has just read
`"Crate 1"` in a scene listing will pass `"Crate 1"` back. An ambiguous name is an error rather
than a coin flip.

### 11.4 The MCP server is transport-free, and the transport is Vite's

`McpServer` is message-in, message-out — no sockets, no streams, no session state. Every request
is answered from the scene as it is right now, so a client that reconnects mid-conversation
loses nothing. What MCP standardises is the vocabulary, not the pipe, and wiring a pipe into the
server would have meant one implementation per host and no way to test any of them.

Which leaves the actual problem: the server lives in a browser tab, and nothing can dial into a
browser tab. Vite's dev server already holds a WebSocket open to that page for hot reload, and
it carries arbitrary custom events — so `tools/mcp-bridge.mjs` speaks that socket's wire format
and relays stdio into it. No second server, no second port, no WebSocket dependency, about
twenty-five lines of relay in `vite.config.ts`.

The cost is that it is dev-only, which is the honest scope rather than a limitation to
apologise for: this is how you drive the editor while building something, and an MCP endpoint is
not something a deployed page should have. A `postMessage` transport covers the embedded case,
off unless the URL says `?mcp=embed` and answering only the frame that embedded us.

A tool that rejects its arguments comes back as a result with `isError` set, not a JSON-RPC
error. The model is meant to read the message and try again; a protocol error would be handled
by the client instead of reaching it.

### 11.5 The API key problem, stated rather than hidden

The editor is a static site with no backend, so an in-page assistant means the user's own key in
their browser, sent straight to the API. The alternatives were a shared key in the bundle —
public the moment anyone opens devtools — or no assistant at all. localStorage plus a panel that
says so is the honest middle for a developer tool; the moment this ships to people who are not
its authors, the key belongs behind a server, and that is a deployment change rather than an
architectural one.

### 11.6 What this does not change

Scripts an assistant writes run in the same guard-rail sandbox as hand-written ones (§10.2).
Scene JSON was already executable code and still is; a model authoring it neither worsens that
nor fixes it. The real fix is the same one §10.2 names — a Worker or a sandboxed iframe — and it
is still the same piece of work.

---

## 12. External hardware

An Arduino is a host, not a feature. That framing decides most of this section.

### 12.1 The transport belongs to the host, the protocol belongs to the engine

Web Serial is `navigator.serial`, and §2 forbids `navigator` below the editor line — a constraint
that could have been an obstacle and turned out to be the design. The engine holds a
`HardwareTransport` interface (open, close, send, on-data) and knows nothing else; the concrete
pipes live in `editor/hardware/`. A Phase 3 runtime driving a real board from Node implements the
same four methods over a serial port, and everything above — protocol, channels, bindings,
systems — is untouched.

It is exactly the split `input/` already had, and for the same reason §9.5 gives: the engine
describes what it needs and the host supplies it, so the whole stack stays testable and
worker-ready. The loopback transport is not a test double bolted on afterwards; it is what the
editor's simulated rig runs on, which is why the entire feature can be exercised with no
hardware attached.

### 12.2 Lines of ASCII, on purpose

The wire format is text: `A0=512 D2=1` in, `D13=255` out. A packed binary framing would save a
handful of bytes per sample and cost the ability to debug the link with the Arduino IDE's own
serial monitor — which is the first thing anyone reaches for when a rig goes quiet. At 115200
baud the budget is about 190 characters per frame at 60 fps, and `A0=512\n` is seven of them.

The scarce resource is real, though, so both ends manage it. The firmware reports only on change,
with a deadband and a rate cap; the engine never writes an output whose value has not changed,
and every output binding carries its own rate limit. A health lamp at 8 Hz looks identical to one
at 60 Hz and costs a seventh of the link.

### 12.3 A frame sees one snapshot of the rig

Serial arrives on the USB stack's schedule — three lines between two frames, none for the next
four. Inbound lines are therefore queued as they arrive and applied in one pass at the top of
`Engine.tick`, before any system runs. A frame sees one consistent state of the world rather than
a stick that moved halfway through it, and `wasPressed` means "since the last frame" rather than
"since some point in the last 16 ms".

That is the same contract `InputState` keeps for the keyboard, and it is what makes hardware
behaviour reproducible: `HardwareSystem.test.ts` drives a character with a potentiometer, at a
fixed timestep, with no hardware and no timing assumptions.

The pump runs in edit mode too, because calibration is an editing task — watching a channel while
turning a knob should not require pressing Play.

### 12.4 A button is a key, and that is the whole trick

Bindings do not introduce a second input path. `D2 -> key:Space` calls the same
`InputState.setKey` a keyboard event does, so held/pressed/released behave identically and
nothing downstream can tell where the press came from. Continuous controls needed something keys
cannot express, so `InputState` grew named analog axes; `CharacterSystem` sums `move`, `strafe`
and `turn` with its keys rather than choosing between them.

The result is the property worth having: a scene built with a keyboard works with a rig plugged
in, and a scene built for a rig degrades to the keyboard when it is unplugged. Neither needs a
second code path, and neither is a mode.

Making an analog stick agree with the keyboard turned up two bugs that keys alone could not
reveal. `A` strafed right, because `axis('KeyD', 'KeyA')` reads "A minus D" and local +X is
right. And movement was normalised to the unit circle rather than clamped to it — correct for the
diagonal case it was written for, and it rescaled every partial input to full speed, which is
invisible when every input is 0 or ±1. Both are the kind of thing a second input source finds and
a test suite does not.

### 12.5 Devices are not scene data

Nothing about a connection is serialized. Which board is on the desk is not a property of the
level, so scenes reference channels by name (`A0`, or `uno:A0` when a rig has two boards) and run
on anything that provides them. A scene carrying a `HardwareInput` opens on a machine with
nothing attached: channels read zero, the keyboard still works.

Play and Stop do not close ports either — closing a port the user opened by hand because they
pressed Stop would be its own kind of rude. What they do drop is buffered lines, edges, and the
record of what was last written, so the next session re-sends its outputs rather than assuming
the board remembers. Outputs a session lit are zeroed on stop, which is §6's promise extended to
the desk: a lamp still lit after Stop is a play session leaking state.

### 12.6 What this does not attempt

No HID, no Bluetooth, no gamepad — a gamepad is a different API with a different shape, and
pretending it is a serial device would cost more than the second implementation it saves. No
firmware upload. No auto-reconnect, because a board being flashed drops the link and a transport
that redials every second turns a flash cycle into a console full of failures.

And the security position is the one §10.2 already states, extended: a scene file is executable
code, and with a device attached it is executable code with a wire to a pin. Web Serial's
per-port, per-origin, click-gated permission is the real boundary; the engine does not pretend to
add one.

---

## 13. The render pipeline and quality settings

Added in v0.7.3. See [docs/GRAPHICS.md](./docs/GRAPHICS.md) for the operational detail; this
section is the three decisions behind it.

### 13.1 Quality settings are engine data, not editor state

`GraphicsSettings` lives in `engine/render` beside the `RenderHost`, for the reason §2 gives for
the host itself: the editor and the runtime must produce the *same image*, and they can only do
that if everything the image depends on is described in one place both can read. The editor's
Graphics panel holds no state of its own — it is a view onto that object, and a shipped game will
read the same shape out of a config file or a player-facing options menu.

`RenderHost.applyGraphics()` takes the whole object rather than exposing a setter per knob,
because several of the knobs interact: the shadow map size means nothing without a filter, and the
tone mapping curve is what decides whether the offscreen buffer needs to be half-float. A single
apply keeps those decisions in one readable place instead of spread across setters that have to
guess at each other's state. It is cheap to call with an unchanged object, so callers push rather
than diff.

One field escapes the engine: the pixel-ratio cap is *applied* by whoever owns the canvas, because
`devicePixelRatio` is a `window` property and §9.5 says the host must stay constructible from a
worker. The value still lives in the settings; only the multiplication happens outside.

Settings persist per browser and never enter a scene file. How sharp your shadows are is a
property of the machine you are sitting at; what colour the sky is belongs to the scene, and is
already a component (§10.1). Putting antialiasing in the scene would mean opening a colleague's
scene on a laptop and having it try to run at their 8× MSAA.

### 13.2 Antialiasing forces an offscreen buffer, and that decides where tone mapping goes

The WebGL context's `antialias` flag is fixed at context creation. A settings menu built on it can
only say *restart to apply* — and a restart drops every geometry, texture and compiled shader the
editor has uploaded. So the context is created with `antialias: false` permanently and MSAA is
done in a multisampled **render target**, which makes the sample count an ordinary runtime value
and hands us the intermediate image FXAA needs anyway.

That single change has a consequence worth stating plainly, because it is not obvious and it is
where the bugs would otherwise be: **Three applies `toneMapping` and the output colour-space
encode only when drawing to the canvas.** `WebGLPrograms` forces `NoToneMapping` and the linear
working space for every render-target draw. That is correct — an intermediate buffer should stay
linear HDR — but it means the moment the scene goes through a render target, the last pass owns
tone mapping and encoding. `PostProcess`'s resolve pass does, and it does it by including Three's
own shader chunk rather than reimplementing the curves, so the direct path and the resolve path
cannot drift apart.

The same rule is why every custom `ShaderMaterial` in the codebase ends with
`#include <tonemapping_fragment>` and `#include <colorspace_fragment>`. Those resolve *per render
target*: drawing to the canvas they tone map and encode, drawing into the resolve buffer they
compile away to nothing. A hardcoded gamma curve would be right in exactly one of the two paths.
The sky dome (§10.1) and the procedural grid (§9.6) were both missing them and rendered visibly
dark until v0.7.3 — the two places in the project that do not use a built-in material were the two
places the bug could exist.

### 13.3 The rig is not the lights

The graphics settings drive the **placeholder lighting rig** and nothing else. A scene carrying
its own `Light` components sets range, map size, bias and normal bias per light, through the
Inspector, as component data — because in a scene with several casters, "how far do shadows reach"
is a property of each light and not of the renderer. The rig hides itself the moment a scene has a
Light of its own, exactly as §10.1 describes, and the settings go with it.

The global switches — whether the shadow pass runs at all, and which filter it uses — stay in the
settings, because those are properties of the machine.
