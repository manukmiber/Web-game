# Modeling subsystem

This file is self-contained on purpose: a session working on primitives, modifiers, or edit
mode should be able to read *only this file* plus the source files it names, without pulling
in [`ARCHITECTURE.md`](../ARCHITECTURE.md)'s scene graph, rendering, serialization, or
networking sections. If you're here to add a modifier or an edit-mode operation, you
shouldn't need anything else.

For everything that isn't mesh data — the entity/component model, the render bridge, undo/redo,
the engine loop, world streaming — see `ARCHITECTURE.md` instead. That file now only summarizes
§3b and points here.

## Where the code lives

```
src/engine/mesh/
  MeshData.ts              Core data type + primitive editing helpers (weld, merge, deform...)
  generators.ts             Primitive → MeshData (9 primitives — see below)
  topology.ts                Adjacency: edges, vertex/edge/face neighbours, face fans, boundaries
  modifiers/
    registry.ts               Modifier registration + the apply-in-order pipeline
    subdivide.ts, bevel.ts, mirror.ts, array.ts, solidify.ts,
    deform.ts, utility.ts     One file per modifier (or family — utility.ts holds three)
  editing/                    Edit-mode operations (extrude, inset, loop cut, ...) — not started
    selection.ts               Vertex/edge/face selection + the mode-switch normalisation rules

src/engine/render/geometry.ts   Evaluates primitive → modifiers → BufferGeometry, with caching
src/editor/panels/ModifierStack.tsx   Inspector UI for the modifier stack
```

## The pipeline

```
primitive params ──▶ MeshData (quads) ──▶ modifier stack ──▶ BufferGeometry (triangles)
```

`MeshData` (`engine/mesh/MeshData.ts`) is vertices plus **polygon faces**, not a triangle soup.
Quads, specifically, wherever a generator can produce them. This is the load-bearing decision
for everything downstream:

- Catmull-Clark subdivision on triangles produces pinched, uneven surfaces; on quads it doesn't.
- Extrude, inset and bevel are face operations — a triangulated cube has twelve faces to push
  instead of six, and the result would be wrong.
- Edge loops only exist in quad topology at all.

Triangulation (`toBufferGeometry`) happens exactly once, at the very end, when building the
render geometry. Nothing upstream of it ever sees a triangle.

**The modifier stack is non-destructive.** Each modifier is plain serialisable data
(`{ type, enabled, ...params }`); behaviour lives in a registry keyed by `type`
(`engine/mesh/modifiers/registry.ts`), the same pattern the component system uses. Order is
meaningful and editable — Mirror then Array tiles a mirrored pair, Array then Mirror mirrors a
whole row. A modifier is one file plus one `registerModifier` call; no Inspector, serializer or
undo-system change is needed to add one, and an unknown modifier type is skipped on load rather
than throwing, so a scene from a newer build still opens in an older one.

