# Architecture — Web 3D Scene Editor → Mini Game Engine

Status: **confirmed** (see §8). Phases 1 and 2 shipped; Phase 3 in progress — the play seam,
scripting, agents and scene-owned rendering are in (§10), the assistant tool layer and MCP
server are in (§11), physics (§15), the ECS layer (§16), audio and save games (§18), physics
and scripting in a Worker (§19) are in, and a first cut of chunk streaming and LOD, on Origo as
the coordinate engine (§20), is in; background chunk load/unload from disk and a terrain or
scatter LOD chain are not.

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
    state/                  Zustand store: selection, active tool, snapping, console,
                            and layout.ts — the panel/dock description (§13)
    layout/                 the dock shell: tab strips and resize handles
    commands/               command pattern + undo/redo stack
    viewport/               RenderHost host + OrbitControls, gizmo, grid, selection
                            outline, light/camera handles, picking, axis widget
    panels/                 Hierarchy, Inspector, Toolbar, StatusBar, Console,
                            PerformancePanel, GraphicsPanel, HardwarePanel,
                            AssistantPanel, ScriptEditor, ScatterEditor
    assistant/              CommandSceneEditor (tools → undo stack), the Anthropic
                            tool-use loop, and the MCP transports
    hardware/               the transports themselves: Web Serial, WebSocket, and the
                            simulated rig EditorContext owns
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
    for (const s of this.systems) {
      if (!s.runsIn.includes(this.mode)) continue;
      this.stats.beginSection(s.name);        // per-system timing, §9.7
      s.update(dt, this);
      this.stats.endSection(s.name);
    }
    this.scene.flushTransforms();   // one event per moved entity, not one per axis
    this.events.emit('afterUpdate', { dt });   // rendering happens in here
    this.input.endFrame();          // press/release edges last exactly one tick
  }
}
```

`dt` itself is computed by `loop/Clock`, not inline in `start()` — it used to be one clamped
subtraction there, and three more things wanted the same timestamp: a `pause()`/`resume()` that
re-anchors on resume so the paused interval never lands in a system's `dt` as one spike, a
`timeScale` for slow motion, and a `smoothDelta` reading for a consumer (a camera, mainly) that
would rather see jitter filtered than raw physics-accurate time. `tick(dt)` itself stays a plain
function of dt in, which is what keeps `Engine.test.ts` able to drive frames by hand with no
`requestAnimationFrame` in sight — `Clock` is the thing that turns real timestamps into that dt,
and it is tested the same way, by feeding it timestamps and reading back what it decided.

**One timestamp, two deltas.** `Clock` reports `rawDelta` beside the dt it returns, and the
distinction is not a nicety — v0.7.9.5 fixed a real bug by drawing it. `tick()`'s return value
answers *how much world time passed*, and it is deliberately not the wall clock: it is capped at
`MAX_FRAME_DELTA`, scaled by `timeScale`, and zero while paused, all so a stalled tab or a slow
motion effect cannot make the solver take a step it was not designed for. Frame *measurement* asks
the opposite question — *how long did this frame take* — and feeding it the simulated number makes
the counter agree with itself and disagree with the machine. A 250 ms hitch arrived at `FrameStats`
as exactly 100 ms, so the reported minimum could not fall below 10 fps whatever happened and the
1% low was bounded away from the truth in exactly the case worth measuring. So `Engine.tick` takes
both (`tick(dt, realDt = dt)`, defaulted so hand-driven callers are unaffected), simulation reads
the first, and `FrameStats` reads the second and nothing else does.

`pause` and `timeScale` are also **session state**, cleared by `setMode` alongside `game.reset()`
and `input.clear()`. A script that slowed time for a death animation, or a session left paused on
the frame someone was staring at, must not follow the editor back into edit mode — the symptom
would be gizmo drags that feel like treacle and look like a rendering bug. Both are surfaced
through a `timeChanged` event rather than polled, because both ends write them: the toolbar's
controls and a script's `time.scale = 0.2` are the same value, and a UI keeping its own copy is a
UI that will eventually lie about what the engine is doing.

Entering Play mode is: snapshot the scene → flip `mode` → the gameplay systems start ticking →
render through the scene's own camera entity instead of the editor camera. Exiting restores the
snapshot. **No engine rewrite, no second renderer, no second scene graph.**

The seam held. Adding scripting, agents and a character controller took no change to this file
beyond three lines: `input`, `game`, and a `reset` hook on `System`. Adding **physics** in v0.7.5
took two more: a `PhysicsWorld` beside `input` and `game`, and a `physics.clear()` in `setMode`.

**Why the world hangs off the Engine and not off the PhysicsSystem.** Three things need it and only
one of them ticks it: the CharacterSystem casts against it to find the floor, scripts raycast and
shove bodies through it, and the PhysicsSystem is simply whoever calls `step`. A world hidden inside
that system would have to be reached through `engine.systems.find(s => s.name === 'PhysicsSystem')`,
which is how a clean seam turns into a service locator. Same argument as `input` and `hardware`.

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
  *Shipped so far:* the play seam itself, scripting, NPC agents, a character controller,
  scene-owned rendering (§10), physics and collision (§15), the ECS layer (§16), audio and
  save games (§18), and physics/scripting moved into a Worker, opt-in (§19). Still open: the
  Cloudflare persistence adapter, streaming, LOD, chunk generation and pathfinding off-thread.

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

The rebase is implemented in the render bridge, i.e. one place. Phase 1 kept origin at zero
behind a single `originOffset` seam in the bridge; v0.7.9.7 (§20) is what drives it, with Origo's
`Origin` deciding when and where to rebase instead of the offset sitting fixed.

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

Chunk streaming and a first LOD band landed in v0.7.9.7, on **Origo**, a standalone coordinate
library — see §20. Background (worker) load/unload from disk is still later work; what exists
today keeps this grid's entities in memory and toggles what's drawn, not what's loaded from a
file.

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

### 9.5 Threading — constraint **now**, cashed for physics and scripting in v0.7.9.6

`engine/**` must stay free of `window`/`document` (§2 already forbids DOM-editor imports;
this extends it to the DOM entirely, enforced by the same lint rule). That keeps chunk
generation, streaming, pathfinding and physics movable into Web Workers later without
untangling them from the browser main thread first.

Physics and scripting moved in v0.7.9.6 (§19) — opt-in, and exactly because of this constraint:
`PhysicsSystem` and `ScriptSystem` had never touched a DOM global, so the Worker migration was
new plumbing around them, not a rewrite of either. `engine/streaming/StreamingSystem` (§20,
v0.7.9.7) was written to the same constraint from day one — it is pure coordinate math over
Origo, with nothing in it that could touch a DOM global — but it still runs on the main thread,
driven once a frame by `RenderHost.render()`. Chunk generation and pathfinding remain later work,
for the same reason instancing was Phase 2 and full streaming still is not: there is content to
stream today, but nothing yet that generates a chunk's content procedurally as the camera
approaches it.

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
editor exposes both through the Performance panel (**F8**).

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

**Two additions in v0.7.5, both because the existing numbers stopped being enough.**

*The 1% low.* `FrameStats` now reports the mean of the slowest 1% and 0.1% of frames as fps, plus
a hitch count. Averaged rather than read off as a single percentile, which is the difference
between the two numbers people both call "1% low": the percentile is one frame and jumps around,
while the mean of the tail is stable enough to compare two builds by. The hitch threshold has an
absolute floor of 8 ms over the median as well as a 2× multiplier, because at 144 Hz twice the
median is 14 ms and nobody notices that — without the floor a fast machine reports constant
stutter.

*Per-system timing.* `beginSection`/`endSection` bracket each system in the loop, keyed by name
rather than pushed onto a stack (the caller is a `for` loop, and a stack would silently
mis-attribute if a system ever nested). "The frame costs 14 ms" is a fact you can do nothing with.
"11 of the 14 are in the PhysicsSystem" is a plan, and it is the difference between the panel being
a readout and being an instrument. A section that stops running records zeroes rather than holding
its last value, so a system that stopped ticking visibly falls to zero.

**And a second instrument, answering a different question.** `engine/perf/SceneStats.ts` walks the
rendered tree once and attributes every triangle to the entity that put it there — split into
meshes, scatter instances, hidden geometry, unique triangles in memory, and the shadow pass
(casters × shadow-casting lights, routinely the largest of the five). `renderer.info` already
reported triangles and draw calls, and they are the two least actionable numbers available: "1.4M
triangles" says the scene is heavy, not that 1.1M of them are one over-subdivided rock duplicated
forty times. It counts what *exists* rather than what was drawn, so the gap between it and
`renderer.info` is itself informative — a scene where the two agree is a scene where frustum
culling is doing nothing.

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

**What is enforced today:** every hook call is wrapped, a throw is reported to the editor console
once and parks that instance, and every other script keeps running. An exception escaping into
`Engine.tick` would kill the loop and with it the editor's viewport — for a typo in one of a
hundred scripts.

**v0.7.9.6 gave scripts somewhere else to run: `engine/worker`, opt-in from the Performance
panel.** That is the "message-based API" migration this section used to describe as a
prerequisite for later — freezing `ScriptContext`'s shape early is what made moving the whole
`Engine` that hosts it into a Worker a plumbing change rather than a rewrite (§19). It fixes the
*other* honest limitation this section names, the one shadowing globals never could: an infinite
loop no longer hangs the tab, because a Worker can be `terminate()`d from outside itself, which
the main thread cannot do to itself. It does **not** turn the guard rail into a security boundary.
`({}).constructor.constructor` still rebuilds the real `Function` from inside the Worker, and a
script that reaches it can call the Worker's own genuine `postMessage` — what changed is that the
Worker's global has no `document`/`window`/`localStorage`/cookies to reach at all, categorically
rather than shadowed, and every message crossing back is validated by shape before anything in it
touches the scene (`worker/protocol.ts`). Scene JSON is still executable code, on either thread.

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

Physics arrived in v0.7.5 — see §15. What is still open: no navigation mesh, and NPC sight is
distance rather than line of sight, so agents steer past each other by luck rather than by the
solver. The state machine is shaped so line of sight and pathfinding slot into `findTarget` and the
movement step rather than needing a rewrite.

The note that used to stand here said a hand-rolled half-physics would be harder to remove later
than a real one is to add now. That judgement is worth revisiting rather than quietly dropping,
because v0.7.5 hand-rolled one anyway. What changed is the scope: §15 explains why a *linear*
solver is a different proposition from a partial one, and what the honest exit is if angular
dynamics ever becomes the requirement.

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
nor fixes it. Moving scripting into a Worker (§19) is the change §10.2 used to name here as the
real fix, and it is worth restating in this section's terms: it does not make an assistant's
scene JSON any more or less trustworthy than a human's, because nothing about *authorship* moved.
What moved is *blast radius* — a runaway tool call that writes an infinite loop into a script now
hangs a Worker the host can recover from, not the tab the assistant panel lives in.

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

### 13.4 A directional shadow frustum follows the view, not the light

A directional light has no position. Only its rotation means anything: it models a source far
enough away that its rays are parallel, so moving one changes nothing about how the scene is lit.
Its *shadow map*, though, has to be a finite box somewhere, and the obvious place to put that box —
around the light entity, where its gizmo is — is wrong in a way that takes a while to see.

It was wrong here until v0.7.8, and the symptom was not "shadows are in the wrong place". It was
shadows vanishing. Drag the sun thirty metres sideways and the shading is pixel-identical, because
the direction did not change; but the ±`shadowRange` box went with the gizmo and left the geometry
behind, so every shadow in the scene disappeared with no control anywhere that looked responsible
for it. Fly far enough from the origin in an unlit scene and the placeholder rig did the same thing,
for the same reason.

So the frustum is placed from the camera: centred `range` ahead of it, so the covered slab runs from
roughly the near clip to twice the range rather than spending half of itself behind the viewer, and
oriented by the light's rotation. The light's own position is then a property of its gizmo and
nothing else, which is what a directional light's position always was.

Two details are not optional. The centre is **quantised to whole shadow-map texels**, in the light's
own basis — a map that slides continuously with the camera resamples every shadow edge every frame,
and the shadows crawl and shimmer as you orbit. And the placement is written to the Three light's
*local* transform, never to the entity's Transform: the bridge reads scene data and writes Three
(§10), and a renderer that wrote camera-dependent positions back into the scene would put them in
the undo history and the save file.

This is a single frustum, which means one resolution across the whole covered range. Cascades —
several boxes at increasing size, chosen per fragment by depth — are the standard answer and arrive
with the streaming work (§9.4); the trade-off `shadowRange` exposes is exactly the one they remove.

### 13.5 Touch is input, so it stops at the same line everything else does

The on-screen movement controls added in v0.7.8 needed no engine code. They set the named analog
axes `InputState` already exposed (`move`, `strafe`, `turn`) and the keys it already had, which is
the same door a gamepad on the hardware bus (§12) or a script comes through. `CharacterSystem` reads
`combinedAxis`, so a touch laptop can drive both at once and neither knows the other exists.

That this was free is §9.5 paying out rather than a happy accident. The engine does not listen to
the DOM, so "input" was already a data structure the host fills, and adding a fourth filler was a
component in `editor/panels`. Had the engine grown a `KeyboardInput` that attached its own
listeners, a phone would have needed a second input path through every system that reads one.

The parts that genuinely are the host's problem stayed there: which gestures the browser is allowed
to claim (`touch-action`), how big a hit target has to be before a finger can hold it, and how far a
tap may travel before it is a drag. §14.5 covers the last two.

## 14. The editor shell

### 14.1 Panels take space; they do not cover the viewport

Until v0.7.4 the editor had two docked panels — Hierarchy and Inspector — and five that were
absolutely positioned over the canvas: Graphics at `left: 10px`, Hardware also anchored to the
left edge, Performance at `right: 10px`, the Assistant also at the right, and the Console across
the bottom. Any two panels on the same side overlapped. Their toggle buttons were `position:
absolute` on the viewport's bottom edge, where they collided with the camera hint and with one
another, and the Performance panel had no button at all.

The rule now is that **a panel takes space from the viewport rather than covering it**. That is
not a style preference; it is what makes the panels usable at the same time as the thing they
describe. Adjusting shadow distance while the panel adjusting it covers the shadow is not a
workflow, and it is why the Graphics panel's explanatory notes — the part that stops people
turning everything up and blaming the engine — went unread as a 314 px column of scrolling prose.

The one thing still drawn over the canvas is the camera hint, which is `pointer-events: none`.

### 14.2 The panels are data

`editor/state/layout.ts` describes every panel: its dock, its label, its icon, its shortcut. Three
consumers are built from that one description — the tab strips (`layout/Dock.tsx`), the status bar
toggles, and the keyboard handler. Adding a panel is one entry there plus a case in the dock's
render switch; it is then reachable by mouse, by tab and by key without touching any of the three.

That was two-thirds true until v0.7.9.5: the status bar kept a hand-written array of panel ids
beside the description rather than deriving one, so a new panel arrived in its tab strip and under
its function key and was absent from the row that exists to say what there is. It flattens
`DOCK_ORDER` over `DOCK_PANELS` now, and `layout.test.ts` checks that walking the docks reaches
every panel — a duplicated list is not caught by types, only by noticing, and this one was not
noticed for four versions.

The alternative is what the code did before: a `visible` flag per panel on the store, a setter per
flag, a close button per panel, and a branch per panel in `useShortcuts` — duplicated across its
edit-mode and play-mode paths, which is exactly why the panel keys had come to behave differently
in the two modes.

Dock geometry (`leftWidth`, `rightWidth`, `bottomHeight`, which panel is frontmost, which docks
are open) persists to `localStorage` beside the graphics settings, and for the same reason §13.1
gives for those: how wide the Inspector should be is a property of the screen you are sitting at,
not of the scene you opened. It never enters a scene file.

### 14.3 Sizes are clamped on write, against the window

`clampLayout` fits a layout into the window it has to live in, and it runs on every write — a
splitter drag, a panel toggle, a window resize, and on load. Two consequences worth stating:

- **The stored number and the rendered width are the same number.** The store is not a request the
  layout might ignore, so a splitter can never show a size the dock does not have. This is the
  same argument §13.1 makes for normalizing graphics settings on write.
- **A layout saved on a 32-inch monitor opens on a laptop.** Both side docks give ground
  proportionally rather than one being cut to nothing, and the bottom dock yields to keep a
  viewport above it. The function is idempotent, so a resize storm settles instead of creeping.

### 14.4 A hidden panel is unmounted, not display-none

The dock renders only its frontmost panel. That is a correctness property, not a rendering
optimisation: the Hardware panel re-renders at 15 Hz off the engine's `afterUpdate` and the
Performance panel polls the render loop four times a second. Under the old floating scheme those
ran for as long as the panel was open, which was easy to leave true for an entire session —
measurement instruments quietly costing frames in the thing being measured.

Unmounting has one cost, and it is the general one: **state a panel needs to outlive its own
visibility cannot live in the panel.** The simulated hardware rig is the case in this codebase, so
it moved to `EditorContext` (§12.5's line about devices not being scene data still holds — it is
host state either way). Held in panel state it would have been forgotten the moment another tab
came forward, leaving its device in the bus with nothing draining its outbound queue and the next
*+ Simulated* adding a second board beside it.

The same reasoning constrains anything added later: a panel may own draft text and scroll
position, but not a connection, a subscription or a queue.

### 14.5 A finger is not a small mouse

Two independent properties get confused constantly, and treating them as one produces a mobile
layer that is wrong on half the devices it runs on:

- **How much room there is.** A window narrower than `DRAWER_BREAKPOINT` cannot lay both side docks
  out beside a usable viewport, so below it they float over the scene instead. The constant is
  derived — both default dock widths plus `MIN_VIEWPORT_WIDTH` — rather than picked, because the
  number that matters is "when does this stop fitting", and a phone in landscape is 844px, which
  sounds roomy and is not.
- **What is doing the pointing.** Hit targets have to grow for a finger whatever the screen size,
  and a 13-inch touchscreen laptop is a wide coarse pointer while a desktop window dragged narrow
  is a narrow fine one. This is a `(pointer: coarse)` question, asked separately.

Under the second heading, and worth stating because each was a bug reported as something else: the
transform gizmo's `size` scales its *picker* geometry along with its arrows, and at the default the
arrows are thinner than a fingertip's contact patch — so a drag meant for an axis lands on the
free-move handle and the object slides across the ground plane. Click-versus-drag needs a larger
threshold, because a tap on glass moves while the finger flattens. And picking fires a small cross
of rays rather than one, because a ray through the centre of a contact patch misses anything thin
even when you are plainly touching it.

---

## 15. Physics

Added in v0.7.5. `src/engine/physics/` is a self-contained simulation: bodies, contacts, a solver,
and the spatial queries built on them. It imports neither Three.js nor the DOM.

### 15.1 Hand-rolled, and the scope is the justification

The note in §10.4 said for two releases that a hand-rolled half-physics would be harder to remove
later than a real one is to add now. v0.7.5 wrote one anyway, so the reasoning has to be better
than "we wanted physics".

What the engine actually needs is that characters fall, stop on floors, slide along walls, and
cannot walk through rocks. Every one of those is *linear*. **This solver has no angular velocity:
contacts never spin a body.** That is the line, and it is what makes the thing tractable —
rotational response needs an inertia tensor per shape, angular impulses at contact points and a
solver that couples the two, which is roughly three times the code here, and the payoff is tumbling
debris.

A dependency was the alternative. `cannon-es` or Rapier would both work, and both cost: a WASM blob
or 150 kB of JavaScript, a second world to keep in sync with the scene, a second set of shapes to
author, and — the part that matters most for §9.5 — someone else's decisions about threading. What
was written instead is about 1,200 lines that read the components directly, run in a Worker without
a single import changing, and can be deleted wholesale if the requirement grows past them. If
angular dynamics ever becomes the requirement, the honest move is a real rigid-body library, not
this file grown by half.

Stated plainly so it is not discovered later: no joints, no continuous collision (a fast body can
tunnel through a thin wall between two steps), and capsule-versus-box is two refinement passes
rather than a full GJK query.

### 15.2 Fixed timestep, and the spiral of death

Physics runs on a fixed step out of an accumulator, never on the frame's `dt`. A variable step makes
the simulation depend on frame rate: the same jump reaches a different height on a 144 Hz monitor
than on a 30 fps laptop, penetration recovery oscillates whenever a frame stutters, and no run ever
reproduces another.

`maxSubsteps` is the consequence you can see. A 400 ms frame owes twenty-four steps; running them
all makes the *next* frame worse, which makes the next one worse again. Hitting the cap discards the
backlog, so the simulation runs slow rather than locking the tab — and reports `throttled` so the
Performance panel can say which happened.

This is also why `ScriptHooks` gained `fixedUpdate`, and why the ScriptSystem asks the PhysicsSystem
how many steps it just ran rather than keeping its own accumulator. Two accumulators with the same
period and different phases would fire `fixedUpdate` twice between some pairs of steps and not at
all between others.

### 15.3 The Collider is not the mesh

Colliding against rendered triangles means a broadphase over a hundred thousand of them, no reliable
inside/outside test for an open mesh, and a collision shape whose cost changes silently every time
someone raises a segment count in the Inspector. Every engine that ships separates the two, and the
cheap primitive is what makes a thousand bodies affordable.

Two consequences worth writing down. **A Collider with no RigidBody is static** — the world rather
than a thing in it — which is the common case and means the simple scene needs one component instead
of two. And the `Plane` collider is an infinite half-space, which is the right shape for the ground
even when the visible mesh is 40 m across: nothing falls off the edge of the world, and it costs
four numbers and no broadphase cell.

### 15.4 Two sources of truth, resolved per field

The solver owns a falling crate's position. The Inspector owns its collider radius, its mass, and
whether someone just dragged it somewhere with the gizmo. Both are genuinely authoritative, over
different fields.

`PhysicsSystem.syncBodies` re-describes every body from the scene each frame and substitutes the
solver's origin for the authored one where the solver owns it. Rebuilding rather than maintaining
through events costs a handful of microseconds per body and removes an entire class of "the collider
did not follow the entity" bug. Velocities and sleep state survive the re-description, because a
body that forgot its velocity every frame would never fall.

Write-back goes the other way: world positions converted back into local space through the parent
chain. `Scene.worldPositionOf` deliberately ignores parent rotation — it only ever needed a chunk
bucket — so `worldTransformOf` in the physics layer does the full composition.

### 15.5 Layers are names

`layer` and `mask` are strings, not a bitmask. A scene file that says `layer: "player"` survives
someone inserting a layer above it, and a bitmask in a text field is unreadable in an Inspector.

Both sides must accept the other before a pair interacts. The asymmetric reading — bullets hit walls
but walls do not hit bullets — produces contacts that resolve on one body and not the other, which
looks exactly like tunnelling.

### 15.6 Sleeping is not an optimisation

Without it a stack of crates jitters forever: the solver's positional correction and gravity trade a
fraction of a millimetre back and forth every step and never agree. So a body that has been still
for `sleepDelay` stops being simulated.

Getting it right needed one distinction that is easy to miss, and did not survive the first draft: a
**moving** body wakes a sleeping one, a resting one does not. Waking both sides of every contact —
the obvious reading of "a contact wakes things up" — resets the sleep timer of a body whose only
contact is the floor it is resting on, so nothing ever sleeps. Meanwhile a sleeper that is never
woken is a ghost: something lands on it and falls straight through, because nothing asked it to push
back. Asking whether the *other* body is actually going anywhere avoids both.

### 15.7 The character controller is kinematic on purpose

A `CharacterController` writes its transform directly and resolves collisions by depenetration:
place the capsule where the input asked, discover what it is now inside, push back out along each
contact normal. It is never a dynamic body, which is the same choice Unity's `CharacterController`
and Godot's `CharacterBody3D` make. A player driven by forces feels like a shopping trolley —
instant stops, air control and a jump that reaches a chosen height are all things a dynamic body
actively fights.

Horizontal and vertical motion are resolved in **one** pass, not two. Two passes is the textbook
arrangement and it produces a character who can climb walls by jumping into them: the vertical pass
sees a wall contact with an upward component and reads it as ground. One pass with an explicit slope
test does not.

The ground probe below the feet is not redundant with the depenetration. A character resting exactly
on a surface produces no overlap at all, so the resolution pass sees nothing and reports airborne —
which becomes a fall, a landing, and a fall again, sixty times a second. The same probe doubles as
the downhill snap, without which walking off the top of a ramp is a series of small hops.

### 15.8 What the tests found

Three bugs in this release's own code, all in the solver, all of the kind only a test finds:

- a resting body's contact reset its own sleep timer, so nothing ever slept (§15.6);
- motion locks held against gravity but not against positional correction — a lock that holds for
  the floor and not for gravity is the less useful half of one;
- a ray cast straight down at a box returned the *far* face's normal, because the swap that orders
  the slab interval was also flipping the entry sign. The entry face is decided by the sign of the
  direction alone.

They are listed because they are the argument for the test suite being integration-level in
`gameplay/physicsScripting.test.ts`: each is about two parts agreeing, and no unit test of either
half can see it.

### 15.9 2D is a constraint, not a second engine

`Physics.mode = '2D'` makes the whole simulation two-dimensional. There is no second solver, no
second collider hierarchy and no second query API.

The alternative is the well-trodden one: ship a parallel 2D engine beside the 3D one. Unity did
exactly that and it left the project with two collider hierarchies, two sets of layer settings, two
raycast APIs and a permanent question about which one a component belongs to. Every feature since
has had to be built twice or admitted to be 3D-only.

The observation that makes the other choice available is that nothing in this solver is
dimensional. Circles are spheres, rectangles are boxes, and sequential impulses do not care how many
axes they run over. So 2D is expressed as four rules, all in `physics/dimension.ts`:

1. Bodies are held on the simulation plane — the depth coordinate is snapped, not integrated.
2. The depth axis is locked, in velocity *and* in positional correction.
3. Gravity is projected into the plane.
4. Contact normals and query directions are projected into the plane and renormalised.

Every one of those is the identity in 3D, which is what keeps the cost of the feature at zero for
scenes that do not use it. `collision.ts` gained nothing.

Two things follow that are worth stating as design consequences rather than as facts. First, every
feature reaches both dimensions at once: triggers, layers, sleeping, restitution, the character
controller, the script API and `explode` have no 2D variant to write because none of them knows
which mode it is in. Second, the plane is a property of the *world*, not of a step — a raycast in a
2D scene has to be flattened whether or not a step is in progress, so it lives on `PhysicsWorld`
rather than in `StepSettings`.

The one subtlety the design pays for is rule 4. An extruded prism — which is what a `Circle` or
`Rect` collider resolves to — can produce a contact normal that leans out of the plane, and
resolving along it pushes the body off the plane where rule 1 drags it straight back, once per step,
forever. Renormalising after the projection is not cosmetic either: a shortened normal
under-resolves the contact by the same factor and the body sinks a little further every step.

## 16. The ECS layer

The data model has been entity-plus-components since Phase 1 (§3). What was missing until v0.7.6 was
both halves of the *system* side: a way to find entities by what they carry, and a way for systems
to declare when they run.

### 16.1 An index, not an archetype table

Every system used to open with `for (const entity of scene.all())` and a `components.find`, which is
O(entities × components) per system per frame. Five systems over a 10 000-entity scene walk the same
ten thousand entities five times to reach the eleven with a collider.

`ecs/ComponentIndex` maintains a type-to-entities map off the Scene's existing events, and
`ecs/Query` resolves `all`/`any`/`none` against it, driving the iteration from the smallest `all`
term. `EcsWorld` caches results against a revision counter that only moves when the index's *shape*
changes — a field edit does not invalidate a query, which matters because dragging a slider emits
`componentsChanged` sixty times a second.

What this deliberately is **not** is an archetype ECS with components packed into parallel typed
arrays. That buys cache locality on top of the lookup, and it costs the data model: components here
are also the serialisation format (§3), the Inspector's model (the field schemas), and the undo
system's unit of work — and unknown component types, which round-trip verbatim so a scene from a
newer build survives an older one, have no shape to pack into at all. The lookup is the
factor-of-a-thousand and costs 200 lines; the packing is a constant factor and costs the model. The
query API is the seam that would let the packing happen later without touching a single system.

### 16.2 Order is declared, not emergent

Systems used to run in the order `installGameplaySystems` pushed them, documented by a numbered
comment. That comment was load-bearing: hardware has to be pumped before scripts read it, the solver
has to step before scripts hear about contacts, agents have to run after the player moved. Inserting
one system in the wrong place breaks all of it silently, and the symptom looks like input lag rather
than like a scheduling bug.

`ecs/Schedule` sorts systems by a declared `stage` — `input`, `simulate`, `script`, `resolve`,
`present`, each a boundary something actually depends on — plus explicit `after`/`before` for the
constraints stages cannot express (the NPC system and the character system both belong in `resolve`,
and one still has to go first).

Three properties a hand-ordered list cannot give:

- A system added by a test or a headless setup lands in the right place without knowing the list.
- A dependency on an absent system is ignored rather than fatal, so `after: ['PhysicsSystem']` does
  not make physics a hard requirement.
- A contradiction is **reported**, not resolved arbitrarily: `Engine` emits `scheduleConflicts` and
  the editor console shows it. Throwing from inside a frame would turn a mis-ordered system into a
  blank viewport, so the frame runs in the order the systems were added and the problem is visible.

With no constraints the sort is stable and reproduces the insertion order exactly, which is what
made adopting it a refactor rather than a behavioural change.

This is also the prerequisite for §9.5. You cannot decide what may run concurrently in a Worker
until the dependencies between systems are written down somewhere other than a comment — which is
exactly the question §19 had to answer to move four of these stages there.

## 17. The PBR material system

### 17.1 Metal/rough, and the one degree of freedom it removes

The `Material` component uses the metal/rough parameterisation — glTF's, Unity's, Unreal's, Godot's.
The older specular/gloss form lets an artist author a physically impossible surface without noticing
(a dielectric with a coloured specular, a metal with a bright diffuse), and those surfaces look
wrong the moment they are lit differently from how they were authored. Metal/rough has one fewer
degree of freedom and the missing one is exactly the impossible one.

The consequence that shapes the rest of this section: **`metalness = 1` means the base colour is the
reflection and there is no diffuse term**, so a metal with nothing to reflect renders black however
many lights are aimed at it. Analytic lights give a metal its highlight; the environment is the rest
of it. A PBR material system without image-based lighting is a set of sliders that do not behave.

### 17.2 The environment comes from the sky the scene already has

`Environment.ibl` prefilters the sky dome's own three-colour gradient into a PMREM environment map
and assigns it to `scene.environment`. On by default.

Generated from the sky rather than loaded as an HDR, for the same reason the sky is a shader rather
than a texture (§9.6): generating an image means a canvas, a canvas means the DOM, and §9.5 forbids
it. It also means reflections and background cannot drift apart, because they are the same three
colours.

The prefiltering is the load-bearing part. A rough metal has to reflect a *blurred* environment, and
one convolution per roughness level is what makes `roughness` behave across its whole range rather
than only at 0. Regenerated only when the colours change — it is a handful of render passes, and per
frame they would show in the frame graph.

Note the gradient shader used for the probe is a second, simpler copy of the sky's, and the
difference is the point: the dome ends with the tone-mapping and colour-space chunks because it is
drawn to the screen (§13.2), and the probe must *not*, because a prefiltered environment has to stay
in linear radiance or every reflection is tone mapped twice.

### 17.3 Two programs, chosen from the data

`MeshPhysicalMaterial` extends the standard one with clearcoat, sheen and transmission, all of which
compile into every fragment whether or not they are used — and transmission additionally makes the
renderer keep a copy of the framebuffer to refract through. So the choice is made per material from
the values themselves (`usesPhysicalFeatures`): all four extension lobes at their defaults gets the
standard program, touching any of them gets the physical one. A scene of painted crates pays
nothing, and there is no shader for an artist to remember to pick.

### 17.4 Every map slot is a private view of the asset

Two problems with one shape. `AssetStore` marks every texture sRGB because it has no idea what a
texture will be used for, which is right for base colour and wrong for normals, roughness, metalness
and occlusion — decoding a normal map as sRGB bends every normal towards the surface, a bug that
looks like an authoring problem. And in Three, `repeat`/`offset` live on the texture rather than the
material, so two materials tiling one asset differently cannot share a texture object.

Both are solved by each material owning a `Texture.clone()` per slot: the clone shares the decoded
`Source` (Three refcounts sources, so the pixels upload once however many materials reference them)
and carries its own colour space and uv transform.

This is what makes disposal a local operation. The previous `disposeMaterial` disposed
`material.map` — the *store's* texture, shared with every other material using that asset — so
releasing one material blanked the texture everywhere it appeared. Owning views rather than
borrowing textures is the fix, and the refcounted cache's `teardown` hook is where it is enforced,
because the cache is the only thing that knows when the last reference went away.

One more consequence: textures decode asynchronously and materials are cached, so
`AssetStore.textureLoaded` now re-resolves the slots of any live material naming that asset.

---

## 18. Audio and save games

### 18.1 The `AudioContext` is built lazily, behind an injectable seam

`engine/audio/AudioEngine` never constructs a real `AudioContext` in its own constructor. Two
reasons, and only one of them is about testing. A browser refuses to start a context until a user
gesture has reached the page — building one at `new Engine()` would hand back a context stuck in
`suspended` for no benefit, so `AudioEngine` builds it on first use instead and `resume()` exists
for the host to call from a click handler. And `AudioContext` does not exist in Vitest's Node
environment at all: constructing it eagerly would make importing the module fail every test that
touches an `Engine`, not only the ones about sound.

The context comes from a `contextFactory` passed to the constructor, the same dependency-injection
seam `HardwareTransport` and `ScenePersistence` already use elsewhere in the engine — production
takes the default (`() => new AudioContext()`), and `AudioEngine.test.ts`/`AudioSystem.test.ts`
hand in a fake that implements only the handful of Web Audio calls this file makes, and record on
it what would otherwise require an ear.

Failure is absorbed at the same seam. If construction throws — no Web Audio support, a
locked-down embed — `AudioEngine` remembers that once and every later call becomes a no-op:
`play` still returns a handle, it is simply inert. The rest of the engine, and every script using
`audio.play(...)`, does not need a "does this browser support sound" branch.

### 18.2 Three buses, one master, no bus for master

`music`, `sfx` and `ambient` each get a `GainNode` feeding into a single master `GainNode` ahead
of `destination`. Master is a separate pair of knobs (`setMasterVolume`/`setMuted`) rather than a
fourth bus, because "turn the music down" and "mute everything" are different gestures a player
reaches for independently, and a mute implemented as one more bus would have to remember to
re-apply itself to a bus fader touched while muted.

The editor's Audio panel drives these directly and keeps no copy of them: every fader writes to
the engine and then re-reads `AudioEngine.snapshot()`. A control holding its own value is a
control that disagrees with what you are hearing the moment a script moves the same level, and
this is a level scripts are expected to move. `snapshot()` is one call rather than five getters
for the same reason: a panel that read `voices` and `state` a frame apart could report "0 voices,
running" about a scene that is audibly playing something. The levels are session state, not
persisted — how loud the score sits under the effects belongs to the game, and the place for it is
the scene, once there is a component to put it in.

### 18.3 Spatial audio reads the same world transform the renderer does

A sound started with a `position` gets a `PannerNode`; the Web Audio listener is moved every
frame by `AudioSystem` from the primary camera's *world* transform (`physics/PhysicsSystem`'s
`worldTransformOf`, the same helper the character controller uses to resolve a parented rig) —
not the local transform, which would put the listener in the wrong place for any camera that is
not a scene root. `AudioSystem` is `present`-staged (§16.2), the one point in the frame reserved
for things that only read: by the time it runs, the character has moved and the agents have
reacted, so a sound started this tick and a listener that just turned a corner both read
correctly.

### 18.4 A voice is an intention before it is a sound

`play()` returns a handle synchronously, and the clip behind it may still be fetching. That is the
right contract — the same one `AssetStore` gives textures — but it puts a gap in the middle of
every voice's life, and everything a caller says during that gap has to be *held* on the voice and
applied when the nodes finally exist. `volume` always was. Two things were not, and both produced
the same class of bug: correct on the second play of a clip and wrong on the first, which is the
hardest kind to reproduce because reproducing it means reloading the page.

`playMusic(url, { fadeSeconds })` reached for the voice's `GainNode` to schedule the ramp, and on
a first play there is no `GainNode` yet — so the crossfade was skipped exactly when a track was
new and honoured once it was cached. `handle.setPosition(...)` was dropped when the `PannerNode`
did not exist yet, against a doc comment promising it would be kept, so a script that played a
footstep and placed it in the next statement got the sound at wherever the entity had been when
`play` ran.

The fix is one idea applied twice: the voice carries `fadeIn` and `position` the way it already
carried `volume`, and `start()` builds its node graph from *the voice* rather than from the
`PlayOptions` it was created with. Options describe one instant; the voice describes now. The
distinction between "this voice is 2D" and "this voice has not been placed yet" is kept as
`position === null` versus a value, so `setPosition` on a UI blip stays the documented no-op
instead of quietly turning it into a spatial sound halfway through.

### 18.5 A component for ambience, a script API for events

`AudioSource` is for the sound that belongs to an object for as long as the object exists — a
torch crackling, a machine's idle hum — driven by `autoplay` and stopped automatically when the
component is disabled, removed, or the entity is deleted. It is deliberately not a general
trigger: "play on death", "play on a footstep every half-second" go through `audio.play(...)` /
`entity.playSound(...)` in the script API instead, the same split `HardwareOutput` (bindings for
the steady case) and `hardware.write` (the script API for everything else) already draw.

`clip` is a URL, not an asset id — there is no `AssetStore` entry for audio the way there is for
textures, because building a second asset pipeline for one field is a bigger change than this
component earns yet. It plays from wherever a texture URL already can (a pasted data URL, a path
the host serves); an audio asset browser is future work, the same gap the README's Materials
section already admits for textures.

### 18.6 A save game is not the Play-mode snapshot, even though both call `scene.load`

§6 already snapshots the scene on entering Play and restores it on Stop, so it is tempting to
reach for the same machinery for "save the game". They are not the same operation. The Play
snapshot always returns to the *authored* scene and always accompanies a mode flip; a save game
freezes whatever was true the moment `captureSaveGame` ran and is loaded back in mid-session, in
whichever mode the engine already happens to be in — "load, then press Play" from a title screen
is two separate actions, not one.

What a save actually needs beyond the scene is exactly what `GameState` deliberately keeps outside
it (§6's "what restored has to cover"): health, factions, script variables. `GameState.toJSON` /
`fromJSON` serialise that half; `gameplay/SaveGame.captureSaveGame` pairs it with `snapshotScene`
(exported from `loop/Engine` for exactly this reuse) to make one JSON-safe record.

`fromJSON` fires a `restored` event, not `reset`. That is the one place a save load and a Stop
must *not* behave alike: `reset` tells every listener — an NPC's wander state, a script's own
closures — to drop what it was doing, because Stop means the simulation is over. A save load
means the opposite: positions and health jump to the saved moment, but *behaviour* keeps running,
the same way a game console's "load" does not restart every enemy's AI from scratch. A listener
that cannot tell the difference would make a loaded save open with every zombie standing still
for a frame while it re-decides what to do.
Without it a material built while its image was in flight stayed untextured for the session.

---

## 19. Physics and scripting in a Worker

Added in v0.7.9.6, opt-in from the Performance panel ("Run in a Web Worker"). §9.5 named the
constraint that made this possible in Phase 1, §16.2's system schedule was the prerequisite it
named, and §10.2/§15.1 both promised this specific migration would be plumbing rather than a
rewrite — this section is that promise cashed, and what it turned out to actually cost.

### 19.1 What moved, and what stayed, and why the line is drawn there

`PhysicsSystem`, `ScriptSystem`, `CharacterSystem` and `NpcSystem` — the `simulate`/`script`/
`resolve` stages, exactly the systems §16.2's schedule already named as a unit — now optionally
run inside `engine/worker`'s simulation Worker. `HardwareSystem` and `AudioSystem` do not, and
not as a simplification: Web Serial and Web Audio are both main-thread-only APIs (a Worker has no
`navigator.serial` and, at the time of writing, no `AudioContext` at all), so there is nowhere for
them to run *except* the main thread. What makes leaving them there correct rather than merely
convenient is that both only need this frame's scene and game state — `HardwareOutput` bindings
read `game.health`/`game.getVar`, `AudioSystem` reads camera and `AudioSource` transforms — and
the worker mirrors both back every tick regardless (§19.3). Neither system loses anything by
being a frame later than the systems that moved; a `health01` lamp binding one host frame stale is
not a thing a person can perceive.

`engine/worker/SimulationEngine` is, deliberately, not a parallel implementation of physics or
scripting. It constructs an ordinary `Engine`, installs the same four systems
`installGameplaySystems` installs, and calls `setMode('play')` — the same object graph Play mode
already builds on the main thread, just hosted somewhere else. §15.1's claim that the solver
"runs in a Worker without a single import changing" turned out to be exactly true, and so did the
same claim implicitly made for `ScriptSystem`: neither file changed at all to make this possible.

### 19.2 The clock is the same `Clock`, driven the same way

`Engine.start()` drives itself with `requestAnimationFrame`, which §6 already called out as the
one genuinely main-thread-only part of the loop — not because the *work* can't move, but because
the clock that ticks it has no Worker equivalent to sync to. Rather than teach `Engine` a second
driving mechanism, `simulationWorkerEntry.ts` polyfills `requestAnimationFrame`/
`cancelAnimationFrame` on the Worker's global scope with a ~60 Hz `setTimeout` before calling the
ordinary `engine.start()` — a Worker has no display to sync a frame to, so a fixed timer is what
"as fast as the main thread would ask for a frame" means without one. The payoff is that
`pause`/`resume`/`setTimeScale` and every script's `time.scale` work completely unmodified: they
already only ever talked to `Engine`'s own `Clock`, and that `Clock` does not know or care which
thread is calling `tick`.

### 19.3 The wire format: a dense channel for transforms, an ordered log for everything else

Two things cross the boundary every tick, and they are shaped differently on purpose.
**Transforms** change for a large fraction of entities every single frame, so they travel as a
flat `TransformUpdate[]` built straight from `Scene`'s existing dirty-transform tracking
(`markTransformDirty`/`flushTransforms`, §6) — no new bookkeeping, just a subscription to the
event that already exists. **Everything structural** — an entity spawned, removed, renamed,
reparented, or one of its components edited — is comparatively rare, so `worker/sceneMirror.ts`'s
`SceneOpCollector` batches it into an ordered `SceneOp[]` log instead, replayed on the host's
`Scene` in emission order (`applySceneOps`). That replay is the same "write straight through
`Scene`, not through a command" path Play mode already uses for `scene.spawn`/`entity.destroy()`
(§6) — a worker-run script's mutation is not a new *kind* of write, only a new thread for one
that already existed and was never on the undo stack.

`componentsChanged` is deduplicated to one op per entity per tick rather than one per field write,
which is safe *because* `Scene` never reassigns an entity's `components` array — only splices and
pushes into it (`addComponent`/`removeComponentAt`) — so an op captured once and read at
`postMessage` time (when the browser's structured clone actually copies it) reflects every edit
made before that point for free.

### 19.4 Audio and hardware are relayed, not reimplemented

A script's `audio.play(...)` inside the worker calls `ScriptAudio`, which calls whatever
`Engine.audio` is — on the main thread a real `AudioEngine`, inside the worker
`worker/RelayAudioEngine`. The interesting decision is what `RelayAudioEngine` is *not*: not a
duck-typed reimplementation of `AudioEngine`'s public surface, but a subclass that overrides only
the handful of public methods `ScriptAudio` reaches (`play`, `playMusic`, `stopVoice`,
`setVoiceVolume`, `setVoicePosition`, the bus/master setters) to record a command instead of
touching Web Audio. Subclassing rather than duck-typing is what keeps the real `AudioHandle` class
usable unmodified — its methods call back into `isPlaying`/`stopVoice`/`setVoiceVolume`/
`setVoicePosition`, which are public on `AudioEngine`, so overriding just those four (plus the two
that mint a voice id) is enough for the whole handle to work without knowing it is talking to a
relay. `worker/RelayAudioEngine.applyAudioCommands` is the host-side replay: it correlates the
relay's local voice ids with the real `AudioHandle`s `engine.audio.play(...)` actually produces,
so a later `stopVoice` for the same id reaches the same sound.

Without this, every script-triggered sound would go silent the instant worker mode was turned on
— not a documented limitation but a straightforward regression, since `AudioEngine`'s existing
"no `AudioContext` available" no-op (§18.1) would otherwise swallow it with no error at all.

Hardware needed no equivalent relay. `HardwareSystem` stays host-side (§19.1), so `HardwareInput`/
`HardwareOutput` bindings are unaffected. A script's *direct* `hardware.*` calls, running inside
the worker against the worker's own real (but deviceless) `HardwareBus`, see the same "nothing
attached" defaults — 0, `false`, writes that return `false` — that the same script would see on a
machine with no rig plugged in, which SCRIPTING.md already documents as a scene that "stays
playable without one." That is a real, honest limitation (a script's own `hardware.write` does not
reach a physical board while worker mode is on) rather than a silent one, and it is narrow: the
common case, a binding, is unaffected.

### 19.5 What the isolation is, stated as plainly as §10.2 states the sandbox

Moving execution to a Worker does not turn §10.2's guard rail into a security boundary — nothing
in JavaScript can. `({}).constructor.constructor` still rebuilds the real `Function` from inside
the Worker, and a script that reaches it can call the Worker's own genuine `postMessage`,
bypassing `worker/protocol.ts`'s wrapper entirely. What changed is what forging a message can
*reach*: a Worker's global scope has no `document`, `window`, `localStorage`, `sessionStorage` or
cookies at all — categorically absent, not merely shadowed the way the main-thread sandbox
shadows them — so there is no DOM and no page state on the other side of that bypass to touch,
whatever a script manages to call. `sandbox.ts`'s shadow list grew to match: `close`,
`addEventListener`, `removeEventListener`, `dispatchEvent`, `BroadcastChannel`, `MessageChannel`
and `MessagePort` join the globals already shadowed, closing the *accidental* path even though
the deliberate one — genuinely hostile code doing this on purpose — was never something a
parameter name could close.

`SimulationHost` (the main-thread half) treats every inbound message as untrusted regardless:
`worker/protocol.ts`'s validators check shape — right `type`, right field types — before a single
value is applied to `engine.scene`, and a message that fails is dropped rather than guessed at. A
malformed *element* inside one tick's `ops`/`console`/`audio` (a script's own bad data, not
necessarily an attack) is dropped individually rather than discarding the whole frame's transform
updates over it.

### 19.6 The watchdog: what a Worker gives you that the main thread cannot give itself

This is the fix for the *other* honest limitation §10.2 and SCRIPTING.md both name: a `while
(true) {}` in a script hangs the tab, because nothing on the main thread can interrupt synchronous
JavaScript running on it. A Worker changes that not by making the loop interruptible — it still
is not — but because a Worker can be `terminate()`d **from outside itself**, a capability the main
thread does not have over itself. `SimulationHost` tracks how long it has been since the worker
last reported in; past a configurable timeout (default 4s — generous relative to a real frame, so
this is about tolerating a slow device or a backgrounded tab's timer throttling, not about
detecting a hang quickly) it terminates the worker, reports why to the console through the same
`ScriptSystem.events` emitter script errors already use, and respawns a fresh worker initialised
from the host's current scene. An uncaught error escaping the worker's own `self.onerror` triggers
the same recovery immediately, without waiting out the timeout.

Proven rather than asserted: a real `while (true) {}` script, in a real browser, with worker mode
on. The editor kept answering clicks — the pause button toggled normally — while the worker sat
hung, and the watchdog recovered it a few seconds later with no reload and nothing touching the
main thread. If the underlying script is still broken, the fresh worker hits the same loop and
the cycle repeats, visibly, in the console, rather than failing silently once and going quiet.

### 19.7 Keeping a system alive without disposing it

Turning worker mode on could not simply `removeSystem` the four main-thread originals: `Engine.
removeSystem` calls `dispose()`, and `ScriptSystem.dispose()` clears its `events` emitter — the
same emitter the editor's Console panel subscribed to once, on mount, and never resubscribes to.
Disposing it would have made worker mode a one-way trip: turn it on, and the Console panel loses
script output forever, including after turning worker mode back off. `Engine.setSystemExcluded`
(new) is the fix — it skips a system's `update` without removing or disposing it, so the four
originals keep existing, keep their listeners, and (because `FrameStats` already reports zero for
a section that stopped running, §9.7) the Performance panel shows exactly what happened with no
change needed there either. Turning worker mode back off un-excludes them; each resyncs itself
from the current scene on its next `update` exactly as it would on a fresh Play press
(`PhysicsSystem.syncBodies`/`ScriptSystem.syncInstances` already treat "everything here is new"
as their steady-state behaviour, not a special case), so no separate hand-off code was needed for
that direction either.

### 19.8 No schema change, and no change to the four systems under test

Nothing here touches the scene format or `GameState`'s save shape (`GameState.syncFrom` is new,
but it is the same replacement `fromJSON` already does, without the `restored` event a
per-tick mirror would otherwise fire sixty times a second). And a session that never turns worker
mode on runs the exact code path it ran in v0.7.9.5 — `PhysicsSystem`, `ScriptSystem`,
`CharacterSystem` and `NpcSystem` are untouched, so every existing test of any of them, including
the integration-level `gameplay/physicsScripting.test.ts` (§15.8), still exercises the real
main-thread path with no change and no new indirection. The worker path is additive and is tested
the same way the rest of this codebase tests things it cannot run headlessly in Node:
`SimulationHost` against an injectable fake `Worker`, the exact seam `HardwareTransport` and
`AudioEngine`'s `contextFactory` already use (§12.1, §18.1), and `SimulationEngine`'s own
frame-building logic driven by hand with `engine.tick(dt)`, the same way `Engine.test.ts` always
has — neither needs a real Worker to be a real test of what crosses the boundary.

## 20. Chunk streaming and LOD, on Origo as the coordinate engine

Added in v0.7.9.7. §9.2 fixed the schema in Phase 1 — a uniform chunk grid, `WorldSettings.
chunkSize`, a chunk-addressable save format — and deferred the systems that would actually use it
to "Phase 3." This is those systems' first cut: what stays resident as the camera moves through a
world too large to keep entirely loaded, and what the render bridge rebases around while it does.

### 20.1 Why an external library, and why this one

The two questions this section answers — *which chunk does this position fall in* and *where
should the render origin be* — are exactly the two questions Origo (`github:manukmiber/origo`, a
standalone sibling repository) exists to answer and refuses to answer any others. Its own
boundary rule, "Origo never learns what is stored at a coordinate" — no mesh type, no entity, no
component crosses its API — is the same rule §9.5 already enforces on `engine/**` from the other
direction: nothing in the engine may assume a DOM, and nothing Origo touches may assume this
engine. Building the same ladder-and-active-set machinery a second time inside `engine/streaming`
would have meant maintaining a second copy of exactly the kind of allocation-free, sign-safe index
arithmetic Origo's own test suite exists to pin down (negative coordinates, Float32-vs-Float64
precision at the exponent boundaries) — the sort of code that is easy to get subtly wrong once and
tedious to get right twice.

It is not on npm yet, so the dependency in `package.json` is a pinned commit on Origo's own
`github:` URL rather than a version range. Origo's `package.json` gained a `prepare` script for
exactly this: npm skips a git dependency's `build` script but always runs `prepare`, and without
one a consumer installing straight from the repo got a `dist/` that was never compiled.

### 20.2 `engine/streaming/StreamingSystem` — pure coordinate math

Three pieces of Origo, wrapped around `world.chunkSize`:

- A `Ladder` whose finest tier is sized to the chunk size (`finestExpFor` rounds a non-power-of-
  two `chunkSize` to the nearest one — Origo's ladder is power-of-two by construction, §3 of its
  own architecture doc — so `StreamingSystem.chunkSize` is the grid's *effective* size, which for
  the shipped default of 256 is exact).
- An `ActiveSet` at that tier for chunk load/unload. Cells enter within a configurable radius and
  exit only past `radius + hysteresis`, so a camera parked on a chunk boundary does not thrash the
  consumer's mount/unmount path every frame — hysteresis Origo already built in, not reimplemented
  here.
- An `Origin` for the render rebase, replacing the `originOffset` seam that sat fixed at zero
  since Phase 1 (§9.1).

One method, `update(camX, camY, camZ)`, is the whole per-frame contract: it returns the frame's
origin shift (`null` on all but a handful of frames — Origo's own note, still true here, is that
at a 1 km threshold and 10 m/s this fires roughly once every hundred seconds) and a `Map` of every
*currently loaded* chunk to its LOD band, recomputed in full each frame. That recomputation is
deliberately not incremental: the loaded set is bounded by the load radius, not by how large the
scene is, so walking all of it every frame is cheap regardless of whether the world has a hundred
chunks or a hundred thousand, and it avoids a second, separately-maintained notion of "which
chunks changed" alongside the enter/exit diff Origo's `ActiveSet` already reports.

`StreamingSystem` imports nothing from Three.js or `Scene` — a camera position in, a diff out —
and is unit-tested exactly the way Origo tests itself: no DOM, no renderer, `vitest run` in Node.
`chunkKeyAt` deliberately produces the same `"cx,cz"` string `scene/types.ts#chunkKeyFor` does
(both floor-divide by the same cell size), so the save format's existing chunk bucket and the
streaming grid's chunk bucket are the same bucket, not two that happen to agree today.

### 20.3 `RenderBridge.updateStreaming` — root entities only

Called once per frame by `RenderHost.render()`, before the shadow budget and the draw — the same
calling convention `applyShadowBudget` already used, for the same reason: everything downstream
that frame should see this frame's streaming state, not last frame's.

It applies the origin shift through the existing `setOriginOffset`, and toggles `Object3D.visible`
on a **root** entity's group when its chunk crosses the load/unload boundary. Only roots: a
non-root entity already inherits the origin offset from its parent through Three's ordinary
render-tree cascade (`syncTransform`'s `isRoot` check has relied on that since Phase 1), and
extending the same inheritance to streamed visibility means a compound object — a vehicle and its
wheels, a building and its windows — streams and rebases as the one unit it already renders as,
with no per-child chunk bookkeeping. The cost is a documented, deliberate gap: a static child does
not get its *own* chunk membership recomputed independently of its root, so a hierarchy that moves
a long way without its root's own transform changing could show a child slightly out of step with
where its true world position would place it. That is the same "approximate bucket, exact
transforms are the render bridge's job" trade-off §9.2 already made for `chunkKeyOf`, extended to
one more consumer.

`pickables()` now excludes streamed-out nodes. Three's `Raycaster` does not check `.visible` on
its own — nothing between the raycaster and an object's `raycast()` method does — so without this
change an unloaded chunk stayed clickable: a hit on geometry nothing that frame was drawing.

### 20.4 LOD today means shadow-casting, and says so

A loaded chunk beyond the configured near band keeps rendering at full geometry — there is no
coarser mesh to fall back to yet, since neither the scatter LOD chain §9.3 shaped the prototype
list for nor the terrain clipmap §9.4 named exist — but it stops casting a shadow. The authored
`MeshRenderer.castShadow` is recorded on the node (`EntityNode.baseCastShadow`) independently of
the LOD override in `applyLod`, so a chunk's shadow comes back exactly as authored the instant its
band improves, rather than the override and the authored value fighting over the same field the
way an easy first implementation would have let them.

This is a real if modest saving today — fewer shadow-map draws for geometry already far enough to
not need one — and it is deliberately the whole of "LOD" for this version. The band Origo hands
back per loaded chunk is what a scatter instance-density falloff or a terrain clipmap would key off
without redoing the distance math, which is the point of computing it centrally rather than letting
each future consumer derive its own notion of "how far is this."

### 20.5 What this does not do yet

Named here rather than left implicit, the same way §9.3 and §19 name their own open edges:

- **Physics and scripting do not hear about unloaded entities.** Origo's own stance (its
  ARCHITECTURE.md §6.4) is that a Float64 solver never needs origin rebasing — true here, every
  solver in this codebase is plain JavaScript — but *streaming* is a different question from
  *rebasing*, and this cut answers only the second for anything other than rendering. A
  streamed-out entity's `RigidBody` keeps simulating.
- **Scatter layers have no LOD chain of their own.** A `ScatterLayer` streams and rebases with its
  owning entity (§20.3's inheritance covers it) but every instance in it renders at one density
  regardless of distance.
- **Nothing streams from disk.** "Chunk" still means "a bucket of entities already loaded into
  the `Scene`," not "a file fetched as the camera approaches." §9.2's background (worker)
  load/unload is still later work, and needs the persistence adapter named in §8 before it has
  anything to load from.
