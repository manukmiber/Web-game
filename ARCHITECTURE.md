# Architecture — Web 3D Scene Editor → Mini Game Engine

Status: **proposal, awaiting confirmation** (see §8). Nothing in `src/` is built yet.

The single constraint that drives every decision below: the scene that is authored in the
editor today must be *played* by the same code tomorrow. So the core is written as a
standalone, UI-free library, and the editor is one of (eventually) two consumers of it.

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
    components/             component definitions + registry
    render/                 Three.js bridge: Scene data ──▶ Object3D tree
    material/               material definitions → THREE.Material
    assets/                 texture/asset store (id → resource)
    serialization/          toJSON / fromJSON + schema version + migrations
    loop/                   Engine: RAF loop, fixed-step update, system list, mode flag
    systems/                RenderSystem now; ScriptSystem/PhysicsSystem later

  editor/                 ← everything the runtime will NOT ship
    state/                  Zustand store: selection, active tool, snapping, dirty flag
    commands/               command pattern + undo/redo stack
    viewport/               canvas host, OrbitControls, TransformControls, grid, axis widget
    panels/                 Hierarchy, Inspector, Toolbar, AssetBrowser
    styles/                 dark Unity-like theme

  runtime/                ← Phase 3 placeholder. Same engine, no panels.
```

Enforced by lint rule (`no-restricted-imports`): **`engine/**` may never import from
`editor/**`.** That one rule is what makes the Phase 3 split a config change rather than a
rewrite. CI fails if it is violated.

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

Superset of the brief's schema — adds `version` and `assets` so Phase 2 textures and Phase 3
scripts need no migration.

```jsonc
{
  "version": 1,
  "name": "Untitled Scene",
  "assets": [ { "id": "tex_1", "type": "texture", "name": "crate.png", "src": "data:…" } ],
  "entities": [
    {
      "id": "e1",
      "name": "Box 1",
      "parentId": null,
      "transform": { "position": [0,0,0], "rotation": [0,0,0], "scale": [1,1,1] },
      "components": [
        { "type": "MeshRenderer", "primitive": "Box", "params": { "widthSegments": 1 } },
        { "type": "Material", "color": "#ffffff", "alpha": 1, "mode": "Opaque",
          "metalness": 0, "roughness": 0.8, "map": null }
      ]
    }
  ]
}
```

`version` + a `migrations` table means the schema can evolve without breaking saved scenes.

---

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
  menu, full undo/redo, solid-colour material, save/load JSON.
- **Phase 2** — texture slots + upload, alpha modes (Opaque/Transparent/Cutout), paint tool,
  asset browser panel, UI polish.
- **Phase 3** — Play/runtime mode, `Script` component. Out of scope now; §6 is its landing pad.

---

## 8. Open questions (answer before Phase 1 starts)

1. **"Paint"** — texture painting onto UVs, or object/scatter brush? (Default assumption:
   texture painting.)
2. **Persistence** — localStorage only, or a backend?
3. **Textures** — user-uploaded only, or ship a small default library?
4. **This stack** — confirm §1.