**The cache key** (`engine/render/geometry.ts`'s `geometryKey`) covers the primitive, its
*relevant* params (a Sphere's `radialSegments` doesn't fragment a Box's cache), and the whole
enabled-modifier stack serialised. `meshStats()` runs the same evaluation outside the GPU cache
so the Inspector can show live vertex/face/triangle counts — a modeller needs to see what a
modifier costs before deciding to keep it.

## Primitives (9)

Box, Sphere, Icosphere, Plane, Cylinder, Capsule, Cone, Torus, Tube — all hand-written quad
generators (`engine/mesh/generators.ts`) with segment controls, not THREE's triangle-only
geometry classes.

Torus has the cleanest topology of the set — every vertex valence four, no poles — which makes
it the shape to check a new modifier against before trusting it on anything else. Icosphere
sits alongside the UV sphere because its triangles are near-uniform everywhere, where a UV
sphere crowds vertices at the poles and stretches them at the equator.

## Modifiers (11)

| Modifier | What it does |
| --- | --- |
| Subdivide | Full Catmull-Clark, up to 4 levels, correct open-mesh and pinned-corner rules |
| Bevel | Rounds an edge by insetting faces and bridging the gaps, 1–6 segments |
| Mirror | Reflects across X/Y/Z, welding the seam so it stays one smooth surface |
| Array | Repeats with relative and constant offsets |
| Solidify | Gives a surface thickness, closing open borders with rim faces |
| Twist / Bend / Taper | Deformers, parameterised against the object's own bounds |
| Noise Displace | Deterministic, position-hashed so welded seams do not tear |
| Weld | Merges vertices by distance — closes seams other modifiers leave split |
| Triangulate | Fans n-gons into triangles as real topology, not just at render time |
| Shade Smooth / Flat | Overrides per-face shading for the whole mesh |

Bevel is the one that makes rendered geometry stop looking like programmer art — real objects
have no perfectly sharp edges, and a bevel is what gives an edge a highlight to catch.

## Topology (`engine/mesh/topology.ts`)

Adjacency the editing operations need, derived from a `MeshData` on demand rather than
maintained incrementally — operations rewrite indices wholesale, and an incremental structure
that has to survive that is a much larger thing to get right than a linear rebuild is to pay
for. `new Topology(mesh)` gives you:

- `edges`, each with the ≤2 faces that use it (`isBorderEdge`, `otherFace`)
- `vertexFaces`, `vertexEdges` — what touches a given vertex
- `faceEdges` — a face's edges, in face-winding order
- `regionBoundary(faces)` — the outer edges of a set of faces (odd-use-count trick: an edge
  used once by the region is on its border; used twice, both faces are inside it)
- `orderedFaceFan(vertex)` — the faces around a vertex, walked in cyclic order by crossing one
  shared edge at a time. This is what a correct bevel needs: the corner polygon it builds is
  only right if its vertices come round the fan in order, not in whatever order they happened
  to be inserted. (The existing `bevel.ts` modifier bevels *edges*, not corners — a
  vertex-corner bevel is edit-mode work, listed under Not started below.)

**A correctness note for whoever picks this up:** `otherFace(edgeIndex, faceIndex)` has a real
precondition — `faceIndex` must actually be one of the (at most two) faces already on that
edge — documented on the method. The first draft of `orderedFaceFan` violated it by calling
`otherFace` against every vertex-incident edge instead of only the current face's own edges,
which silently returned the *wrong* face on some geometry (traced by hand against a
square-pyramid apex — a closed 4-face fan — where it picked a non-adjacent face across an
edge the current face doesn't own). The current implementation walks by tracking which edge of
the *current face* was just crossed and picking that face's other vertex-touching edge, which
respects the precondition by construction. If you touch this function, re-derive that trace
before trusting a change to it — it is exactly the kind of bug that looks right on a cube (every
face fan there is 3 faces, too small to expose the ordering error) and wrong on anything with a
longer fan, which is the same class of mistake the winding-test note in `ARCHITECTURE.md` §3b
describes: correct on the easy shapes, wrong on the one that actually exercises the invariant.

## Selection (`engine/mesh/editing/selection.ts`)

`ElementSelection` carries vertex, edge, *and* face selections simultaneously rather than one
set per mode, because switching edit-mode elements has to **convert**, not clear — picking
three faces, switching to edge mode, and landing on an empty selection is the fastest way to
make a modelling tool feel broken.

`normaliseSelection` is Blender's rule set, asymmetric on purpose:

- Selecting faces implies every vertex and edge they use (a union, going "down").
- Selecting edges implies their vertices, and any face whose edges are *all* selected.
- Selecting vertices implies any edge whose both ends are selected, and any face whose
  vertices are all selected.

Going up the hierarchy needs full coverage, not partial — otherwise selecting one vertex of a
cube would select the three faces that touch it, and extruding would do something nobody asked
for.

## Status

**Shipping today:** everything in the Primitives, Modifiers and Topology sections above.

**Written, not yet wired in or tested — do not build further on this without adding tests
first:**
- `engine/mesh/editing/selection.ts` — the `ElementSelection` type and `normaliseSelection`.
  Typechecks; has no test coverage yet and no caller. This is groundwork for edit mode
  (`src/engine/mesh/editing/` is where extrude/inset/loop-cut land next), checked in so it
  isn't lost, not because it's verified.

**Not started:**
- Edit-mode operations: extrude (region + individual faces), inset, vertex/corner bevel, loop
  cut, merge by distance as an *operation* (the Weld modifier is stack-level, not selection-
  scoped), bridge, flip normals, shade smooth/flat *per selection* (the modifier version is
  whole-mesh only). Pure functions over `MeshData` + `Topology`, same shape as the existing
  modifiers — see `engine/mesh/modifiers/mirror.ts` for the pattern to follow (take a mesh,
  return a new one, never mutate the input).
- Edit-mode UI: vertex/edge/face selection rendering, box select, per-element gizmo transforms,
  the operations panel. Lives in `src/editor/`, not `src/engine/` — see the boundary rule in
  `ARCHITECTURE.md` §2.
- Boolean (CSG). Deliberately deferred — needs robust CSG, which is its own project.
- Splines with lathe/sweep generators.

See [`CHANGELOG.md`](../CHANGELOG.md) for what's planned next and why, and for the version this
status block corresponds to — this file describes the *current* state and is expected to drift;
the changelog is the place version-to-version deltas get written down.
