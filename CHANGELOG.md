# Changelog

This file exists so a new session — human or Claude — can catch up on *what changed and why*
without replaying `git log` or re-deriving decisions from source. Two rules keep it useful:

1. **Every release gets an entry before it's tagged.** "Current version" always matches the
   latest `release/vX.Y.Z` branch (see [Versions](#versions) below); "Next version" is the
   working plan for what comes after it, kept current as work happens, not written
   retroactively.
2. **Write the *why*, not a commit-message diff.** If a change fixed a bug, name the failure it
   fixed. If it's a design decision, name the alternative it rejected and why. The commit
   history already has the diff.

For the modeling subsystem specifically (primitives, modifiers, topology, edit mode), see
[`docs/MODELING.md`](docs/MODELING.md)'s own Status section — it tracks the same
shipped/in-progress/not-started split at finer grain than this file bothers with.

**A note on parallel work.** v0.3.0 and v0.4.0 were done on a separate branch
(`claude/web-3d-scene-editor-ugc0a4`, PR #1) at the same time this branch was fixing the gizmo.
The two didn't overlap in what they touched, so v0.5.0 is this branch's work rebased onto the
tip of that one — see the note at the bottom of the v0.5.0 entry.

---

## Next version (v0.6.0 — planned, not started)

Goal: edit mode. This is the largest remaining gap against Blender/C4D/SketchUp parity — right
now an object is only ever a whole primitive-plus-modifiers; there is no way to select a face
and push it.

- [ ] `engine/mesh/editing/` operations: extrude (region + individual faces), inset,
      vertex/corner bevel, loop cut, merge-by-distance, bridge, flip normals, per-selection
      shade smooth/flat. Pure functions over `MeshData` + `Topology`, same shape as the
      existing modifiers.
- [ ] Edit-mode UI in `src/editor/`: vertex/edge/face selection rendering and box-select, the
      operations wired to the existing gizmo (`GizmoController`/`TransformSession` already
      support arbitrary point sets in principle — element transforms are the first real test of
      that), and an operations panel wired through the undo/redo command pattern.
- [ ] Test and wire in the selection scaffolding already checked in
      (`engine/mesh/editing/selection.ts` — see the warning in `docs/MODELING.md`'s Status
      section; it has no test coverage yet).

After edit mode: Boolean CSG as a modifier referencing another entity, Light components
replacing the hardcoded lighting rig in `RenderHost.buildDefaultLighting`, and scene
environment settings (sky, ambient, fog).

---

## v0.5.0 — Transform gizmo rewrite

*(`release/v0.5.0`, this branch, 2026-07-26)*

**What changed:** Dragging a move/rotate/scale handle either did nothing visible or quietly
corrupted the object — the bug report that started this round of work. Root cause was three
separate faults in the seam between three.js's `TransformControls` and the scene data:

- The orbit camera fought every drag. Orbit was suspended a frame late, from inside the render
  loop rather than at grab time, so the first pointer moves of a drag orbited the camera *and*
  moved the handle at once.
- Rotating produced unreadable angles. The old code re-derived the transform every frame by
  decomposing a world matrix, and `THREE.Euler.setFromQuaternion` always returns the branch
  with Y in `[-90°, 90°]` — turning a box 94° about Y read back as `(-180, 86.2, -180)`.
- Scaling silently rotated the object. A world-axis scale on a rotated object is a shear, which
  position/rotation/scale cannot represent; the old code built the sheared matrix anyway and
  let `decompose()` absorb the shear into rotation — dragging a 45°-rotated box's X scale
  handle moved its rotation to 42.7°.

**What it is now:** The gizmo is built in-house (`src/editor/viewport/gizmo/` +
`GizmoController.ts`) rather than delegated to `TransformControls`:

- Pointer capture happens on a capture-phase `window` listener, ahead of the orbit controls.
- `TransformSession` records each entity's starting pose once per drag and recomputes every
  frame from that snapshot rather than accumulating deltas, and each mode writes only its own
  transform channel — move never touches rotation, scale never touches rotation.
- Rotation resolves to the Euler triple nearest the pose the drag started from (the
  `(x,y,z) ≡ (x+180, 180-y, z+180)` identity), so angles read sensibly and run continuously
  past 180° instead of flipping sign.
- Scale always orients to the object's own axes — the same rule Unity applies — because those
  are the only axes a non-uniform factor can apply to without a shear; a multi-selection whose
  members disagree on rotation falls back to a uniform factor instead of approximating one.
- Added: hover highlighting, plane/screen-space handles, an axis guide line during an axis
  drag, a live numeric readout while dragging, and Escape to cancel a drag back to its start.

**Tests:** `src/editor/viewport/gizmo/transformMath.test.ts` and `TransformSession.test.ts` —
36 tests, including one that reproduces the exact `(-180, 86.2, -180)` regression and one that
reproduces the 45°→42.7° scale-shear regression, both against the old code's approach.

**Verified interactively** with a scripted Playwright session driving the actual dev server
(mouse-drag each handle, read the Inspector fields back) — not just unit tests against the math.

**Also checked in, not yet wired anywhere:** `engine/mesh/topology.ts` (mesh adjacency queries
— tested) and `engine/mesh/editing/selection.ts` (edit-mode selection rules — typechecks, no
tests yet). Groundwork for v0.6.0's edit mode; see `docs/MODELING.md`'s Status section for the
exact line between "shipped" and "checked in but unverified."

**Branch note:** this version's commit is v0.4.0's gizmo-fix commit rebased onto
`claude/web-3d-scene-editor-ugc0a4`'s tip rather than onto `main`, because that branch (PR #1,
still open) had already gone further than `main` — the Torus/Bevel work below — by the time
this fix was ready, and rebasing kept both instead of forking a second incompatible v0.4.0.

## v0.4.0 — Torus, Tube, Icosphere primitives; Bevel and utility modifiers

*(`release/v0.4.0`, commit `e586a0d`, PR #1, 2026-07-26)*

Nine primitives now (added Torus, Tube, Icosphere) and eleven modifiers (added Bevel — rounds
an edge by insetting faces and bridging the gaps — plus Weld, Triangulate and Shade Smooth/Flat
as stack utilities). Scene schema moved v1 → v2 with a migration: `MeshRenderer` gained the
`modifiers` array, and Plane's second axis was renamed `height` → `depth` since it lies in XZ.

Several correctness bugs were caught by testing rather than by reading the code, worth naming
because the *how* generalizes:

- Sphere, capsule and tube windings were inverted — invisible until lit.
- The torus was inside out too, and the original winding test (centroid · normal) passed it
  anyway — that test only holds for convex shapes, and a torus face on the inside of the ring
  legitimately points back toward the axis. Replaced with signed volume via the divergence
  theorem, which is correct for any closed surface and caught the torus immediately, plus a
  directed-edge-pairing check that catches holes and individually flipped faces a global volume
  figure would average away. See `ARCHITECTURE.md` §3b for the general lesson.
- Catmull-Clark pulled open-mesh corners inward — a Plane shrank away from its own border every
  subdivision level. Corners are pinned now.
- `weldVertices` silently dropped the UV attribute.

## v0.3.0 — Editable quad meshes and modifier stack

*(`release/v0.3.0`, commit `b07d3a7`, PR #1, 2026-07-26)*

Primitives switched from opaque triangle geometry to hand-authored editable quad meshes
(`engine/mesh/generators.ts`), unlocking a non-destructive modifier stack: Subdivide (full
Catmull-Clark), Mirror, Array, Solidify, Twist, Bend, Taper, Noise Displace. See
`docs/MODELING.md` for the pipeline and the reasoning for quads over triangles. Also added: CI
running typecheck/tests/build on every push and PR.

## v0.2.0 — RenderHost + performance harness

*(`release/v0.2.0`, commit `8109c18`, 2026-07-26)*

Extracted `RenderHost` so the editor viewport and the (future) game runtime share one renderer
instead of the editor owning a `WebGLRenderer` the runtime would have had to duplicate. Added
the performance measurement harness (`engine/perf/`) — fps/frame-time HUD, stress-test presets
(forest: many instances of few meshes; city: many unique meshes) — that a future triangle/
rendering budget pass will build on.

## v0.1.0 — Phase 1 editor MVP

*(`release/v0.1.0`, commit `a6b486d`, 2026-07-26)*

First working editor: primitives (Box/Sphere/Plane/Cylinder/Capsule/Cone/Empty), the original
(since-replaced) transform gizmo, hierarchy panel with drag-to-reparent, Inspector, undo/redo,
local-storage autosave, JSON export/import.

---

## Versions

Each version above has a `release/vX.Y.Z` branch at the exact commit it describes, so a
regression can always be isolated by checking out the last version known to be good:

```bash
git checkout release/v0.5.0   # this version
git checkout release/v0.4.0
git checkout release/v0.3.0
git checkout release/v0.2.0
git checkout release/v0.1.0
```

These branches are checkpoints, not integration targets — ongoing work happens on a feature
branch and merges via PR. Do not commit directly to a `release/*` branch; cut a new one instead
when the next version ships.
